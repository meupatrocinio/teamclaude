# Client routes (fixed seats)

*IPM fork only (`meupatrocinio/teamclaude`). Upstream teamclaude does not have this feature.*

A client route gives a set of client keys (`proxy.clientKeys`) their own account, called a seat. A key
on a route is served by its seat's accounts only. Neither rotation nor a failover hop moves it to
another account. With `proxy.requireClientRoute` on, a key on no route gets no Anthropic inference.

Only Anthropic requests are routed this way. Codex and other providers keep their normal rotation.

## Config

```json
"clientRoutes": [
  { "name": "seat-7", "clients": ["pedro"], "accounts": ["seat-7@example.com"] },
  { "name": "seat-3", "clients": ["ana", "ana-ci"], "accounts": ["seat-3@example.com"] }
],
"proxy": { "requireClientRoute": true }
```

- `clients`: client key names, matched trimmed and case-insensitive.
- `accounts`: account names, resolved against the live account list on every request. Any form
  `/tc-acct/` accepts works. The name must match exactly one account. A name no account has, a
  name two accounts share, or a Codex subscription makes the route **unresolved**.
- A client listed on two routes is **ambiguous**. Neither route applies, and the key gets
  "seat unavailable".
- A route with several accounts is allowed. Its requests stay inside those accounts, and failover
  hops move only between them. The account list is a **queue**: a conversation pins to the account
  it starts on. Each account has a per-request quota policy, selected by the caller (`recommend` by
  default, or `force`). The source account's policy governs each move. While `handoffBeforeSwitch`
  is on, the queue is ordered by **free space**: a fresh conversation, and a conversation moving off
  a spent account, takes the servable account with the most room before its handoff thresholds
  (the [soft drain](#soft-drain)), so new work does not open on an account about to run out.
  With the setting off, the queue is config order and fresh conversations take the first servable
  account, so the seat's quota drains one account at a time.

  - `recommend`: while the pinned account still serves, a large conversation near one of its
    quota windows is told once to run `/ipm:handoff` (see [Handoff before the limit](#handoff-before-the-limit)).
    The first quota failure warns that continuing the same conversation will reprocess its full
    context with a cold prompt cache, and offers a new conversation or waiting for the reset. A
    later prompt in that same conversation confirms the switch once and re-pins there.
  - `force`: the first real quota failure immediately retries the identical request body on the
    next assigned account in the queue that can serve, preserving the conversation, and re-pins there. Every
    force hop is independently authorized by the account that just failed.

  If the destination also spends out, its own policy applies: a recommend destination offers and
  requires confirmation before moving again, while a force destination retries immediately. A
  single-account route has nowhere to move, so both modes retain the hard stop.

  `cg` sends the choices as `x-teamclaude-seat-policy: *=recommend,s1=recommend,s2=force`. The
  renderer emits route slugs and accounts in the same order, so `s1+s2` maps those slugs to the two
  resolved accounts by position. Missing entries mean recommend. Malformed entries, duplicates,
  foreign slugs, or slug/account-length mismatches disable force for the whole request. The header
  is a preference, never routing authority, and is stripped before the request reaches Anthropic.

### Seat priority queue

A caller on a route of two or more accounts can say which of them it prefers, in order, with
`x-teamclaude-seat-order: s3,s1` (`cg seat select` sends it). The slugs are the route's own, mapped
to accounts by position as above. It reorders the queue, it does not pin:

- While `handoffBeforeSwitch` is on, the accounts with room before their handoff thresholds come
  first, then those past one. Inside each part, the listed accounts come in the caller's order, then
  the unlisted ones by free space. A listed account past a threshold therefore yields to any account
  with room, and is still preferred over the unlisted accounts past one.
- With the setting off, the listed accounts come in the caller's order, then the rest in config order.

The order is the one every destination uses: where a fresh conversation starts (the soft drain),
where the recommend continuation and the force hop move a conversation off a spent account, and the
account the post-limit offer and the handoff ask name. A pinned conversation is never moved by it,
and a change of order applies only to conversations that start or move afterwards.

A well-formed slug that is not on the caller's route (stale after a seat change, or another route's)
is skipped, so the header can never reach an account the key is not bound to. A malformed header (an
empty or invalid entry, a repeated slug, more than 64 entries or 4096 bytes) is ignored whole and the
queue is plain free-space order. The header is stripped before the request reaches Anthropic. A
request without it gets the order above with nothing listed.

A build without this feature (1.1.30-ipm.3 and older) does not ignore the header: it does not know to
strip it and forwards it to Anthropic, seat slugs included. Such a build advertises no
`capabilities.seatOrder` on `/teamclaude/status`, so `cg` sends the header only to a proxy that
reports `seatOrder: true`, and keeps a saved queue unsent until the gateway is updated.

### Owner-root continuation policies (AI-1903)

`continuationPolicies` is the durable, owner-controlled form of the per-seat choice, rendered by
the gateway (never hand-edited):

```json
"continuationPolicies": [
  { "client": "pedro", "keyHash": "<64-hex sha256 of the client key>", "mode": "force", "revision": "r_…", "quarantine": false }
],
"continuationPolicyErrors": []
```

A root matches a request by its authenticated client name (trimmed, lowercased — the same
normalization as the route gate) plus the full SHA-256 of the presented key, on the direct HTTP
path and inside MITM CONNECT tunnels alike. When a root exists for the key, its mode applies to
**every account of the key's route** and the legacy `x-teamclaude-seat-policy` header is ignored
entirely, so every local and remote worker using the key follows the one owner choice. A request
captures `{ mode, revision }` once at admission; that snapshot governs all its retries and hops.

- A key with no root keeps today's header behavior; the only exceptions are the two bounds below,
  which apply to every force continuation, header-driven included: the 8-hop cap and the
  mid-request key re-check. An absent `continuationPolicies` key means no roots for everyone.
- A malformed list (not an array) fails safe: every key recommends and legacy force headers are
  ignored, with `continuationPolicyLoadError: "malformed_list"` in status. An entry with a valid
  client and keyHash but a bad mode or revision fails that key safe to recommend
  (`"malformed_entries"`). An entry whose client or keyHash is invalid is dropped.
- Continuation offers are scoped by the root **revision** and a key reference
  (`sha256("teamclaude-offer-v1" NUL keyHash)`, first 32 hex — the full keyHash never enters a
  tracker key, offer record, log line or status). A revision change invalidates older offers: a
  mismatch consumes the offer and fails closed, and an in-flight request admitted under the old
  revision records nothing under the new one.
- Force continuation is capped at **8 automatic continuations (hops) per request** — 9 upstream
  attempts counting the first; the next would-be hop gets a
  non-unified 429 with `x-should-retry: false`. Before every force hop the presented key is
  re-checked against the current client keys: a key revoked or rotated by a reload mid-request ends
  the request with the same non-unified 429 instead of hopping.
- The actionable multi-seat 429 (a pinned conversation whose seat has a servable sibling) appends
  the owner-wide `cg seat-policy force` paragraph only when the request carries
  `x-teamclaude-cg-contract: root-v1` — older cg builds answer that command with a usage error on
  multi-seat keys. Single-seat and no-candidate variants never carry it. The header is stripped
  before any upstream on every path.

`POST /teamclaude/reload` applies both keys with no restart, in the same step as `proxy.clientKeys`.
A request keeps the binding it read at admission for all its retries.

Client routes are separate from the model routes (`routes`). `teamclaude route`, the TUI, the MCP
tools and `getRoutes()` never see them.

## End-user identity upstream

Every Anthropic inference request (`POST /v1/messages` served by an Anthropic account — not
`count_tokens`, not `GET /v1/models`, and not an `openai-chat` account) that carries a client key
is stamped with a stable per-user tag in
`metadata.user_id` (`gateway_user: "u_<sha256 of the key name, 16 hex>"`), on any pool — routes or
not. The key name is hashed because user_id must not carry PII, and the name — not the key — is
what survives a re-mint. Claude Code's own `device_id`, session id and `account_uuid` pass through
untouched, so upstream attributes per person and per machine rather than per seat; Anthropic's
abuse-detection guidance asks multi-user services for exactly this. Requests with no client key
(the shared admin key, key-less loopback) go unstamped, and Codex bodies carry no
`metadata.user_id` and are not stamped.

The stamp edits the body in place with a single-pass span finder and then **validates the result**:
the stamped document must parse as JSON and show the tag at the top level, or the original body is
sent untouched. A wrong span therefore skips the stamp; it can never corrupt a request. (The first
version of this feature shipped without the net and miscounted depth on multi-element arrays,
inserting `metadata` inside `system`/`messages` blocks — Anthropic's `messages.N.metadata: Extra
inputs are not permitted` of 2026-10-23. The regression fixtures live in `test/user-identity.test.js`.)

## What a request gets

The gate runs for every Anthropic request once any route exists or the switch is on. The same rules
apply to direct HTTP (`x-api-key`) and to MITM (`Proxy-Authorization` on the CONNECT).

| Caller | Answer |
|---|---|
| Key on a route | Served by its seat. The switch threshold does not apply: a seat is used until upstream says it is spent. |
| Key on a route, `/tc-acct/` or `TC_ACCT` pin to another account | 403 `permission_error` |
| Key on no route, switch on | 403 `permission_error` |
| Key on no route, switch off | Normal rotation over every account |
| Shared `proxy.apiKey` or key-less loopback, switch on, no pin | 403 `permission_error` |
| Shared `proxy.apiKey` or key-less loopback, with a `/tc-acct/`, `TC_ACCT` or session pin | Served by the pinned account, and logged with an unverified `x-tc-caller` hint (`console-probe`, `warmer`, else `operator`). The header is not forwarded upstream. |
| `GET /v1/models` | Never refused. A key on a route gets its seat; any other caller gets normal selection, and no session affinity is recorded. |

When the seat cannot serve, the answer always comes from the seat itself:

| Seat state | Answer |
|---|---|
| Spent: upstream sent a 429 rejecting a quota window, and that window's reset is still ahead | 429 with upstream's own `anthropic-ratelimit-unified-*` headers and `x-should-retry: false`. The 429 that reports the spend gets this answer at once. Later requests get it with nothing sent upstream. A `7d_oi` rejection covers Fable requests only. |
| Spent pinned account in a multi-account route, with a servable sibling | `recommend`: the first response is an actionable 429 offer with `x-should-retry: false` and no unified headers, so Claude Code shows the choices (continue cold, start a new conversation, or wait for the reset) instead of its generic plan-limit banner. It does not recommend `/ipm:handoff`: after the limit, running one is itself the prompt that confirms the cold continuation. Its message names the currently servable sibling first, then gives the reset blocking the pinned account for this request, so the reset does not read as a key-wide outage; the destination is selected again when the next request arrives. The next prompt confirms and switches once. `force`: the same request retries immediately on the sibling with its body unchanged. |
| Pinned account in a multi-account route near a quota window, still serving, `recommend`, with a servable sibling | Once per conversation per cooldown, for a large request: an actionable 429 recommending `/ipm:handoff` now (`handoffBeforeSwitch`, below). Nothing is sent upstream; the next prompt is served by the pinned account. |
| Throttled (rate-limit hold) | 429 with `retry-after`. It stays retryable. |
| Operator budget cap (`maxUsage`, `maxSpend`) | 429 with `x-should-retry: false`. No unified headers are made up. |
| Disabled, in error, credential or routing failure, route unresolved or ambiguous | 503 with `x-should-retry: false` |

If the state is unknown (no reading yet, or a reset time already past), the request goes to the
seat, and upstream's answer is recorded for the next request. teamclaude never makes up a reset time.

A successful confirmed continuation adds `x-teamclaude-seat-failover` with the source, destination
and `cold-cache=true`. It does not alter the assistant's response body or SSE events. Upstream-supplied
copies of the internal policy/failover headers are discarded.

A cordoned account (`teamclaude cordon`) inside a fixed seat keeps serving that seat: the seat belongs to the client, so a cordon takes no new fleet conversation onto the account but never empties the seat.

Upstream's fleet re-routing never moves a request bound to a seat. Such a request takes no billing,
account-refusal or model-unsupported failover and puts no billing cooldown on the account: upstream's
answer is relayed as it was before (ipm.24). The tail of a list pin (`/tc-acct/a,b`) is dropped for a
key on a route, and `compactBeforeSwitch` never asks a seat-bound request to compact. With
`proxy.controlPlane` unset, `proxy.requireClientRoute: true` or a key on a route makes the control
plane `"pool"`, so Claude Code's bootstrap, policy and registry calls go through the seat gate like
inference, and a scope 403 on a seat account is answered from the seat, never relayed on the client's
own login. An explicit `proxy.controlPlane` is honoured.

Force applies only to genuine quota rejection. Throttling, credential/entitlement failures, 5xx,
third-party 400s, stream failures, transport errors, operator caps, and token/routing failures never
move a pinned conversation to a sibling. Fresh, unpinned conversations keep their ordinary queue
advance behavior.

## Handoff before the limit

`handoffBeforeSwitch` (on by default) recommends `/ipm:handoff` while it can still help. After the
pinned account is spent, running the handoff is a prompt in that same conversation, so it confirms
the cold-cache continuation it was meant to avoid. Before the limit, the pinned account summarizes
the conversation from its warm cache, and the new conversation starts small.

A request is answered with the ask only when all of these hold: it is a `POST /v1/messages`
completion bound to a seat with two or more accounts, with a client session, no explicit
account pin, and no `x-teamclaude-worker-id` (a worker's 429 has no reader, so the ask would only
stop it a turn before the limit would); its conversation is pinned to an account of the seat whose policy is `recommend`
(never `force`: unattended workers chose silent continuation, and a 429 would stop them); that
account can still serve; for a window that has not already reset, its known 5-hour utilization is
at least `fiveHourUtilization` or a known weekly one (shared, model family, or scoped) is at least
`weeklyUtilization`; the body is at least `minBodyBytes`; another account on the seat
can serve (the one the post-limit offer would name); and the conversation was not asked within
`cooldownSeconds`, nor its client session within two minutes (the record `compactBeforeSwitch`
uses, kept separately). Within the cooldown, a client session that was already asked is asked
again only by a body at least as large as the one it was asked on (`session-smaller`). The body's
last message must be a `user` prompt the person typed, with no `tool_result` block, so a turn
mid-task or a subagent's tool turn is never asked.

```json
"handoffBeforeSwitch": { "fiveHourUtilization": 0.75, "weeklyUtilization": 0.9, "minBodyBytes": 200000, "cooldownSeconds": 1800 }
```

`false` turns it off; any field that is not a usable number takes its default (the two
utilizations above 0 and below 1, the other two above 0). They are fixed utilizations rather than a
margin under the switch threshold, because a seat ignores the switch threshold and runs until
upstream rejects. The 5-hour threshold is lower because under parallel sessions a 5-hour window can
burn from its first serve to spent in minutes, which leaves too little room at 90% to run the
handoff. When several windows are past, the one furthest past its own threshold is named.

The answer is a 429 `rate_limit_error` with `x-should-retry: false` and no unified headers, the same
shape as the post-limit offer, so Claude Code shows its text. It names the pinned account, the
window and its percentage, the reset as a relative time when known, the account a new conversation
will start on (the soft drain's pick, left out when that pick is the pinned account itself, which
happens only when it still has the most room), the sibling that appears available (the next account
by free space), and the choices: run `/ipm:handoff` now, or send any prompt to keep going on the
pinned account. The ask is recorded
before the answer is written, so the next prompt of that conversation, the handoff included, is
forwarded to the warm account. Each ask writes one log line naming the session, seat, account,
window and sibling, and shows in the activity log with status `429` and
`(handoff before switch: <account>)` in place of the account. `GET /teamclaude/status` reports the
setting as resolved and the count since start under `handoffBeforeSwitch`. Read per request, so
`POST /teamclaude/reload` applies an edit to the next one. An error inside the decision forwards
the request.

### Soft drain

With the same thresholds, while the setting is on, a seat of two or more accounts ranks its
accounts by free space: an account's room is its tightest window, the 5-hour one measured against
`fiveHourUtilization` and every weekly one against `weeklyUtilization`. A window with no reading, or
one that has already reset, counts as unused. A conversation that has no compatible pin on the seat
starts on the servable account with the most room; accounts with equal room (no readings yet, for
example) keep config order. When every account is past a threshold, the one with the most room
still wins. The same order picks where a conversation goes when its pinned account is spent (the
recommend continuation and the force hop), and the account the post-limit offer and the handoff ask
name. The order is read again on every request, so a message names the account that appears
available when it is written; answers in between can change which account the move takes.

Ordering by free space spreads new conversations over every account with room, instead of
draining one account at a time. The accounts then fill together, so their windows also tend to run
out closer together; the handoff ask and the continuation still cover each conversation as its own
account nears its limit.

It applies under any policy, workers included. A pinned conversation is never moved by it: it keeps
its warm account until that account is spent. Because readings arrive only with answers, a burst of
new conversations before the next answer lands on the same account. The thresholds are read once
when the request is admitted.

## Operator overrides

`POST /teamclaude/session-pin` (operator only, like `/teamclaude/switch`) moves one session onto a
named account. With client routes in force, the pin is **bound to a client key** and applies only to
requests from that key:

- `"client": "<key name>"` in the body names the key;
- with no `client`, the pin binds to the key the session was seen with. If the session id was seen
  with more than one key, the endpoint answers 409.

An override for a key is checked before that key's own pins. It can also serve a key that has no
seat. Another key sending the same session id goes through its own gate.

A client key cannot POST `/teamclaude/switch` (or `/teamclaude/session-pin`). Both are refused with
403.

## Status

`GET /teamclaude/status` always carries:

- `clientRoutes`: `[{ name, clients, accounts, resolved, problem? }]`, an empty list when none are
  configured;
- `requireClientRoute`: `true` or `false`;
- `capabilities`: `{ continuationPolicies: 1, workerIdentity: true, seatOrder: true }` — whether this build speaks owner-root continuation policies, accepts the opt-in `x-teamclaude-worker-id` worker identity (AI-1960) and honours (and strips) the `x-teamclaude-seat-order` seat priority queue;
- `caller.seat` for a client-key caller: `{ name, accounts, resolved, state, windows, resetsAt }`, or
  `null` when the key has no seat. The admin-key poll never carries it;
- `caller.continuationPolicy` for a client-key caller: its own `{ source: "root" | "legacy", mode,
  revision }` (`mode`/`revision` are `null` under `legacy`). The operator poll carries the admin
  view instead: `continuationPolicies` (`[{ client, mode, revision, quarantine }]`), the renderer's
  `continuationPolicyErrors`, and `continuationPolicyLoadError` (a short fixed reason or `null`).
  No keyHash ever appears in status.

## Activity log

Every refusal and hard stop writes two lines:

```
Seat gate: client "uma" seat (none) → no-seat (403)
[uma] POST /v1/messages → (no seat) [no-seat] (403, 0.0s)
```

The reasons are `no-seat`, `foreign-pin`, `spent`, `throttled`, `capped`, `unavailable`,
`operator-unpinned`, `admin-pin` (an override that served) and `operator-pin` (a pinned operator
request). Each reason goes in the request line's single tag slot. A request served on its seat
keeps the `[pin]` tag.

## Turning it off

Set `proxy.requireClientRoute` to `false` and reload: keys with no seat rotate again. Set
`clientRoutes` to `[]` and reload: every key rotates. With neither key set, the build behaves like
upstream teamclaude.
