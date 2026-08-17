const MINUTE_MS = 60_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
const FIVE_YEARS_MS = 5 * 366 * 24 * 60 * MINUTE_MS;
const SCHEDULES = new WeakSet();
const FORMATTERS = new Map();
const WEEKDAYS = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const ALIASES = Object.freeze({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
});

class LocalCronScheduleError extends Error {
  constructor() {
    super("OpenBot local Routine schedule is invalid.");
    this.name = "LocalCronScheduleError";
    this.code = "OPENBOT_LOCAL_AUTOMATION_INVALID";
  }
}

function invalidSchedule() {
  return new LocalCronScheduleError();
}

function parseLocalCron(expression) {
  try {
    const normalized = normalizeExpression(expression);
    const schedule = compileSchedule(normalized);
    SCHEDULES.add(schedule);
    return Object.freeze(schedule);
  } catch (error) {
    if (error instanceof LocalCronScheduleError) throw error;
    throw invalidSchedule();
  }
}

function nextLocalCronAt(schedule, afterEpochMs) {
  try {
    validateCompiledSchedule(schedule);
    validateEpoch(afterEpochMs);
    return schedule.kind === "interval"
      ? checkedIntervalNext(schedule, afterEpochMs)
      : boundedCronNext(schedule, afterEpochMs);
  } catch (error) {
    if (error instanceof LocalCronScheduleError) throw error;
    throw invalidSchedule();
  }
}

function normalizeExpression(expression) {
  if (typeof expression !== "string" || expression.length === 0 || expression.length > 256) {
    throw invalidSchedule();
  }

  let source = expression.trim();
  if (!source) throw invalidSchedule();

  let timezone = "UTC";
  let timezonePrefix = "";
  const timezoneMatch = /^(TZ|CRON_TZ)=([^\s]+)\s+(.+)$/u.exec(source);
  if (timezoneMatch) {
    timezonePrefix = timezoneMatch[1];
    timezone = timezoneMatch[2];
    source = timezoneMatch[3].trim();
    getFormatter(timezone);
  } else if (/^(?:TZ|CRON_TZ)=/u.test(source)) {
    throw invalidSchedule();
  }

  const alias = ALIASES[source.toLowerCase()];
  if (alias) source = alias;

  const interval = /^@every\s+(\d+)(s|m|h|d)$/iu.exec(source);
  if (interval) {
    const amount = Number(interval[1]);
    const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[interval[2].toLowerCase()];
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)) {
      throw invalidSchedule();
    }
    return Object.freeze({ kind: "interval", normalized: `@every ${amount}${interval[2].toLowerCase()}`, intervalMs: amount * multiplier });
  }

  const fields = source.split(/\s+/u);
  if (fields.length !== 5) throw invalidSchedule();
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const parsed = [
    parseField(minute, 0, 59, false),
    parseField(hour, 0, 23, false),
    parseField(dayOfMonth, 1, 31, false),
    parseField(month, 1, 12, false),
    parseField(dayOfWeek, 0, 7, true),
  ];
  const normalizedFields = parsed.map(field => field.normalized).join(" ");
  return Object.freeze({
    kind: "cron",
    normalized: `${timezonePrefix ? `${timezonePrefix}=${timezone} ` : ""}${normalizedFields}`,
    timezone,
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
  });
}

function compileSchedule(normalized) {
  return normalized;
}

function parseField(source, minimum, maximum, normalizeSunday) {
  if (!source || source.length > 128) throw invalidSchedule();
  const values = new Set();
  const pieces = source.split(",");
  if (!pieces.length || pieces.some(piece => !piece)) throw invalidSchedule();

  for (const piece of pieces) {
    const stepParts = piece.split("/");
    if (stepParts.length > 2 || !stepParts[0] || (stepParts.length === 2 && !stepParts[1])) {
      throw invalidSchedule();
    }
    const step = stepParts.length === 2 ? parsePositiveInteger(stepParts[1]) : 1;
    const [start, end] = parseRange(stepParts[0], minimum, maximum);
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }

  const sorted = Object.freeze([...values].sort((left, right) => left - right));
  if (!sorted.length) throw invalidSchedule();
  const normalizedMaximum = normalizeSunday ? 6 : maximum;
  const hasEveryValue = sorted.length === normalizedMaximum - minimum + 1;
  const wildcard = source.startsWith("*");
  return Object.freeze({
    values: sorted,
    wildcard,
    normalized: normalizeFieldExpression(source, sorted, wildcard, hasEveryValue),
  });
}

