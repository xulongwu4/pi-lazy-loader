# pi-lazy-loader: Implementation Summary and Phase 4 Design

## Executive Summary

`pi-lazy-loader` reduces Pi startup work by leaving selected package resources installed while filtering only their extension entry points with `"extensions": []`. A small eager extension loads those entry points later, in the running session, through jiti and Pi's live `ExtensionAPI`.

The implementation is released at:

- Repository: <https://github.com/xulongwu4/pi-lazy-loader>
- Installed release: `v0.2.0`
- Pi package source: `git:github.com/xulongwu4/pi-lazy-loader@v0.1.1`

The validated v0.2.0 configuration defers four packages:

- `pi-web-access`
- `pi-mcp-adapter`
- `@quintinshaw/pi-dynamic-workflows`
- `pi-token-burden`

`pi-fabric`, `@tintinweb/pi-subagents`, provider extensions, and extensions with required ambient behavior remain eager. Phase 4.0 tool proxy stopped with a verified NO-GO because the model bypassed `lazy_agent`. Phase 4.2 succeeded independently: deterministic slash-command dispatch allows `/token-burden` to load and invoke the real captured handler.

## Current Production Configuration

Pi settings keep package skills, prompts, and themes eager while filtering extension code:

```json
{
  "packages": [
    "git:github.com/xulongwu4/pi-lazy-loader@v0.2.0",
    "npm:pi-fabric",
    { "source": "npm:@quintinshaw/pi-dynamic-workflows", "extensions": [] },
    { "source": "npm:pi-token-burden", "extensions": [] },
    { "source": "npm:pi-mcp-adapter", "extensions": [] },
    { "source": "npm:pi-web-access", "extensions": [] }
  ]
}
```

Fabric keeps the loader prompt-visible while retaining ownership of dynamically loaded tools:

```json
{
  "capture": {
    "keepVisible": ["fabric_exec", "lazy_load"]
  }
}
```

All other package entries remain unchanged and eager.

## Implementation Summary

### Phase 0 — Measure Before Building

**Question:** Is startup cost concentrated enough to justify targeted lazy loading?

Phase 0 timed each package in isolation using three runs and the minimum result:

```bash
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi -ne --list-models
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi -ne -e <PACKAGE_DIR> --list-models
```

Results:

- No-extension baseline: **0.565 s**
- Full startup with 36 packages: **5.833 s**
- Extension overhead: **5.268 s**
- Ten packages represented **4.257 s / 80.8%** of measured overhead.
- Approximately 26 packages were below the ~50 ms measurement floor.
- Disabling skills, prompts, themes, and context resources produced no measurable improvement; extension loading accounted for the cost.

This changed the design from a general extension framework to a targeted manifest of measured candidates. Full evidence is in [`../phase0-costs.md`](../phase0-costs.md).

### Phase 1 — Prove Mid-Session Loading

**Question:** Can a package extension be loaded after startup and execute a newly registered tool in the same session without `/reload`?

The successful spike proved:

1. `fabric_exec` was absent before loading.
2. jiti imported the package's default extension factory.
3. The factory received the running Pi `ExtensionAPI`.
4. `fabric_exec` appeared immediately.
5. The model invoked it in the same session and received `42` from `return 40 + 2`.

The working import requirements were:

```ts
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tryNative: false,
  virtualModules: piVirtualModules,
});
const factory = await jiti.import(entryPath, { default: true });
await factory(pi);
```

`virtualModules` is essential. Without it, target packages can resolve a second Pi runtime and fail on incompatible dependency subpaths. Sharing Pi's actual module instances also avoids duplicate `typebox`, TUI, and mutation-queue state.

Phase 1 also established that lifecycle events do not retro-fire. A synthetic `session_start` event was insufficient; late factories need the genuine event and context captured by the eager loader. See [`../PHASE1-VERDICT.md`](../PHASE1-VERDICT.md).

### Phase 2 — Implement the Loader

Phase 2 introduced one deep module, `LazyLoader`, behind a small interface:

```ts
loader.getAllStates();
loader.getPackageState(identifier);
await loader.loadPackage(identifier);
loader.syncConfiguredEager();
```

The implementation hides:

- package source and cache-path resolution;
- `pi.extensions` file/directory discovery;
- jiti configuration and shared virtual modules;
- multi-entry package loading;
- concurrent first-load deduplication;
- idempotent loaded state;
- partial-failure reporting;
- lifecycle-handler capture and replay;
- eager/deferred status reconciliation.

Other focused modules provide internal seams:

