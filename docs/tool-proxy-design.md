# Tool Proxy Design (Phase 5)

**Status:** Agreed design — not implemented  
**Targets:** `v0.3.1` (prerequisites), `v0.4.0` (tool proxies)  
**Reviewed by:** peer design review (`openai-codex/gpt-5.6-sol`), two rounds, converged  
**Depends on:** v0.3.0 command-proxy machinery (`LazyLoader.reserveCommand`, staged commit)

## Problem

With a package deferred, its tools do not exist until `lazy_load` runs. A model that calls
the tool directly gets "tool does not exist", burning a turn. `lazy_load` advertises only
four hardcoded intent mappings, so misses are common.

**Goal:** a direct call to a deferred package's tool loads the package and executes the
real tool, in one call, with no model choreography.

## Why this is not Phase 4.0

Phase 4.0 (`lazy_agent`, NO-GO — [`../PHASE4-RESULTS.md`](../PHASE4-RESULTS.md)) registered
a **differently named** proxy and required the model to elect it. It didn't. This design
registers proxies under the **real tool name and schema**: nothing to elect, nothing to
route around. Same deterministic-dispatch property that made the Phase 4.2 command proxy
work. Both reviewers agree the distinction holds.

## Verified runtime mechanics

Read out of the installed runtime and independently re-verified during review.

### 1. A loaded target's `registerTool` writes into *our* extension's tool map

`@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:239-246`

```js
registerTool(tool) {
  assertActive();
  extension.tools.set(tool.name, { definition: tool, sourceInfo: extension.sourceInfo });
  runtime.refreshTools();
}
```

`extension` is the closure of whichever `ExtensionAPI` the factory received.
`LazyLoader.loadSingleEntry` passes **our** proxy, so the target's registration lands in
pi-lazy-loader's own map, **replacing our stub at the same key**. Pi core exposes no
`unregisterTool` (`pi-mcp-adapter` probes for it with `?.` and degrades), so same-key
replacement is the only removal path available — and the one this design needs.

**Caveat agreed in review:** this is *supported-version behavior*, not a stable public Pi
API guarantee. The ABI fingerprint (below) exists to catch it changing.

### 2. Same-name re-registration does not disturb the active tool set

`dist/core/agent-session.js:2098-2170` — `_refreshToolRegistry` auto-activates only names
not already in `previousRegistryNames`. A stub holding the name means no active-set churn
and no visibility flicker on load.

### 3. Fabric re-captures on refresh; it does not pin the stub

`pi-fabric/dist/capture/catalog.d.ts:17` — `CapturedToolCatalog.replace(registeredTools,
runner, config, ownSourcePath)` rebuilds the catalog, and the capture wrapper closes over
the then-current `execute`.

Consequence — **this simplifies the design**: after a successful load, Pi's registry and
Fabric's catalog both converge on the real definition. The stub needs **no post-refresh
lifetime**. It must only remain callable for calls and wrappers acquired *before* the
refresh — which may be several concurrently dispatched sibling calls, not just one.

### 4. `getAllTools()` is a lossy schema source — do not harvest from it

`agent-session.js:641-649` returns only `{name, description, parameters,
promptGuidelines, sourceInfo}`. `ToolDefinition` (`types.d.ts:344-377`) also carries
`label`, `promptSnippet`, `constrainedSampling`, `renderShell`, `prepareArguments`,
`executionMode`, `renderCall`, `renderResult`.

A before/after **name diff also misses same-name replacements** — exactly the mechanism
this design relies on. Harvest by intercepting the target's `registerTool` instead.

### 5. `execute` takes five arguments

`types.d.ts:372` — `execute(toolCallId, params, signal, onUpdate, ctx)`. All five forward.

### 6. MCP direct tools register at factory scope

`pi-mcp-adapter@2.32.1` calls `syncDirectTools` at `index.ts:1225`, outside any handler,
from its on-disk metadata cache; proxy and namespace tools register on the same
synchronous path (`index.ts:1226-1229`). Since `loadSingleEntry` awaits the factory, those
tools exist before `loadPackage` resolves. The async path is metadata *refresh*, which
mutates existing names rather than creating them.

## Mechanism

```
startup     for each explicitly listed, armed tool of a deferred package:
              pi.registerTool({ ...cachedMetadata, execute: stub })

first call  stub.execute(toolCallId, params, signal, onUpdate, ctx)
              -> loader.loadPackage(pkg)              // idempotent, one in-flight promise
              -> pi proxy intercepts target registerTool -> capture real definition
              -> compare captured metadata against the cached stub  (see "drift check")
              -> return await real.execute(toolCallId, params, signal, onUpdate, ctx)

after       Pi registry and Fabric catalog both hold the real definition;
            the stub is retired and reachable only by pre-refresh wrappers
```

Recursion guard: forward only to the **captured** definition, never a registry lookup by
name.

### Drift check

A package version fingerprint does not catch **configuration-dependent schemas** (an MCP
server whose tool list changed, a package reading project settings). So before the first
forward, compare the freshly captured metadata against the cached stub. On mismatch: fail
*that call* honestly, rewrite the cache, and arm the corrected stub next session. Do not
silently forward a call whose arguments were validated against a stale schema.

## Schema source: harvest at `registerTool`, cache to disk

Hand-declaring schemas in `manifest.json` would be hundreds of lines drifting on every
upstream release. Instead, capture the definition the target passes to `registerTool` and
persist its serializable fields to `${agentDir}/lazy-loader-tools.json`:

`name`, `label`, `description`, `promptSnippet`, `promptGuidelines`, `parameters`,
`renderShell`, `executionMode`, `constrainedSampling`.

