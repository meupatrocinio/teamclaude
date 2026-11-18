// handoffBeforeSwitch (IPM fork): recommend `/ipm:handoff` while the account a
// seat-bound conversation is pinned to can still serve it, not after.
//
// On a multi-account seat under the `recommend` policy, a conversation whose
// pinned account runs out is offered a cold-cache continuation on a sibling
// (client-routes.js seatAnswer). By then a handoff is too late: running it is a
// prompt in that same conversation, so it is the prompt that confirms the
// continuation it was meant to avoid. A handoff only helps while the pinned
// account still serves, with the conversation in its prompt cache.
//
// So when a large seat-bound conversation's pinned account is past a handoff
// threshold and another account on the seat could take over, the proxy answers
// ONE request of that conversation itself, with an actionable 429 saying so.
// Nothing is sent upstream. The ask is recorded before the answer is written,
// so the next prompt of that conversation (the handoff, or the user carrying
// on) is forwarded to the warm account as usual.
//
// Upstream's compactBeforeSwitch (compact-before-switch.js) does the same job
// for fleet rotation and stays off for seat-bound requests: a seat ignores the
// switch threshold and runs until upstream rejects, so the thresholds here are
// fixed utilizations rather than `switchThreshold - margin`: one for the
// 5-hour window, lower because under parallel sessions it can burn from first
// serve to spent in minutes, and one for every weekly window. The record of
// who was asked is a CompactAsks of its own (AccountManager.handoffAsks).
//
// The same thresholds drive the soft drain (softDrainIndex): a conversation
// with no pin on the seat starts on the first servable account past neither,
// so the handoff's new conversation, and every new task, lands on a fresh
// account while pinned conversations keep their warm one to the limit.
//
// This module holds the parts that need no server: the setting, the readings,
// the decision, the soft-drain pick and the answer. The server supplies the facts (server.js
// handoffAskFor). Every doubt resolves to forwarding the request.

import { safeLine } from './safe-text.js';
import { seatVerdict } from './client-routes.js';

export const DEFAULT_FIVE_HOUR_UTILIZATION = 0.75;
export const DEFAULT_WEEKLY_UTILIZATION = 0.9;
export const DEFAULT_MIN_BODY_BYTES = 200_000;
export const DEFAULT_COOLDOWN_SECONDS = 1800;

/**
 * @typedef {Object} HandoffSettings
 * @property {number} fiveHourUtilization  the 5-hour reading at or above which an account is past (0-1)
 * @property {number} weeklyUtilization    the weekly reading (shared, family, scoped) at or above which it is past (0-1)
 * @property {number} minBodyBytes  the smallest request body that is asked
 * @property {number} cooldownMs    how long one conversation is left alone after being asked
 */

/**
 * @param {unknown} value
 * @param {(n: number) => boolean} valid
 * @param {number} fallback
 * @returns {number}
 */
function field(value, valid, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && valid(value) ? value : fallback;
}

/**
 * The `handoffBeforeSwitch` setting as the decision reads it, or null when it
 * is off.
 *
 * On by default: the production renderer rebuilds the pool config and would
 * never emit a new pool-level key. Only `false` turns it off. An object tunes
 * it, each field that is not a usable number taking its default:
 * `fiveHourUtilization` and `weeklyUtilization` above 0 and below 1,
 * `minBodyBytes` and `cooldownSeconds` above 0. Any other value (absent, `true`, a string) is on with the defaults.
 *
 * @param {unknown} raw
 * @returns {HandoffSettings|null}
 */