| Module | Responsibility |
|---|---|
| `index.ts` | Pi registration, commands, `lazy_load`, Fabric active-set handling |
| `src/loader.ts` | Package state machine, dynamic loading, lifecycle replay |
| `src/resolver.ts` | npm/git package roots and extension-entry discovery |
| `src/settings.ts` | Safe `/lazy pin` settings transformation and atomic write |
| `src/manifest.ts` | Validated manifest parsing and lookup |
| `manifest.json` | Measured package names, sources, costs, and capabilities |

User-facing interface:

- `/lazy list`
- `/lazy add <package>`
- `/lazy pin <package>`
- `lazy_load({ package })`

The loader records one in-flight promise per package, so concurrent requests share work. A package becomes `loaded` only after all declared entries and replayed lifecycle handlers succeed.

### Phase 2.5 — Integration and Dogfood

Phase 2.5 moved from mocks to clean installs and real Pi processes.

Validated behavior:

- packed installation works without checkout-local resolution;
- real `session_start` and `resources_discover` replay works;
- web and MCP tools execute after lazy loading;
- `/lazy list` survives SDK session replacement;
- `session_shutdown: quit` occurs normally;
- settings writes preserve the user's settings symlink;
- eager packages reconcile to `loaded`, preventing duplicate factories.

A material compatibility limit was found: **Fabric cannot safely be loaded late in bundled Pi**. Its capture installer cannot attach to the already-running bundled `ExtensionRunner`, so `pi-fabric` remains eager.

See [`../PHASE2.5-RESULTS.md`](../PHASE2.5-RESULTS.md).

### Phase 3 — Minimal Capability Discovery

The full semantic-discovery idea was not implemented. The smallest useful subset was sufficient:

- `lazy_load` includes a compact intent-to-package description and `promptSnippet`;
- Fabric keeps `lazy_load` visible beside `fabric_exec`;
- web, MCP, subagent, and workflow intents map to manifest package names;
- after dynamic registration, the loader refreshes Fabric's catalog and restores the pre-load active set.

The last point prevents newly registered tools from leaking onto Pi's native active path during the same turn. In Fabric mode, target tools remain callable as `extensions.*`.

### Phase 2.6 — Controlled Expansion and Release

Dynamic workflows passed cold discovery and execution. Interleaved A/B startup measurements produced:

```text
eager workflow: 8.45, 7.43, 7.32, 9.78, 8.08, 6.72
lazy workflow:  6.91, 6.10, 6.74, 6.70, 6.27, 6.01
```

- Minimum improvement: **0.71 s**
- Median improvement: approximately **1.27 s**
- First workflow load during validation: **752 ms**

Subagent deferral was rejected. Multiple delegation prompts bypassed `Agent` and performed the work directly through Fabric; one run falsely claimed a worker read a nonce while the trace showed direct `fabric_exec → read`. Keeping subagents eager was cheaper and safer than adding speculative proxies at that point.

Release history:

| Commit/tag | Outcome |
|---|---|
| `d6c4a50` | Phase 2 implementation |
| `32d5f54` | Real-session validation |
| `1052dbd` / `v0.1.0` | Workflow deferral and Fabric isolation |
| `d1351be` / `v0.1.1` | Optional peers; no duplicate Pi runtime installation |
| `a9f5ed3` | Managed-release documentation |

The exact historical Vertex retry issue was updated with a current 0.84.4 repro and tested remedy: <https://github.com/earendil-works/pi/issues/3218#issuecomment-5541622435>.

See [`../PHASE2.6-RESULTS.md`](../PHASE2.6-RESULTS.md).

## Architectural Decisions

### Keep resources eager and extension code lazy

Pi's object-form package filter is the correct seam:

```json
{ "source": "npm:pi-web-access", "extensions": [] }
```

The package remains managed and available on disk. Skills, prompts, and themes still participate in startup discovery, while expensive extension module graphs do not.

### Reuse Pi's extension contract

The loader does not invent a plugin protocol. It resolves the package's existing `pi.extensions`, imports its default factory, and supplies the live Pi interface.

### Replay real lifecycle events

The eager loader stores the exact lifecycle event and context objects. A proxy records late `pi.on(...)` registrations while still registering them for future events, then replays only lifecycle events that have already occurred.

### Preserve Fabric ownership

Fabric remains eager. When `fabric_exec` is active, `lazy_load` snapshots the active tools, loads the package, forces Fabric's captured catalog to refresh, and restores the prior active set. This keeps the external seam small: callers use `lazy_load`; Fabric continues governing target tools.

### Prefer explicit failure to silent partial state

Unknown packages, missing package roots, unresolved entries, non-function default exports, partial multi-entry failures, lifecycle failures, and ambiguous settings matches return clear errors. No package is marked fully loaded after a partial failure.

