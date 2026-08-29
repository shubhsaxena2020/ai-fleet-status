'use strict';

// Session lifecycle reconciliation across polls.
//
// buildFleet() (lib/sessions.js) is stateless per poll: it produces a fresh set of
// sessions keyed by stable id (tool + rootPid + creationTime). This module keeps a
// BOUNDED in-memory map of previously-seen session ids so the extension can report
// START / CONTINUE / ENDED transitions and age, without retaining unbounded history.
//
// A stable id protects against PID reuse: a recycled PID with a different
// CreationDate yields a different id, so it is correctly treated as a NEW session
// rather than a continuation of the old one. On Unix (no creation time from `ps`)
// the id is less stable but still durable within a polling window in practice.

const MAX_HISTORY = 50; // cap retained ended-session records

class SessionLifecycle {
  constructor(now) {
    this._now = typeof now === 'function' ? now : () => Date.now();
    /** @type {Map<string, object>} id -> { firstSeen, lastSeen, toolId, rootPid, mode } */
    this.seen = new Map();
    /** ids that ended this reconciliation (for optional notifications) */
    this.justEnded = [];
    this.justStarted = [];
  }

  // Reconcile a freshly built fleet's sessions against history. Returns the same
  // fleet with each session annotated: firstSeen, lastSeen, isNew, ageMs.
  reconcile(fleet) {
    this.justEnded = [];
    this.justStarted = [];
    const now = this._now();
    const currentIds = new Set();

    for (const session of fleet.sessions) {
      currentIds.add(session.id);
      const prev = this.seen.get(session.id);
      if (prev) {
        prev.lastSeen = now;
        session.firstSeen = prev.firstSeen;
        session.lastSeen = now;
        session.isNew = false;
      } else {
        this.seen.set(session.id, {
          firstSeen: now,
          lastSeen: now,
          toolId: session.toolId,
          rootPid: session.rootPid,
          mode: session.mode
        });
        session.firstSeen = now;
        session.lastSeen = now;
        session.isNew = true;
        this.justStarted.push(session);
      }
    }

    // Anything in `seen` but not in currentIds has ended.
    for (const [id, rec] of this.seen) {
      if (!currentIds.has(id)) {
        this.justEnded.push({ id, ...rec });
        this.seen.delete(id);
      }
    }

    // Bound retained history (ended records were already removed above; cap the
    // live map defensively in case of pathological growth).
    if (this.seen.size > MAX_HISTORY) {
      const overflow = this.seen.size - MAX_HISTORY;
      let i = 0;
      for (const key of this.seen.keys()) {
        if (i++ >= overflow) {
          break;
        }
        this.seen.delete(key);
      }
    }

    return fleet;
  }

  // True if the given stable id was present in the previous poll.
  wasActive(id) {
    return this.seen.has(id);
  }
}

module.exports = { SessionLifecycle, MAX_HISTORY };