export function resolveHandoffBeforeSwitch(raw) {
  if (raw === false) return null;
  const o = /** @type {Record<string, unknown>} */ (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  return {
    fiveHourUtilization: field(o.fiveHourUtilization, n => n > 0 && n < 1, DEFAULT_FIVE_HOUR_UTILIZATION),
    weeklyUtilization: field(o.weeklyUtilization, n => n > 0 && n < 1, DEFAULT_WEEKLY_UTILIZATION),
    minBodyBytes: field(o.minBodyBytes, n => n > 0, DEFAULT_MIN_BODY_BYTES),
    cooldownMs: field(o.cooldownSeconds, n => n > 0, DEFAULT_COOLDOWN_SECONDS) * 1000,
  };
}

/**
 * The setting as status reports it, read from the live config, with how many
 * requests were answered this way since start.
 *
 * @param {unknown} raw  `config.handoffBeforeSwitch`
 * @param {{ asked?: number }|null|undefined} asks
 * @returns {{ enabled: boolean, fiveHourUtilization?: number, weeklyUtilization?: number, minBodyBytes?: number, cooldownSeconds?: number, asked: number }}
 */
export function handoffBeforeSwitchStatus(raw, asks) {
  const settings = resolveHandoffBeforeSwitch(raw);
  const asked = asks?.asked ?? 0;
  if (!settings) return { enabled: false, asked };
  return { enabled: true, fiveHourUtilization: settings.fiveHourUtilization, weeklyUtilization: settings.weeklyUtilization, minBodyBytes: settings.minBodyBytes, cooldownSeconds: settings.cooldownMs / 1000, asked };
}

/**
 * @typedef {Object} QuotaWindow
 * @property {string} bucket             unified5h, unified7d, the model's family bucket, or scopedWeekly
 * @property {number|null} utilization   its reading (0-1), null when unknown
 * @property {number|null} resetsAt      when it resets (ms), null when unknown
 */

/**
 * The 5-hour and weekly readings of `account` that bear on `model`, each
 * bucket as its own window with its own reset, so the window the decision
 * picks names the percentage and the reset of the same bucket: the shared
 * 5-hour, the shared weekly, the model's family weekly bucket when it has one,
 * and the scoped weekly upstream reported for the family when there is one.
 *
 * @param {any} accountManager
 * @param {Record<string, any>} account
 * @param {string|null} model
 * @returns {QuotaWindow[]}
 */
export function handoffWindows(accountManager, account, model) {
  const q = account.quota || {};
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  /** @type {QuotaWindow[]} */
  const windows = [
    { bucket: 'unified5h', utilization: num(q.unified5h), resetsAt: num(q.unified5hReset) },
    { bucket: 'unified7d', utilization: num(q.unified7d), resetsAt: num(q.unified7dReset) },
  ];
  const family = accountManager._weeklyBucketFor(model);
  if (family !== 'unified7d') windows.push({ bucket: family, utilization: num(q[family]), resetsAt: num(q[`${family}Reset`]) });
  const scoped = accountManager._scopedWeekly?.(account, model);
  if (scoped) windows.push({ bucket: 'scopedWeekly', utilization: num(scoped.utilization), resetsAt: num(scoped.resetAt) });
  return windows;
}

/**
 * Whether the request's last message is a prompt the person just typed: a
 * `user` message whose content is a string, or blocks none of which is a
 * `tool_result`. A tool turn (mid-task, or a subagent's) has nobody reading a
 * 429 between steps. Anything that does not parse is not a typed prompt.
 *
 * @param {Buffer|string} body
 * @returns {boolean}
 */
export function lastMessageIsTypedPrompt(body) {
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(String(body)); } catch { return false; }
  const messages = parsed?.messages;
  if (!Array.isArray(messages) || !messages.length) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  if (typeof last.content === 'string') return true;
  return Array.isArray(last.content) && !last.content.some((/** @type {any} */ b) => b?.type === 'tool_result');
}

/**
 * The window furthest past its own handoff threshold, or null when none is:
 * the 5-hour window against `fiveHourUtilization`, every weekly one against
 * `weeklyUtilization`. An unknown reading, or one whose window already reset,
 * says nothing about now and is skipped.
 *
 * @param {QuotaWindow[]|null|undefined} windows
 * @param {HandoffSettings} settings
 * @param {number} now
 * @returns {QuotaWindow|null}
 */
export function pastHandoffThreshold(windows, settings, now) {
  /** @type {QuotaWindow|null} */
  let best = null;
  let bestOver = -Infinity;
  for (const w of windows || []) {
    const u = w.utilization;
    if (typeof u !== 'number' || !Number.isFinite(u)) continue;
    if (w.resetsAt != null && w.resetsAt <= now) continue;
    const over = u - (w.bucket === 'unified5h' ? settings.fiveHourUtilization : settings.weeklyUtilization);
    if (over >= 0 && over > bestOver) { best = w; bestOver = over; }
  }
  return best;
}

/**
 * The soft drain: the account a conversation with no pin on a seat starts on,
 * the first of `candidates` (queue order) that can serve and is past neither
 * handoff threshold, or null when none qualifies (the caller then keeps plain
 * queue order). Reads only.
 *
 * @param {any} accountManager
 * @param {number[]} candidates
 * @param {string|null} model
 * @param {string|null} advisorModel
 * @param {HandoffSettings} settings
 * @param {number} [now]
 * @returns {number|null}
 */
export function softDrainIndex(accountManager, candidates, model, advisorModel, settings, now = Date.now()) {
  for (const i of candidates) {
    const account = accountManager.accounts[i];
    if (!account || seatVerdict(accountManager, account, model, advisorModel, now)) continue;
    if (!pastHandoffThreshold(handoffWindows(accountManager, account, model), settings, now)) return i;
  }
  return null;
}

/**
 * @typedef {Object} HandoffDecision
 * @property {boolean} ask
 * @property {string} reason         why not, or 'near-limit' when asking
 * @property {QuotaWindow} [window]  the nearest window, when asking
 */