## Current Limits

| Category | Policy | Reason |
|---|---|---|
| Fabric | Eager | Must capture the running bundled extension runner |
| LLM wiki | Eager | Automatic recall and observation are ambient behavior |
| Subagents | Eager | Lazy discovery produced verified behavioral bypasses |
| Provider extensions | Eager | Models must exist before model selection/tool use |
| Command-only extensions | Eager unless explicitly proxied | `/token-burden` is deferred behind a permanent deterministic command proxy |
| Ambient extensions | Eager | Background hooks must exist before intent can trigger loading |
| Web, MCP, workflows | Deferred | Explicit capability, verified discovery, safe lifecycle behavior |

## Phase 4 Design

### Status

**Partially implemented.** Phase 4.0 tool proxy stopped at its documented NO-GO; see [`../PHASE4-RESULTS.md`](../PHASE4-RESULTS.md). Phase 4.2 command proxy succeeded independently because slash commands do not depend on model tool selection; see [`../PHASE4-COMMAND-PROXY-RESULTS.md`](../PHASE4-COMMAND-PROXY-RESULTS.md). Phase 4.1 remains cancelled and Phase 4.3 remains unnecessary.

### Entry Criteria

Start Phase 4 only if at least one criterion is met:

1. A package costs at least ~0.3 s at startup and remains a meaningful optimization target.
2. Its behavior is safe after lifecycle replay.
3. Users repeatedly request its capability but `lazy_load` is not selected reliably.
4. Keeping it eager has a measured cost worth more than the added proxy surface.
5. A failing trace demonstrates the exact intent/tool or command that needs deterministic routing.

The rejected subagent trial satisfies criteria 1, 3, and 5 and is the first candidate for a focused spike. It does not yet justify generic heuristics or profiles.

### Goals

- Make selected high-value capabilities deterministic on first use.
- Preserve the target tool or command's real implementation and error behavior.
- Keep target extension code unloaded until the proxy is invoked.
- Preserve Fabric ownership while expanding the active set only with explicitly approved proxy tools. The current set is `fabric_exec` + `lazy_load`; Phase 4.0 would add `lazy_agent`.
- Add negligible startup cost compared with the deferred package.

### Non-Goals

- No natural-language classifier or regex intent engine.
- No attempt to defer Fabric, providers, or ambient wiki behavior.
- No generic plugin framework, daemon, watcher, or cache database.
- No proxy for every tool in the ten-package opportunity map.
- No per-project profile engine while native project settings are sufficient.
- No claim that a registered proxy proves success; the real target operation must execute.

### Proposed Seam: Deferred Capability Proxy

The loader should gain one internal registration-capture seam. While a late factory runs, the existing `ExtensionAPI` proxy already intercepts `pi.on`. Phase 4 would also intercept selected `registerTool` and `registerCommand` calls.

For a deferred proxy tool, register the proxy eagerly and add its name to Fabric `capture.keepVisible`:

```ts
registerDeferredTool({
  proxyName: "lazy_agent",
  package: "@tintinweb/pi-subagents",
  targetTool: "Agent",
  parameters: LazyAgentParameters,
});
```

Invocation flow:

```text
model sees and calls the prompt-visible lazy_agent proxy
  → LazyLoader.loadPackage("@tintinweb/pi-subagents")
  → proxied registerTool captures the real Agent definition
  → all non-proxied tools register normally
  → Fabric catalog refreshes; native active set is restored
  → lazy_agent forwards the original call ID, args, signal, updates, and context
    to the captured Agent.execute
  → subsequent calls reuse the loaded definition
```

The proxy remains permanent rather than relying on ambiguous same-name replacement semantics. For the proxied target name, registration is captured and suppressed; other tools from the package register normally. This creates a small stable interface while hiding loading, registration ordering, Fabric ownership, and forwarding details.

### Why `lazy_agent` Instead of an `Agent` Stub

Using the target name would require an eager copy of the target's large and changing schema and would depend on Pi's collision/replacement behavior. A focused `lazy_agent` interface can expose only the stable fields required for delegation, load the real package, and forward to its captured `Agent.execute` implementation.

If real usage proves that the full `Agent` interface is required, a checked-in schema snapshot could be considered later. It should not be the first implementation because schema drift creates permanent maintenance work.

### Deferred Command Proxy

Command-only packages need a separate seam because unavailable slash commands cannot trigger `lazy_load`.

```ts
registerDeferredCommand({
  command: "goal",
  package: "@narumitw/pi-goal",
});
```

