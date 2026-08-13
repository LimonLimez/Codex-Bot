"use strict";

const DEFAULT_CONTROL_TTL_MS = 15_000;
const MAX_CONTROL_TTL_MS = 30_000;

class BrowserControlLeaseCoordinator {
  #leases = new Map();
  #now;
  #ttlMs;
  #onAcquire;

  constructor({ now = Date.now, ttlMs = DEFAULT_CONTROL_TTL_MS, onAcquire = () => {} } = {}) {
    if (typeof now !== "function" || typeof onAcquire !== "function") throw new TypeError("Control lease callbacks must be functions.");
    const requested = Number(ttlMs);
    if (!Number.isFinite(requested) || requested <= 0) throw new RangeError("Control lease expiry must be positive.");
    this.#now = now;
    this.#ttlMs = Math.min(Math.floor(requested), MAX_CONTROL_TTL_MS);
    this.#onAcquire = onAcquire;
  }

  acquire(seatId, ownerId) {
    const seat = this.#seat(seatId);
    const owner = this.#owner(ownerId);
    this.#pruneOne(seat);
    const existing = this.#leases.get(seat);
    if (existing && existing.ownerId !== owner) throw new Error("Another trusted view already controls this employee.");
    const lease = Object.freeze({ seatId: seat, ownerId: owner, expiresAt: this.#now() + this.#ttlMs });
    this.#leases.set(seat, lease);
    if (!existing) this.#onAcquire(seat);
    return lease;
  }

  heartbeat(seatId, ownerId) {
    const seat = this.#seat(seatId);
    const owner = this.#owner(ownerId);
    this.#pruneOne(seat);
    const existing = this.#leases.get(seat);
    if (!existing || existing.ownerId !== owner) throw new Error("This trusted view does not own the browser control lease.");
    const lease = Object.freeze({ seatId: seat, ownerId: owner, expiresAt: this.#now() + this.#ttlMs });
    this.#leases.set(seat, lease);
    return lease;
  }

  release(seatId, ownerId) {
    const seat = this.#seat(seatId);
    const owner = this.#owner(ownerId);
    this.#pruneOne(seat);
    const existing = this.#leases.get(seat);
    if (!existing) return false;
    if (existing.ownerId !== owner) throw new Error("This trusted view does not own the browser control lease.");
    return this.#leases.delete(seat);
  }

  clearSeat(seatId) {
    return this.#leases.delete(String(seatId || ""));
  }

  status(seatId) {
    const seat = String(seatId || "");
    this.#pruneOne(seat);
    const lease = this.#leases.get(seat);
    return lease ? Object.freeze({ controlled: true, expiresAt: lease.expiresAt }) : Object.freeze({ controlled: false, expiresAt: null });
  }

  assertAgentAllowed(seatId) {
    if (this.status(seatId).controlled) throw new Error("The user currently has direct control of this employee's browser.");
    return true;
  }

  authorizeUser(seatId, ownerId) {
    const seat = this.#seat(seatId);
    const owner = this.#owner(ownerId);
    this.#pruneOne(seat);
    const lease = this.#leases.get(seat);
    if (!lease || lease.ownerId !== owner) throw new Error("Take control before sending browser input.");
    return true;
  }

  #seat(value) {
    const seat = String(value || "").trim();
    if (!seat || seat.length > 200) throw new TypeError("A valid employee seat key is required.");
    return seat;
  }

  #owner(value) {
    const owner = String(value || "").trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(owner)) throw new TypeError("A valid trusted-view control identifier is required.");
    return owner;
  }

  #pruneOne(seat) {
    const lease = this.#leases.get(seat);
    if (lease && lease.expiresAt <= this.#now()) this.#leases.delete(seat);
  }
}

module.exports = {
  BrowserControlLeaseCoordinator,
  DEFAULT_CONTROL_TTL_MS,
  MAX_CONTROL_TTL_MS,
};
