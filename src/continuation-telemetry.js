// Durable continuation-attempt telemetry (AI-1959, phase 3 of AI-1902).
//
// One JSONL event per continuation-selected sibling upstream send — a force
// hop (AI-1903) or a taken recommend offer — written (open/write/fsync/close)
// BEFORE the send, so a destination that dies mid-stream still left its
// trace. The console counts and alerts on these across restarts.
//
// Conservative by construction:
// - one open(O_WRONLY|O_APPEND|O_CREAT, 0644) + chmod(0o644) + a single
//   write + fsync + close per event: no persistent fd, no batching, no
//   caching. The chmod rides every open so a restrictive umask can never
//   leave the log unreadable to the console container (owner amendment,
//   2026-11-13); a chmod failure is part of the per-event open/prepare step
//   and classifies as 'open_failed'.
// - a failed write NEVER blocks or fails the request: open/write/fsync
//   errors flip the status to { ok: false, lastError, lastErrorAt } and
//   record() resolves normally. lastError/lastErrorAt are sticky — they are
//   the LAST error, not the current state: a later success sets ok back to
//   true and increments events without clearing them.
// - off unless config.continuationAttemptsLog names a path: record() is then
//   a no-op and status() stays { ok: true, lastError: null, lastErrorAt:
//   null, events: 0 }.
//
// O_APPEND plus a single write per event keeps concurrent record() calls
// line-atomic. A rotation (the file renamed between events) recreates the
// path via O_CREAT on the next event. Node 20+ built-ins only.

import fs from 'node:fs';
import { dirname } from 'node:path';

/**
 * The telemetry status surfaced as `continuationTelemetry` on
 * /teamclaude/status (admin only). `lastError`/`lastErrorAt` are the LAST
 * failure, sticky across later successes.
 * @typedef {{ ok: boolean, lastError: 'open_failed'|'write_failed'|'fsync_failed'|null, lastErrorAt: string|null, events: number }} ContinuationTelemetryStatus
 */

/**
 * The `fs.promises.open` shape, injectable so the write/fsync failure modes
 * are testable without module mocking (same DI style as AccountManager's
 * refreshFn).
 * @typedef {(path: fs.PathLike, flags: string | number, mode?: fs.Mode | undefined) => Promise<fs.promises.FileHandle>} OpenFn
 */

/**
 * Create the continuation-attempt event writer.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.path]  the JSONL log path; null/absent = the
 *   feature is fully off.
 * @param {OpenFn} [opts.open]
 * @param {boolean} [opts.disabled]  seeded failure state for a path whose
 *   directory could not be created at startup: record() stays a no-op and the
 *   status reads { ok: false, lastError: 'open_failed' } from the start.
 * @returns {{ record: (event: Record<string, unknown>) => Promise<void>, status: () => ContinuationTelemetryStatus }}
 */
export function createContinuationTelemetry({ path = null, open = fs.promises.open, disabled = false } = {}) {
  const target = typeof path === 'string' && path.length > 0 ? path : null;
  const enabled = target != null && !disabled;
  /** @type {ContinuationTelemetryStatus} */
  const state = { ok: true, lastError: null, lastErrorAt: null, events: 0 };
  if (target != null && disabled) {
    state.ok = false;
    state.lastError = 'open_failed';
    state.lastErrorAt = new Date().toISOString();
  }
  /** @param {'open_failed'|'write_failed'|'fsync_failed'} kind */
  const fail = (kind) => {
    state.ok = false;
    state.lastError = kind;
    state.lastErrorAt = new Date().toISOString();
  };
  return {
    /**
     * Append one event line, durability (open/chmod/write/fsync/close)
     * completed before resolving. Never throws and never rejects: a failure
     * flips the status and the request that owns this event is served
     * normally.
     * @param {Record<string, unknown>} event
     */
    async record(event) {
      if (!enabled || target == null) return;
      // Whether the path already exists, sampled before the open: a file this
      // event CREATEs (first event, or the first after a rotation) is not
      // crash-durable from the file fsync alone — the directory entry needs
      // its own sync, done best-effort after the write below.
      const preExisting = fs.existsSync(target);
      /** @type {fs.promises.FileHandle|null} */
      let handle = null;
      try {
        handle = await open(target, 'a', 0o644);
        // Part of the open/prepare step, so its failure is open_failed.
        await handle.chmod(0o644);
      } catch {
        fail('open_failed');
        if (handle) await handle.close().catch(() => {});
        return;
      }
      const line = `${JSON.stringify(event)}\n`;
      /** @type {number} */
      let written;
      try {
        ({ bytesWritten: written } = await handle.write(line));
      } catch {
        fail('write_failed');
        await handle.close().catch(() => {});
        return;
      }
      // One single write per event is the contract, so a short write is never
      // retried — but fsyncing a truncated, unparseable line must not count
      // as success either. The partial bytes are rolled back first: left in
      // place they carry no newline, so the NEXT event's line would append
      // onto the fragment and one short write would silently cost two events.
      if (written !== Buffer.byteLength(line)) {
        // Best-effort, and guarded: a handle without stat/truncate (or a
        // rollback failure) must not break the never-rejects contract.
        if (written > 0) {
          try { await handle.truncate((await handle.stat()).size - written); } catch { /* the fragment stays; the status still names the failure */ }
        }
        fail('write_failed');
        await handle.close().catch(() => {});
        return;
      }
      try {
        await handle.sync();
        // New directory entry: sync the parent too, or a power loss can still
        // lose the just-created, just-fsynced file. Best-effort — the line
        // itself is already durable, and no status class names this failure.
        if (!preExisting) {
          const dir = await fs.promises.open(dirname(target)).catch(() => null);
          if (dir) { await dir.sync().catch(() => {}); await dir.close().catch(() => {}); }
        }
      } catch {
        fail('fsync_failed');
        await handle.close().catch(() => {});
        return;
      }
      // Close is best-effort: the line is already written and fsynced, and no
      // status class names a close failure.
      await handle.close().catch(() => {});
      state.ok = true;
      state.events += 1;
    },
    status: () => ({ ...state }),
  };
}
