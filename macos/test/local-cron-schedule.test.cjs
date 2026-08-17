const assert = require("node:assert/strict");
const test = require("node:test");

const { parseLocalCron, nextLocalCronAt } = require("../src/desktop/local-cron-schedule.cjs");

function assertInvalid(operation, submittedExpression = "") {
  assert.throws(operation, error =>
    error?.code === "OPENBOT_LOCAL_AUTOMATION_INVALID"
    && error.message === "OpenBot local Routine schedule is invalid."
    && (submittedExpression === "" || !error.message.includes(submittedExpression)));
}

test("local cron supports aliases intervals and bounded five-field syntax", () => {
  assert.equal(parseLocalCron("@daily").normalized, "0 0 * * *");
  assert.equal(nextLocalCronAt(parseLocalCron("@every 15m"), Date.UTC(2026, 7, 17, 12)),
    Date.UTC(2026, 7, 17, 12, 15));
  assert.equal(nextLocalCronAt(parseLocalCron("*/10 9-10 * * 1-5"),
    Date.UTC(2026, 7, 17, 8, 59)), Date.UTC(2026, 7, 17, 9, 0));
});

test("local cron normalizes every alias before persistent schedule storage", () => {
  assert.equal(parseLocalCron("@hourly").normalized, "0 * * * *");
  assert.equal(parseLocalCron("@weekly").normalized, "0 0 * * 0");
  assert.equal(parseLocalCron("@monthly").normalized, "0 0 1 * *");
  assert.equal(parseLocalCron("@yearly").normalized, "0 0 1 1 *");
  assert.equal(parseLocalCron("@annually").normalized, "0 0 1 1 *");
  assert.equal(parseLocalCron("@midnight").normalized, "0 0 * * *");
});

test("local cron sorts list and range fields before calculating their first occurrence", () => {
  const schedule = parseLocalCron("5,1-2,2 0 * * *");
  assert.equal(schedule.normalized, "1,2,5 0 * * *");
  assert.equal(nextLocalCronAt(schedule, Date.UTC(2026, 7, 17)),
    Date.UTC(2026, 7, 17, 0, 1));
});

test("local cron retains the first legal value when a positive step exceeds its field width", () => {
  assert.equal(nextLocalCronAt(parseLocalCron("*/61 0 * * *"),
    Date.UTC(2026, 7, 16, 23, 59)), Date.UTC(2026, 7, 17));
});

test("local cron rejects invalid expressions without reflecting the submitted expression", () => {
  assertInvalid(() => parseLocalCron("61 * * * *"), "61");
  assertInvalid(() => parseLocalCron("0 0 32 * *"), "32");
  assertInvalid(() => parseLocalCron("0 0 * * * trailing"), "trailing");
  assertInvalid(() => parseLocalCron("@every 0m"), "0m");
  assertInvalid(() => parseLocalCron("TZ=Not/AZone 0 0 * * *"), "Not/AZone");
  assertInvalid(() => parseLocalCron(new String("0 0 * * *")), "");
});

test("local cron rejects forged sparse accessor and proxy schedules before execution", () => {
  const sparse = new Array(1);
  assertInvalid(() => nextLocalCronAt(sparse, Date.UTC(2026, 7, 17)), "");

  let accessorReads = 0;
  const accessorSchedule = Object.create(null);
  Object.defineProperty(accessorSchedule, "kind", {
    get() {
      accessorReads += 1;
      throw new Error("unexpected accessor read");
    },
  });
  assertInvalid(() => nextLocalCronAt(accessorSchedule, Date.UTC(2026, 7, 17)), "");
  assert.equal(accessorReads, 0);

  const proxySchedule = new Proxy(Object.create(null), {
    get() {
      throw new Error("unexpected proxy read");
    },
    getOwnPropertyDescriptor() {
      throw new Error("unexpected proxy descriptor");
    },
  });
  assertInvalid(() => nextLocalCronAt(proxySchedule, Date.UTC(2026, 7, 17)), "");
});

test("local cron rejects non-integer epochs and interval overflow instead of producing invalid dates", () => {
  const interval = parseLocalCron("@every 1ms");
  assertInvalid(() => nextLocalCronAt(interval, NaN), "");
  assertInvalid(() => nextLocalCronAt(interval, Infinity), "");
  assertInvalid(() => nextLocalCronAt(interval, 1.5), "");
  assertInvalid(() => nextLocalCronAt(interval, Number.MAX_SAFE_INTEGER), "");
});

test("local cron bounds an impossible calendar search at five years", () => {
  const impossible = parseLocalCron("0 0 31 2 *");
  assertInvalid(() => nextLocalCronAt(impossible, Date.UTC(2026, 7, 17)), "");
});

test("local cron uses day-of-month or weekday when both fields are restricted", () => {
  assert.equal(nextLocalCronAt(parseLocalCron("TZ=UTC 0 0 13 * 1"),
    Date.parse("2026-08-17T00:01:00.000Z")), Date.parse("2026-08-24T00:00:00.000Z"));
});

test("local cron skips Indianapolis spring-forward wall times", () => {
  assert.equal(nextLocalCronAt(parseLocalCron("TZ=America/Indiana/Indianapolis 30 2 * * *"),
    Date.parse("2026-03-08T06:59:00.000Z")), Date.parse("2026-03-09T06:30:00.000Z"));
});

test("local cron includes the second Indianapolis fall-back wall time", () => {
  assert.equal(nextLocalCronAt(parseLocalCron("TZ=America/Indiana/Indianapolis 30 1 * * *"),
    Date.parse("2026-11-01T05:30:00.000Z")), Date.parse("2026-11-01T06:30:00.000Z"));
});

test("local cron advances through month and year ends in the selected timezone", () => {
  assert.equal(nextLocalCronAt(parseLocalCron("TZ=UTC 0 0 31 * *"),
    Date.parse("2026-04-30T23:59:00.000Z")), Date.parse("2026-05-31T00:00:00.000Z"));
  assert.equal(nextLocalCronAt(parseLocalCron("TZ=UTC 0 0 1 1 *"),
    Date.parse("2026-12-31T23:59:00.000Z")), Date.parse("2027-01-01T00:00:00.000Z"));
});