The command proxy would load the package, capture and suppress the target command registration for the same name, then invoke the captured handler with the original argument string and genuine command context. Implement this only after a specific command package passes a spike; tool and command forwarding should not be forced through one abstraction.

### Profiles

Do not add a profile engine initially. Prefer Pi's native global/project settings to choose which package entries use `"extensions": []`.

Add a loader-specific profile file only if native settings cannot express a reproduced requirement. The smallest acceptable shape would be declarative package names only:

```json
{
  "deferred": ["pi-web-access", "pi-mcp-adapter"]
}
```

No inheritance, environment expressions, matching rules, or watchers.

### Rejected Alternative: Automatic Intent Heuristics

A `before_agent_start` handler could scan prompts for words such as “delegate,” “worker,” or “search.” This is rejected because it:

- introduces false positives and language dependence;
- silently loads packages before the model commits to using them;
- duplicates model intent understanding;
- creates a growing keyword configuration surface;
- is harder to verify than a deterministic proxy call.

Use explicit prompt metadata first and a named proxy only for capabilities with measured failures.

### Phase 4 Delivery Plan

#### Phase 4.0 — Subagent Proxy Spike

Build only `lazy_agent` against `@tintinweb/pi-subagents`.

Required proof:

1. Subagents are configured with `"extensions": []`.
2. A cold request from outside this repository selects `lazy_agent` without naming the package.
3. A worker reads an unknown nonce; the parent does not read it directly.
4. Trace contains the real captured `Agent.execute` call.
5. Active tools are exactly `fabric_exec`, `lazy_load`, and `lazy_agent` before and after target loading.
6. First and repeated calls succeed in the same session.

A diagnosed NO-GO is acceptable and ends Phase 4.

#### Phase 4.1 — Harden the Proxy Seam

Proceed only if Phase 4.0 passes. Add focused checks for:

- concurrent first calls sharing one package-load promise;
- captured target registration exactly once;
- call ID, parameters, abort signal, update callback, and context forwarded unchanged;
- target errors returned without lossy wrapping;
- load failure remaining visible and retriable;
- no duplicate tool names or native-path leaks;
- session replacement and shutdown after a proxied call.

#### Phase 4.2 — Command Proxy Spike

Implemented for `pi-token-burden`. The permanent `/token-burden` proxy reserves the target registration, loads the package on first use, suppresses the duplicate target registration, and invokes the captured handler with the original argument string and genuine command context. A tmux acceptance test opened the real Token Burden overlay.

#### Phase 4.3 — Project Configuration

Use native project settings first. Add the minimal `deferred` file only if two real projects require different sets and native settings cannot represent them safely.

### Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Tool schema drift | Use a narrow named proxy first; avoid copying full target schemas |
| Duplicate registration | Suppress only the captured target registration; keep the proxy permanent |
| Incorrect forwarding | Assert identity of signal/context and preserve update/error semantics |
| Same-turn Fabric leak | Refresh Fabric catalog, then restore the pre-load active set |
| Partial package load | Retain existing package-level failed state and entry diagnostics |
| Lifecycle dependency | Reuse genuine captured lifecycle events; reject unreplayable packages |
| Ambient behavior loss | Keep ambient packages eager rather than proxying individual tools |
| More startup overhead than savings | Measure proxy-only startup before rollout; abandon if net gain is negligible |

### Acceptance Criteria

Phase 4 is complete only when all applicable criteria pass:

- deterministic unknown-nonce proof uses a real worker or target command;
- no direct parent fallback is misreported as delegated work;
- first call lazy-loads once; concurrent calls share that load;
- repeated calls avoid reload and preserve target behavior;
- Fabric exposes only the explicitly approved eager tools;
- lifecycle replay produces no bootstrap errors;
- clean packed installation contains no duplicate Pi runtime;
- interleaved A/B startup demonstrates a positive net saving;
- settings and Fabric configuration have tested atomic rollback paths;
- public documentation names supported proxies and eager-only categories.

### Stop Conditions

Stop Phase 4 and keep the package eager if any of these remain unresolved after the focused spike:

- the target's schema cannot be represented without copying most of it;
- the target depends on unreplayable startup state;
- tool/command registration cannot be captured without global monkey-patching;
- Fabric ownership cannot be preserved during the first call;
- model behavior still bypasses the proxy;
- measured savings do not justify the new interface.

## Recommended Next Action

Keep `@tintinweb/pi-subagents` eager; do not resume tool-proxy work unless the unknown-nonce acceptance test passes after a future Pi/Fabric change. Retain the successful `/token-burden` command proxy. Native settings remain sufficient, so no profile engine is needed.