Rules agreed in review:

- **Arm only metadata that survives a JSON round trip without loss.** Anything that does
  not is a reason to leave the tool unarmed, not to approximate it.
- **Never arm a tool whose captured definition had `prepareArguments`.** It is a function,
  so it cannot be cached; and Pi validates raw args against the *stub's* schema before
  calling the stub, so a JSON-string-encoded object argument that the real shim would have
  recovered gets rejected at the proxy. Record `hasPrepareArguments: true` at harvest and
  leave the tool to `lazy_load`. `pi-mcp-adapter`'s `strictDirectToolArguments` mode is
  precisely this case. Emulating Pi's preprocessing order was rejected as fragile coupling.
- **`renderCall`/`renderResult` are recorded but are not correctness blockers.** A
  first-call presentation fallback is acceptable; note it per tool.
- Fingerprint on package entry/version **plus supported Pi ABI**.

Precedent: `pi-mcp-adapter` already caches tool metadata to `~/.pi/agent/mcp-cache.json`
so direct tools register at startup "without server connections". Harvest-and-replay is
the established pattern here.

## Configuration

Stubs restore prompt tokens. The measured **startup** saving survives (no import, no MCP
connect, no network), but the system prompt regrows by roughly the tool's schema weight
(`pi-mcp-adapter` estimates ~150-300 tokens per direct tool).

**Explicit lists only. No `"auto"` in the first release.**

```json
{
  "version": 1,
  "packages": {
    "pi-mcp-adapter": { "commands": ["mcp"], "tools": ["mcp"] }
  }
}
```

A package is eligible only if it registers tools at **synchronous factory scope**, verified
individually. `"auto"` may return once several packages have been proven, never before.

## Failure modes

| Risk | Handling |
|---|---|
| Cached tool never registers after load | Fail immediately with an `isError` naming package and tool. **No polling** — a poll turns a 0.5 s optimization into a 5 s failure |
| Captured metadata differs from cached stub | Fail that call, rewrite cache, arm next session |
| Tool has `prepareArguments` | Never armed; recorded and skipped at harvest |
| Name collision with an eager extension | No stub registered; stderr/UI diagnostic |
| Package load failure | Stub stays, returns `isError`; failure is **sticky for the session** (see v0.3.1) |
| Stale stub cannot be removed mid-session | No `unregisterTool` in Pi; eviction is cache-only, effective next session. The stub must always answer, never hang |
| Concurrent sibling stub calls | Share one `loadPackage` promise; all must forward correctly, including those dispatched pre-refresh |
| Simultaneous command + tool first call on one package | Same shared load; must be tested explicitly |
| Cold cache | Tool is **not armed**. Documented as "not armed until harvested", never advertised as transparent |

## Release sequencing

### v0.3.1 — prerequisites, valuable independently

1. **Cached tool→package inventory in `lazy_load` guidance.** A compact name→package map
   from the same cache, replacing the four hardcoded intent mappings. This is the "80%
   solution": it costs one deliberate load call but needs no stubs, no schemas, no
   dispatch emulation. It also closes an existing logged limitation. Ships regardless of
   whether tool proxies ever ship.
2. **Sticky session failure.** *Pre-existing v0.3.0 defect, not introduced here:*
   `loadPackage` retries a failed package, but `loadSingleEntry` has already run the
   target's `target.on(...)` registrations, so a retry can multiply handlers. Mark a failed
   package failed for the session; retry only after `/reload` or restart.
3. Correct `/lazy list` readiness for eagerly loaded commands; reject partial non-empty
   `extensions` filters (already logged in `development-status.md`).

"Atomic" should be described honestly in docs: staging covers the **reserved command/tool
handoff only**. Event handlers and unreserved registrations commit as the factory runs.

### v0.4.0 — tool proxies, narrow

Gated on v0.3.1. Explicit tool lists, valid cache required, synchronous factory
registration only, enabled per individually verified package.

## Verification plan

Deterministic:

1. Stub metadata matches the harvested cache entry field for field.
2. All five `execute` arguments forward with identity preserved.
3. Drift check fails the call and rewrites the cache on metadata mismatch.
4. A tool with `prepareArguments` is never armed.
5. Concurrent sibling stub calls trigger exactly one load and all forward correctly.
6. A command first-call and a tool first-call on the same package share one load.
7. Load failure is sticky; no handler duplication on a second attempt.
8. Collision guard: no stub for a name owned by an eager extension.
9. Post-load active-tool set unchanged.

Live matrix (isolated detached tmux, as in
[`../PHASE4-COMMAND-PROXY-RESULTS.md`](../PHASE4-COMMAND-PROXY-RESULTS.md)):

- Cold call of an armed tool, non-Fabric — loads and returns a real result.
- Same under Fabric via `extensions.*`.
- Second call does not reload; verify the real definition now owns the name in both Pi's
  registry and Fabric's rebuilt catalog.
- An armed `pi-mcp-adapter` direct tool, exercising the factory-scope timing.

Mutation tests on: five-argument forwarding, drift check, sticky failure,
`prepareArguments` exclusion, collision guard.

## Explicitly cut

- `tools: "auto"` in the first release.
- Any polling or generic async-registration support.
- Emulating `prepareArguments`.
- Manifest-declared tool schemas.
- A Fabric-level unknown-tool hook — cleaner seam, needs an upstream API.
- Reviving `lazy_agent` or any differently named proxy — Phase 4.0 verdict stands.
- Removing stubs mid-session — requires upstream `unregisterTool`.

## Review outcome

Both reviewers endorse: **v0.3.1 first, then v0.4.0 as a narrow opt-in experiment.** No
unresolved disagreement.
