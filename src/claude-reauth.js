import { randomBytes } from 'node:crypto';
import { startOAuthLogin, fetchProfile } from './oauth.js';
import { exactReauthIdentity, renderedReauthIdentity } from './identity.js';
/** @typedef {import('./types.js').CodedError} CodedError */

export const CLAUDE_REAUTH_FLOW_TTL_MS = 5 * 60_000;
const MAX_FLOWS = 8;
const MAX_CODE_LENGTH = 16_384;
const COMPLETION_TIMEOUT_MS = 30_000;

function failure(code, status, message) {
  const err = /** @type {CodedError} */ (new Error(message));
  err.code = code;
  err.status = status;
  return err;
}

async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('oauth_timeout', 504, 'OAuth completion timed out')), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded, manual-PKCE flows held only in this process. No account/config writer is
 * reachable from this class: completion returns the credential bundle to the console,
 * which remains responsible for ownership checks and the single SSM write.
 */
export class ClaudeReauthFlows {
  constructor({
    startFlow = startOAuthLogin,
    profile = fetchProfile,
    now = Date.now,
    ttlMs = CLAUDE_REAUTH_FLOW_TTL_MS,
    completionTimeoutMs = COMPLETION_TIMEOUT_MS,
  } = {}) {
    this.startFlow = startFlow;
    this.profile = profile;
    this.now = now;
    this.ttlMs = ttlMs;
    this.completionTimeoutMs = completionTimeoutMs;
    this.flows = new Map();
  }

  async start(account) {
    this.expire();
    if (this.flows.size >= MAX_FLOWS) throw failure('too_many_flows', 429, 'too many OAuth flows are open');
    const identity = renderedReauthIdentity(account);
    const controller = new AbortController();
    const flow = await this.startFlow({ loopback: false, signal: controller.signal, timeoutMs: this.ttlMs });
    if (this.flows.size >= MAX_FLOWS) {
      controller.abort();
      throw failure('too_many_flows', 429, 'too many OAuth flows are open');
    }
    const id = randomBytes(32).toString('base64url');
    const timer = setTimeout(() => {
      controller.abort();
      this.flows.delete(id);
    }, this.ttlMs);
    timer.unref?.();
    this.flows.set(id, {
      flow, controller, timer, identity,
      expiresAt: this.now() + this.ttlMs,
      completing: false,
    });
    return { flowId: id, authorizationUrl: flow.url, identity };
  }

  async complete(id, code) {
    this.expire();
    const held = this.flows.get(id);
    if (!held) throw failure('flow_not_found', 404, 'OAuth flow not found or expired');
    if (held.completing) throw failure('flow_busy', 409, 'OAuth completion is already running');
    if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE_LENGTH) {
      throw failure('invalid_code', 400, 'a bounded authorization code is required');
    }
    held.completing = true;
    try {
      let submitted;
      try {
        submitted = held.flow.submit(code);
      } catch {
        held.completing = false;
        throw failure('invalid_code', 400, 'authorization code was not accepted for this OAuth flow');
      }
      if (!submitted) {
        held.completing = false;
        throw failure('invalid_code', 400, 'authorization code was not accepted for this OAuth flow');
      }
      const deadline = Date.now() + this.completionTimeoutMs;
      const credentials = await beforeDeadline(held.flow.tokens, deadline);
      if (typeof credentials?.accessToken !== 'string' || !credentials.accessToken
        || typeof credentials?.refreshToken !== 'string' || !credentials.refreshToken
        || !Number.isFinite(credentials?.expiresAt) || credentials.expiresAt <= 0) {
        throw failure('incomplete_credentials', 502, 'OAuth returned an incomplete credential bundle');
      }
      const profile = await beforeDeadline(this.profile(credentials.accessToken), deadline);
      if (!exactReauthIdentity(held.identity, profile)) {
        throw failure('identity_mismatch', 409, 'the signed-in account is not the rendered account and organization');
      }
      return {
        credentials: {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
        },
        identity: { ...held.identity },
      };
    } catch (err) {
      if (err?.code === 'invalid_code') throw err;
      if (err?.status && err?.code) throw err;
      throw failure('oauth_failed', 502, 'OAuth acquisition or profile validation failed');
    } finally {
      if (held.completing) {
        clearTimeout(held.timer);
        held.controller.abort();
        this.flows.delete(id);
      }
    }
  }

  expire(now = this.now()) {
    for (const [id, held] of this.flows) {
      if (held.expiresAt > now) continue;
      clearTimeout(held.timer);
      held.controller.abort();
      this.flows.delete(id);
    }
  }
}
