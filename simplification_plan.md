# Arbiter Simplification Plan

## Background & Problem Statement

Testing reveals that less capable models and coding agents reliably break when they
encounter the **async ticket / reservation** flow:

- They call `POST /request` and receive a **202 RESERVED** response instead of a
  200-granted lease.  They don't know what to do with the `q_` ticket ID.
- They attempt `arbiter permit request` while failing to understand the
  owner-resolve round-trip, causing deadlocks.

> [!NOTE]
> The existing `ARBITER_TICKET_THRESHOLD_WAIT` environment variable (default: `180`)
> is **the exact mechanism** that drives the async shift today.  Part 1 is not
> introducing a new concept — it is changing the *default* of that mechanism from
> `180 s` (always on) to `0` (disabled), and making it a first-class `arbiter.yaml`
> key so teams opt in explicitly rather than getting async behaviour by surprise.
- They end up looping on `arbiter request --ticket <id>` or retrying the wrong endpoint.

The root cause is that the broker **silently promotes a BLOCKING request to ASYNC**
when the estimated wait exceeds `ARBITER_TICKET_THRESHOLD_WAIT` (default 180 s).
This is the Dynamic Async Shift in `QueueEngine.runWatchdog()`.  From the agent's
perspective, a perfectly normal `arbiter request adb --wait` suddenly returns a
ticket with no clear next step, which breaks less-capable models.

---

## Part 1 — Simplification: Blocking-First, Opt-in Async

### Design principle

> **By default, every request blocks until the lease is granted.**
> Async/ticket behaviour is only activated when the broker is explicitly configured
> to allow it via a new `async_ticket_threshold_seconds` config key.

### 1.1  New `arbiter.yaml` key

Add one optional key to `ArbiterConfig` and `ResourceConfig`:

```yaml
# arbiter.yaml
async_ticket_threshold_seconds: 300   # NEW — set to enable async promotion
                                       # Omit (or set to 0) to keep blocking-only
```

- **If omitted or `0`**: the Dynamic Async Shift is completely disabled.  Every
  request blocks until the lease is granted, no matter how long it takes.
  The broker will never return HTTP 202.
- **If set to a positive integer**: behaviour is identical to today's
  `ARBITER_TICKET_THRESHOLD_WAIT`, but now it is an explicit opt-in.

The env variable `ARBITER_TICKET_THRESHOLD_WAIT` stays, but its **default changes
from `180` to `0` (disabled)**. When the env var is explicitly set it takes priority
over the config file value, allowing operators to override without editing files.
When the env var is absent, the config file value is used.

### 1.2  Changes in `src/config/index.ts`

```diff
 export interface ArbiterConfig {
     port?: string | number;
     default_lease_seconds?: number;
     max_lease_seconds?: number;
     global_ceiling_seconds?: number;
     heartbeat_timeout_seconds?: number;
+    async_ticket_threshold_seconds?: number;  // 0 or absent = disabled
     resources: Record<string, ResourceConfig>;
 }
```

### 1.3  Changes in `src/queue/index.ts`

**`runWatchdog()`** — gate the Dynamic Async Shift.  This is the function that
currently reads `ARBITER_TICKET_THRESHOLD_WAIT`; we replace the hardcoded env-var
read with the new property:

```diff
 public runWatchdog() {
-    if (!this.experimentalScheduling) return;
+    // Async shift is only active when explicitly configured
+    const asyncThresholdMs = this.asyncTicketThresholdMs;  // was: parseInt(env || '180') * 1000
+    if (asyncThresholdMs <= 0) {
+        // Simple mode: just pump all queues, never shift to async
+        this.lastWatchdogRun = Date.now();
+        for (const resource of this.queue.keys()) this.pump(resource);
+        return;
+    }
     ...
-    const thresholdWaitMs = parseInt(process.env.ARBITER_TICKET_THRESHOLD_WAIT || '180') * 1000;
+    const thresholdWaitMs = asyncThresholdMs;  // driven by config, not env default
```

Add a new public property:

```typescript
// Set by broker/server.ts from config; defaults to 0 (disabled)
public asyncTicketThresholdMs: number = 0;
```

**`enqueue()`** — when async is disabled, ignore any `wait_mode: 'ASYNC'` that a
caller passes and force BLOCKING:

```diff
 const entry: QueueEntry = { 
     ...
-    wait_mode: request.wait_mode || 'BLOCKING'
+    wait_mode: (this.asyncTicketThresholdMs > 0 && request.wait_mode === 'ASYNC')
+        ? 'ASYNC'
+        : 'BLOCKING'
 };
```

### 1.4  Changes in `src/broker/server.ts`

**`startBroker()`** — read the config and propagate threshold:

```diff
 const defLease = globalConfig.default_lease_seconds || 300;
+const asyncThreshold = globalConfig.async_ticket_threshold_seconds
+    ?? (parseInt(process.env.ARBITER_TICKET_THRESHOLD_WAIT || '0') || 0);
+queueManager.asyncTicketThresholdMs = asyncThreshold * 1000;
+
+if (asyncThreshold > 0) {
+    log(`[Broker] Async Ticket Mode ENABLED (threshold: ${asyncThreshold}s).`);
+} else {
+    log(`[Broker] Async Ticket Mode DISABLED (blocking-only). Set async_ticket_threshold_seconds in arbiter.yaml to enable.`);
+}
```

**`POST /request`** — remove the automatic 202 promotion when async is disabled:

```diff
-const thresholdWaitMs = parseInt(process.env.ARBITER_TICKET_THRESHOLD_WAIT || '180') * 1000;
-const estimatedWait = queueManager.getEstimatedWait(body.resource) * 1000;
-
-if (estimatedWait > thresholdWaitMs && body.wait_mode !== 'BLOCKING' && ...) {
-    body.wait_mode = 'ASYNC';
-}
+// Only consider async promotion when the feature is enabled
+if (queueManager.asyncTicketThresholdMs > 0) {
+    const thresholdWaitMs = queueManager.asyncTicketThresholdMs;
+    const estimatedWait = queueManager.getEstimatedWait(body.resource) * 1000;
+    if (estimatedWait > thresholdWaitMs && body.wait_mode !== 'BLOCKING' && ...) {
+        body.wait_mode = 'ASYNC';
+    }
+}
```

### 1.5  Changes in `src/shim/index.ts`

The shim's `--async` flag already works explicitly.  No logic change is needed.
Just update the help text so agents understand the new default:

```diff
-  request <resource>     Request a lease for a resource (e.g., android, adb).
+  request <resource>     Request a lease for a resource.  By default, blocks
+                         until the lease is granted (FIFO queue).
     --duration <secs>    How long you need the resource (default: 300s).
     --wait               Block and wait until the resource is granted (default).
-    --async              Request an asynchronous reservation ticket instead of blocking.
+    --async              Request an async reservation ticket (requires broker to have
+                         async_ticket_threshold_seconds configured).
```

### 1.6  Agent Skill file update

When `arbiter skills install arbiter` is run, the generated `SKILL.md` should
reflect the simplified mental model:

- Remove the async/ticket workflow from the "normal path" section.
- Describe it in a separate "advanced / multi-agent coordination" section.
- Add a note: "If `arbiter request` returns a ticket (202), your broker has async mode
  enabled; follow the ticket claim flow. Otherwise, the request will simply block."

---

## Part 2 — Permit System: Keep but Auto-Deny by Default

The permit system (`POST /api/permit/request`, `permit resolve`) allows a peer agent
to request one-time access to a resource while another agent holds the lease.  The
lease owner then grants or denies the request.

**Auto-granting permits by default would be dangerous** — it would allow two agents
to run device commands simultaneously while one holds the exclusive lease.  That is
exactly the race condition Arbiter is designed to prevent.

### Recommendation: Auto-deny permits by default

When no human or agent is actively watching the permit queue, the broker should
**deny any pending permit automatically** after a short timeout (e.g. 30 seconds).
This keeps the system safe by default:

- Agents that need the resource should simply **wait in the queue for a full lease**.
- Permits remain available as an advanced feature for teams that actively manage them
  (e.g., a human operator sitting at the TUI who can resolve requests in real time).

Add a new `permit_auto_deny_seconds` key to `ResourceConfig`:

```yaml
resources:
  android-device-1:
    adapter: adb
    permit_auto_deny_seconds: 30   # NEW — auto-deny pending permits after 30s (default: 30)
                                   # Set to 0 to disable auto-deny (manual resolve only)
```

The watchdog already tracks permit expiry (`expires_at` on each `PermitRequestInfo`).
We simply reduce the default expiry from its current value to 30 seconds and mark
expired-but-unresolved permits as `DENIED` rather than `EXPIRED`, so the requesting
agent gets a clear `permit_denied` error and knows to request a full lease instead.

---

## Part 3 — MCP Support: Recommendation on Removal

### Current state

`src/mcp/server.ts` (149 lines) is a thin MCP bridge that wraps three broker HTTP
calls:

| MCP Tool | Broker Endpoint |
|---|---|
| `request_lease` | `POST /request` |
| `yield_lease` | `POST /yield` |
| `get_context` | `GET /api/context` |

It is a **production dependency** (`@modelcontextprotocol/sdk ^1.29.0` in `dependencies`).

### Arguments for removal

1. **Redundant with the shim**: Every model that can call an MCP tool can also run a
   shell command (`arbiter request adb --wait`).  The shim is simpler and more
   capable (handles heartbeats, token export, status display).
2. **Dead code in practice**: There is no evidence in the codebase of any test suite,
   documentation section, or agent skill referencing the MCP server.  It is not listed
   in the `bin` section of `package.json`.
3. **Dependency weight**: `@modelcontextprotocol/sdk` (≈ 1 MB installed) is the
   largest runtime dependency and is only needed for this 149-line file.
4. **Maintenance surface**: As the broker API evolves, the MCP bridge needs to be
   kept in sync with no automated test coverage.
5. **Complexity leakage**: Agents that are MCP-enabled may choose the MCP path, then
   receive broker responses (e.g., 202 RESERVED) that the thin MCP bridge does not
   translate gracefully — compounding the async confusion described in Part 1.

### Arguments against removal

1. **Future value**: MCP is an emerging standard; having a bridge may attract
   integrators in the future.
2. **Low breakage risk**: Removing it does not affect any existing users of the shim
   or the HTTP broker API.

### Verdict: Remove in the next release

Given the codebase's alpha status and the active push to simplify, removing the MCP
server is the right call **now**.  It can always be reintroduced as a separately
published package (`arbiter-mcp`) once the core API stabilises and there is concrete
demand.

**Removal steps:**
1. Delete `src/mcp/server.ts`.
2. Remove `@modelcontextprotocol/sdk` from `dependencies` in `package.json`.
3. Remove `"@types/..."` entry if any (currently none for MCP).
4. Remove any build references in `tsconfig.json` if needed.
5. Add a one-line note to `CONTRIBUTING.md` explaining the removal rationale.

---

## Summary of Changes

| Area | Change | Impact |
|---|---|---|
| `src/config/index.ts` | Add `async_ticket_threshold_seconds` to `ArbiterConfig` | Minimal |
| `src/queue/index.ts` | Gate Dynamic Async Shift behind new property; force BLOCKING when disabled | Core simplification |
| `src/broker/server.ts` | Read config; propagate threshold; remove auto-202 when disabled | Core simplification |
| `src/shim/index.ts` | Update help text | Cosmetic |
| `arbiter.yaml` | Document new key; default stays blocking-only | Config |
| Skill file (`SKILL.md`) | Simplify normal path; move async to advanced section | Agent UX |
| `src/mcp/server.ts` | **Delete** | Simplification |
| `package.json` | Remove `@modelcontextprotocol/sdk` | Dependency |

> [!IMPORTANT]
> **All existing users are unaffected by default.**  The new default (blocking-only)
> is a safer behaviour than the current default (auto-promote to async at 180 s).
> Teams that relied on async tickets just need to add one line to `arbiter.yaml`.