function normalizeFieldExpression(source, values, wildcard, hasEveryValue) {
  if (wildcard) {
    if (hasEveryValue) return "*";
    const starStep = /^\*\/(\d+)$/u.exec(source);
    return starStep ? `*/${Number(starStep[1])}` : source;
  }

  const ranges = [];
  let start = values[0];
  let previous = start;
  for (const value of values.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(",");
}

function parseRange(source, minimum, maximum) {
  if (source === "*") return [minimum, maximum];
  const range = /^(\d+)(?:-(\d+))?$/u.exec(source);
  if (!range) throw invalidSchedule();
  const start = parseBoundedInteger(range[1], minimum, maximum);
  const end = range[2] === undefined ? start : parseBoundedInteger(range[2], minimum, maximum);
  if (start > end) throw invalidSchedule();
  return [start, end];
}

function parsePositiveInteger(source) {
  if (!/^\d+$/u.test(source)) throw invalidSchedule();
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < 1) throw invalidSchedule();
  return value;
}

function parseBoundedInteger(source, minimum, maximum) {
  if (!/^\d+$/u.test(source)) throw invalidSchedule();
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidSchedule();
  return value;
}

function validateCompiledSchedule(schedule) {
  if (!SCHEDULES.has(schedule)) throw invalidSchedule();
}

function validateEpoch(epochMs) {
  if (!Number.isSafeInteger(epochMs) || Math.abs(epochMs) > MAX_DATE_EPOCH_MS) throw invalidSchedule();
}

function checkedIntervalNext(schedule, afterEpochMs) {
  const quotient = Math.floor(afterEpochMs / schedule.intervalMs);
  if (!Number.isSafeInteger(quotient) || quotient >= Number.MAX_SAFE_INTEGER) throw invalidSchedule();
  const next = (quotient + 1) * schedule.intervalMs;
  if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_DATE_EPOCH_MS || next <= afterEpochMs) {
    throw invalidSchedule();
  }
  return next;
}

function boundedCronNext(schedule, afterEpochMs) {
  const firstCandidate = (Math.floor(afterEpochMs / MINUTE_MS) + 1) * MINUTE_MS;
  const ceiling = firstCandidate + FIVE_YEARS_MS;
  if (!Number.isSafeInteger(firstCandidate) || !Number.isSafeInteger(ceiling) || ceiling > MAX_DATE_EPOCH_MS) {
    throw invalidSchedule();
  }

  const formatter = getFormatter(schedule.timezone);
  for (let candidate = firstCandidate; candidate <= ceiling; candidate += MINUTE_MS) {
    const parts = readWallClockParts(formatter, candidate);
    if (matchesCron(schedule, parts)) return candidate;
  }
  throw invalidSchedule();
}

function getFormatter(timezone) {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      calendar: "iso8601",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
    });
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

function readWallClockParts(formatter, epochMs) {
  const parts = formatter.formatToParts(new Date(epochMs));
  const values = Object.create(null);
  for (const part of parts) values[part.type] = part.value;
  const weekday = WEEKDAYS[values.weekday];
  const minute = Number(values.minute);
  const hour = Number(values.hour);
  const day = Number(values.day);
  const month = Number(values.month);
  if (!Number.isInteger(weekday) || !Number.isInteger(minute) || !Number.isInteger(hour)
    || !Number.isInteger(day) || !Number.isInteger(month)) throw invalidSchedule();
  return { weekday, minute, hour, day, month };
}

function matchesCron(schedule, parts) {
  if (!schedule.minute.values.includes(parts.minute) || !schedule.hour.values.includes(parts.hour)
    || !schedule.month.values.includes(parts.month)) return false;

  const dayOfMonthMatches = schedule.dayOfMonth.values.includes(parts.day);
  const dayOfWeekMatches = schedule.dayOfWeek.values.includes(parts.weekday);
  if (schedule.dayOfMonth.wildcard && schedule.dayOfWeek.wildcard) return true;
  if (schedule.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (schedule.dayOfWeek.wildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

module.exports = { LocalCronScheduleError, nextLocalCronAt, parseLocalCron };