/**
 * Whether this request is answered with the handoff ask. Pure: it reads its
 * arguments and the record, and writes neither.
 *
 * The caller has already established what only the server can know: the
 * request is a `POST /v1/messages` completion bound to a seat of two or more
 * accounts, with no explicit account pin, and `pinned` is the seat account the
 * conversation is pinned to (null when it is pinned nowhere on the seat).
 *
 * Asked only when the pinned account's policy is `recommend` (force means the
 * owner chose silent continuation; a 429 would stop the workers), the account
 * can still serve (`verdict` null: once it is spent the post-limit offer
 * answers instead), a known window whose reset is still ahead is past its
 * threshold (pastHandoffThreshold), another account on the seat could take over (`sibling`), and
 * the record allows it.
 *
 * @param {Object} facts
 * @param {HandoffSettings|null} facts.settings
 * @param {number} facts.bodyBytes
 * @param {string|null} facts.pinKey
 * @param {string|null} facts.sessionId
 * @param {number|null} facts.pinned       the pinned account's index
 * @param {'force'|'recommend'} facts.policy  the pinned account's policy
 * @param {unknown} facts.verdict          seatVerdict of the pinned account
 * @param {QuotaWindow[]|null} facts.windows
 * @param {string|null} facts.sibling      the next servable account's name
 * @param {import('./compact-before-switch.js').CompactAsks} facts.asks
 * @param {number} [facts.now]
 * @returns {HandoffDecision}
 */
export function decideHandoffBeforeSwitch({ settings, bodyBytes, pinKey, sessionId, pinned, policy, verdict, windows, sibling, asks, now = asks.now() }) {
  if (!settings) return { ask: false, reason: 'off' };
  if (!sessionId || !pinKey) return { ask: false, reason: 'no-session' };
  if (!(bodyBytes >= settings.minBodyBytes)) return { ask: false, reason: 'small-body' };
  if (pinned == null) return { ask: false, reason: 'not-pinned' };
  if (policy !== 'recommend') return { ask: false, reason: 'force' };
  if (verdict) return { ask: false, reason: 'cannot-serve' };
  const near = pastHandoffThreshold(windows, settings, now);
  if (!near) return { ask: false, reason: 'not-near' };
  if (!sibling) return { ask: false, reason: 'no-sibling' };
  const blocked = asks.blocks(pinKey, sessionId, bodyBytes, settings.cooldownMs, now);
  if (blocked) return { ask: false, reason: blocked };
  return { ask: true, reason: 'near-limit', window: near };
}

/**
 * A window's name as a person reads it.
 * @param {string} bucket
 * @returns {string}
 */
export function windowLabel(bucket) {
  if (bucket === 'unified5h') return '5-hour';
  if (bucket === 'unified7dFable') return 'weekly Fable';
  if (bucket === 'unified7dSonnet') return 'weekly Sonnet';
  return 'weekly';
}

/**
 * How long until `at`, coarse: "3d 4h", "1h 12m", "12m", "less than a minute".
 * @param {number} at
 * @param {number} now
 * @returns {string}
 */
export function relativeTime(at, now) {
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return 'less than a minute';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * The response: a 429 `rate_limit_error` with `x-should-retry: false` and no
 * unified headers, the shape of the actionable continuation offer, so Claude
 * Code stops and shows the text instead of its generic plan-limit banner.
 *
 * @param {Object} info
 * @param {string} info.account   the pinned account
 * @param {QuotaWindow} info.window
 * @param {string} info.sibling   the account that would take over
 * @param {string|null} [info.fresh]  the account a new conversation would start on (softDrainIndex), when one qualifies
 * @param {number} info.cooldownMs
 * @param {number} [info.now]
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function handoffAskAnswer({ account, window, sibling, fresh = null, cooldownMs, now = Date.now() }) {
  const name = `"${safeLine(account, 64)}"`;
  const next = `"${safeLine(fresh ?? sibling, 64)}"`;
  const pct = Math.round(/** @type {number} */ (window.utilization) * 100);
  const reset = window.resetsAt != null && window.resetsAt > now ? ` (resets in ${relativeTime(window.resetsAt, now)})` : '';
  const quiet = Math.max(1, Math.round(cooldownMs / 60_000));
  const message = `The account ${name}, pinned to this conversation, is at ${pct}% of its ${windowLabel(window.bucket)} quota${reset}. `
    + `It still serves this conversation with a warm prompt cache. Once it runs out, continuing this conversation means reprocessing it in full at full input-token cost on another assigned account (${next} appears available), using a cold prompt cache. `
    + `Recommended now: run /ipm:handoff while ${name} can still summarize from its cache, then start a new conversation from that summary${fresh ? `; a new conversation will start on ${next}` : ''}. `
    + `Or send any prompt to keep going here on ${name}. `
    + `This request was not sent to Claude, and this conversation will not be asked again for ${quiet} minute${quiet === 1 ? '' : 's'}.`;
  return {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'x-should-retry': 'false' },
    body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } }),
  };
}
