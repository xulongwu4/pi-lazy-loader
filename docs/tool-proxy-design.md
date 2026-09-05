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

## Prior art: `@rahularya01/pi-lazy`

A LazyVim-style extension manager for Pi solved the same problem with materially less machinery. Its
entire on-demand tool trigger registers a stub under the real tool name with a **permissive**
schema — `Type.Object({ _lazy: Type.Optional(Type.String()) }, { additionalProperties: true })`,
present only so the tool is structurally valid — whose `execute` loads the package and returns
prose: `Loaded '<pkg>' in <ms>ms. Registered tools: <list>. Call the real tool again on the next
turn.` It never forwards. Tool names are hand-declared by the user in `lazy.json`.

It independently confirms mechanic 1 below: "call again next turn" only works because the real
registration displaces the stub at the same key.

What it gives up: one wasted turn per cold tool, a stub description that advertises the stub
rather than the tool (degrading model tool-selection), first-call arguments silently discarded,
and hand-maintained names that drift.

Reviewed verdict: **it does not dominate our design, but it supplies the fix for our worst
weakness.** Announce-and-retry is a poor primary behavior — it only converts a hard failure into
a guided retry — but an excellent fallback. Hence the two tiers below.

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

## Mechanism: two tiers

A proxied tool is armed at one of two tiers, decided per tool at startup.

| | Tier 1 — faithful proxy | Tier 2 — announce-and-retry |
|---|---|---|
| Requires | valid cache entry, no `prepareArguments`, non-volatile schema | nothing beyond a manifest-declared name |
| Schema shown | the real one | permissive, `additionalProperties: true` |
| First call | loads, then **executes** | loads, does **not** execute |
| Cost | none | one extra model turn |

A tool graduates Tier 2 → Tier 1 automatically once a real load populates its cache entry. Nothing
ever falls back to "tool does not exist", which is the failure this feature exists to remove.

### Tier 1 — faithful proxy

```
startup     for each explicitly listed, armed tool of a deferred package:
              pi.registerTool({ ...cachedMetadata, execute: stub })

first call  stub.execute(toolCallId, params, signal, onUpdate, ctx)
              -> loader.loadPackage(pkg)              // idempotent, one in-flight promise
              -> pi proxy intercepts target registerTool -> capture real definition
              -> verify the requested name was actually registered  (see "post-load checks")
              -> return await real.execute(toolCallId, params, signal, onUpdate, ctx)

after       Pi registry and Fabric catalog both hold the real definition;
            the stub is retired and reachable only by pre-refresh wrappers
```

Recursion guard: forward only to the **captured** definition, never a registry lookup by name.

### Tier 2 — announce-and-retry

Register the manifest-declared name with a permissive schema and a description that leads with
capability rather than implementation, because a stub-flavored description gives the model no
reason to select the tool:

```
{capability}. This tool is deferred: its first call loads '{package}' without executing.
Retry the same '{toolName}' call after loading.
```

On call: load the package, verify the name registered, and return a result that makes
non-execution unmistakable:

```json
{ "ok": true, "loaded": true, "executed": false, "retryTool": "web_search" }
```

**Do not echo the caller's arguments back.** The model still holds its own call; echoing risks
leaking secrets into the transcript, bloating the result, and serializing values inaccurately.

Target size: about twenty lines. Do not grow Tier 2 metadata toward Tier 1 — if a tool deserves
fidelity, it belongs in Tier 1.

### Post-load checks (both tiers)

- **Verify the requested name was actually registered** after load. If it was not, return a
  manifest-drift error naming the package and tool — never "call again", which would loop.
- **Never overwrite a name already owned** by an eager extension. Skip and emit a diagnostic.
- **Concurrent calls share one in-flight load promise** (already true of `loadPackage`).
- **A load failure leaves the stub in place**, so the tool keeps answering honestly rather than
  vanishing. Package-level failure remains sticky for the session (v0.3.1).

### Drift, and the limit of the drift check

Correction from review, and it invalidates a claim in the first draft of this document: **Pi
validates raw arguments against the registered stub's schema before `execute` runs.** A post-load
comparison of captured against cached metadata therefore cannot rescue a call whose arguments
were already rejected by a stale schema. The drift check only prevents *forwarding* against stale
metadata; it does not protect the caller.

Consequence: a **configuration-dependent schema is not eligible for Tier 1** — for example MCP
direct tools, whose shape follows the connected servers and can change with no package version
bump. Either configuration identity participates in cache validity (fingerprint includes a hash
of the resolved server/tool configuration), or the tool is permanently Tier 2. Do not pretend a
post-validation drift check covers it.