> [!TIP]
> The `ARBITER_TICKET_THRESHOLD_WAIT` environment variable can still be used as an
> override for quick experimentation without editing the config file.  Its effective
> default just changes from `180` to `0`.

---

294: ## Part 4 — Phase 2: Agent Friction Reduction & Remnants Cleanup
295: 
296: ### 4.1 MCP Stale Remnants Cleanup
297: 1. **Directory**: Delete empty `src/mcp/` directory.
298: 2. **CLAUDE.md**: Remove references to `arbiter-mcp` commands (`request_lease`, `yield_lease`) and replace with standard CLI commands.
299: 3. **CONTRIBUTING.md**: Remove `mcp/` from directory structure tree and any mention of MCP features.
300: 4. **src/cli/doctor.ts**: Remove verification of `@modelcontextprotocol/sdk` package.
301: 
302: ### 4.2 Code & Configuration Simplification
303: 1. **src/state/index.ts**: Delete this unused file (its only function `getResourceState` is dead/unimported).
304: 2. **src/config/index.ts**:
305:    - Add missing properties (`command_timeout_seconds`, `command_timeout_exceptions`) to `ResourceConfig` interface.
306:    - Remove deprecated duplicate alias `max_duration_seconds` from code and CONTRIBUTING.md.
307: 3. **src/api/types.ts**: Remove unused `'REQUESTED'` and `'RELEASED'` states from `ResourceState` union type.
308: 4. **src/queue/index.ts**: Remove dead branches where `experimentalScheduling` is `false`, inlining the `true` branches.
309: 5. **src/adapters/index.ts & serial.ts**: Register or cleanly disable the unreachable `SerialAdapter` to avoid unnecessary C++ compilation overhead for users.
310: 6. **Test Artifacts**: Update `.gitignore` and modify test runners to prevent cluttering the project root with `.arbiter_context_*.json` files.
311: 
312: ---
313: 
314: ## Implementation Order
315: 
316: 1. ✅ **[Config]** Add `async_ticket_threshold_seconds` to `ArbiterConfig`; add `permit_auto_deny_seconds` to `ResourceConfig`.
317: 2. ✅ **[Queue]** Add `asyncTicketThresholdMs` property; gate watchdog shift and `enqueue()` to force BLOCKING when disabled.
318: 3. ✅ **[Broker]** Propagate config to queue; gate auto-202 promotion; add permit auto-deny watchdog.
319: 4. ✅ **[MCP]** Deleted `src/mcp/server.ts`; removed `@modelcontextprotocol/sdk` dependency.
320: 5. ✅ **[Shim]** Updated help text to reflect blocking-first default and async as opt-in.
321: 6. ✅ **[Config file]** Updated `arbiter.yaml` with documentation for both new keys.
322: 7. ✅ **[Tests]** All 14 unit tests pass; all 17 integration scenario tests pass.
323:    - `test:unit` (14/14 ✅): `early_claim`, `lease`, `queue`, `regression`, `shim_install`
324:    - `test` (17/17 ✅): All JSON scenarios including `smart_scheduling` (with `ARBITER_TICKET_THRESHOLD_WAIT=180`), `dynamic_shift`, `ticket_expiry`, etc.
325: 8. ✅ **[Skill file]** Updated `src/cli/skills.ts` generated SKILL.md.
326: 9. ✅ **[Phase 2 - MCP Remnants]** Delete `src/mcp/` directory, update `CLAUDE.md`, `CONTRIBUTING.md`, and `doctor.ts` to purge stale references.
327: 10. ✅ **[Phase 2 - Dead Code]** Delete `src/state/index.ts`, clean up `ResourceState` unused states, inline `experimentalScheduling = true` branches, resolve unreachable `SerialAdapter`.
328: 11. ✅ **[Phase 2 - Config & Tests]** Add missing config keys to typescript definitions, remove `max_duration_seconds` alias, prevent `.arbiter_context_*.json` test artifact pollution in project root.