Where Tier 1 does apply, keep the check: on mismatch, fail that call honestly, rewrite the cache,
and arm the corrected stub next session.

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
  demote the tool to Tier 2. `pi-mcp-adapter`'s `strictDirectToolArguments` mode is
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
| Tool has `prepareArguments` | Never Tier 1; falls back to Tier 2. Recorded as a flag at harvest |
| Configuration-dependent schema (MCP direct tools) | Tier 2 unless configuration identity participates in cache validity |
| Name collision with an eager extension | No stub registered at either tier; stderr/UI diagnostic |
| Package load failure | Stub stays at its tier, returns `isError`; failure is **sticky for the session** (see v0.3.1) |
| Stale stub cannot be removed mid-session | No `unregisterTool` in Pi; eviction is cache-only, effective next session. The stub must always answer, never hang |
| Concurrent sibling stub calls | Share one `loadPackage` promise; all must forward correctly, including those dispatched pre-refresh |
| Simultaneous command + tool first call on one package | Same shared load; must be tested explicitly |
| Cold cache | Tool is armed at **Tier 2**, never left unarmed. Graduates to Tier 1 after the first real load |

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

### v0.4.0 — tool proxies, two tiers

Gated on v0.3.1, and on v0.3.2 for the Tier 1 metadata harvest.

- **Tier 2 is the floor.** Every tool named in a deferred package's manifest declaration is
  armed announce-and-retry, so a direct call never hard-fails. Roughly twenty lines, no cache
  dependency.
- **Tier 1 is opt-in and narrow.** Explicit tool lists, valid cache entry required, no
  `prepareArguments`, no configuration-dependent schema, synchronous factory registration only,
  enabled per individually verified package. No `"auto"` mode in the first release.

Since Tier 2 needs no cache, it can ship before the harvest matures — which also means the cold
start of a fresh install is covered from day one.

## Verification plan

Deterministic — Tier 1:

1. Stub metadata matches the harvested cache entry field for field.
2. All five `execute` arguments forward with identity preserved.
3. Drift check fails the call and rewrites the cache on metadata mismatch.
4. A tool with `prepareArguments` is demoted to Tier 2, never armed at Tier 1.
5. A configuration-dependent tool is demoted to Tier 2 unless configuration identity is in the
   fingerprint.
6. Concurrent sibling stub calls trigger exactly one load and all forward correctly.

Deterministic — Tier 2:

7. The result marks `executed: false` and names the retry target; the caller's arguments are
   **not** echoed.
8. A tool whose name does not register after load returns a manifest-drift error, not "call
   again" — proving the retry advice cannot loop.
9. Tier 2 stub survives a load failure and keeps answering.
10. A tool graduates Tier 2 → Tier 1 on the next session once its cache entry exists.

Deterministic — both:

11. A command first-call and a tool first-call on the same package share one load.
12. Load failure is sticky; no handler duplication on a second attempt.
13. Collision guard: no stub at either tier for a name owned by an eager extension.
14. Post-load active-tool set unchanged.

Live matrix (isolated detached tmux, as in
[`../PHASE4-COMMAND-PROXY-RESULTS.md`](../PHASE4-COMMAND-PROXY-RESULTS.md)):

- Cold call of a Tier 1 tool, non-Fabric — loads and returns a real result in one turn.
- Same under Fabric via `extensions.*`.
- Cold call of a Tier 2 tool — loads, reports non-execution, and the model's retry succeeds.
- Second call does not reload; verify the real definition now owns the name in both Pi's
  registry and Fabric's rebuilt catalog.
- A `pi-mcp-adapter` direct tool, exercising the factory-scope timing at whichever tier applies.

Mutation tests on: five-argument forwarding, drift check, sticky failure, tier demotion, the
name-verification guard, and the collision guard.

## Explicitly cut

- `tools: "auto"` in the first release.
- Any polling or generic async-registration support.
- Emulating `prepareArguments`.
- Echoing caller arguments back from a Tier 2 result.
- Cache migration frameworks; a stale cache self-heals on the next load.
- Elaborate Tier 2 metadata — if a tool deserves fidelity it belongs in Tier 1.
- Manifest-declared tool schemas.
- A Fabric-level unknown-tool hook — cleaner seam, needs an upstream API.
- Reviving `lazy_agent` or any differently named proxy — Phase 4.0 verdict stands.
- Removing stubs mid-session — requires upstream `unregisterTool`.

## Review outcome

Three rounds of peer review, converged. Agreed: **v0.3.1 first (shipped), then v0.3.2 for the
Tier 1 metadata harvest, then v0.4.0 with Tier 2 as the floor and Tier 1 as a narrow opt-in.**
No unresolved disagreement.

The drift-check limitation in the section above was a genuine error in the first draft, caught in
review: a post-load comparison cannot rescue arguments Pi already rejected against a stale cached
schema. Configuration-dependent tools are Tier 2 for that reason.
