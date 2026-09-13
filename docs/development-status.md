# pi-lazy-loader Development Status

**Updated:** 2026-09-13
**Released version:** `v0.9.0`
**Release reference:** `v0.9.0`

## Executive Status

`pi-lazy-loader` v0.9.0 is implemented, verified, and tagged. Cached tool proxies are now load-then-invoke: when the cached contract is safe (JSON-representable object schema, no `prepareArguments`, and live schema/`executionMode`/`constrainedSampling` deep-equal the cache after load), the proxy loads the package and executes the captured tool on the first deferred call, eliminating the previous mandatory retry round-trip. The cache now stores full tool parameter schemas plus execution metadata, guarded by `isCachedToolSchema`, `schemaIsJsonRepresentable` (fails closed on cycles, functions, symbols, non-finite numbers, class instances, and unknown TypeBox `~` keys), `cloneJsonValue`, and `schemasEquivalent`. Unsafe or drifted contracts return `executed: false` `retryHandoff`; missing tools and failed loads stay terminal (`cacheDrift` / `loadFailure`). Late reserved tool/command registrations gained the same commit/stage path as commands (`commitReservedTool`), a typed `CacheDriftError`, debounced per-package cache refreshes, and `getAllTools`/`getActiveTools` interception so uncommitted reserved names stay hidden from skip-if-registered factories.

`pi-lazy-loader` v0.8.2 is implemented, independently reviewed, merged to `main`, and tagged. During intercepted package load, `getCommands()` hides this package's uncommitted reserved command proxies so skip-if-registered factories (notably pi-dynamic-workflows builtins such as `/deep-research`) still call `registerCommand`. Protected foreign owners and already-observed names stay visible, so a replayed `session_start` does not re-register and abort, and `refreshCache` does not drop or steal those names.

`pi-lazy-loader` v0.8.1 is implemented, independently reviewed, merged to `main`, tagged, and pushed. It isolates the Pi late-load ABI in `src/pi-host.ts`: `getAgentDir`, `resolvePackageRoot`, the `jiti` `virtualModules` wiring, missed-lifecycle replay, and `:N` occupancy handling for visible command names now live behind one host boundary instead of being spread across `src/loader.ts`, `src/resolver.ts`, and `index.ts`. Behavior is unchanged; the extraction narrows the surface that must be revisited when Pi's runtime ABI shifts.

`pi-lazy-loader` v0.8.0 is implemented, independently reviewed, merged to `main`, tagged, and pushed. It removes the LLM-facing `lazy_load` tool. Cached real-name tool proxies load deferred extensions; `/lazy add`, cache bootstrap, command proxies, and `LazyLoader.loadPackage()` remain. Fabric `keepVisible` is only `fabric_exec`.

`pi-lazy-loader` v0.7.1 is implemented, independently reviewed on both axes, merged to `main`, tagged, and pushed. It fixes a startup crash present in v0.7.0: calling `pi.getCommands()` during extension loading threw `Extension runtime not initialized`, so Pi refused to start with `pi-lazy-loader` installed. Command proxy registration now happens in `session_start` (where action methods are legal) against the complete command set, keeping conflict outcomes deterministic and order-independent with no numeric-suffix duplicates.

## v0.7.0 Architecture

### Package Discovery

`${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json` is the sole lazy package catalog. Entries may be source strings or objects with optional `commands` and `tools` proxy allowlists. Package identity comes from the installed `package.json`; Pi settings are not inspected and `manifest.json` is not shipped.

### Unified Cache

The cache is `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader-cache.json`:

```json
{
  "version": 1,
  "packages": {
    "example-package": {
      "tools": [{ "name": "example_tool", "description": "Example tool" }],
      "commands": [{ "name": "example-command", "description": "Example command" }]
    }
  }
}
```

- A missing or incomplete package entry causes one eager load during `session_start`.
- Every successful load replaces the package entry with all observed `registerTool` and `registerCommand` registrations.
- Tools or commands registered later through captured lifecycle handlers also refresh the entry.
- A failed eager bootstrap writes an empty complete entry to avoid blocking every later startup. Use `/lazy add <package>` to retry explicitly, or remove that package entry from the cache before restarting.
- The obsolete `lazy-loader-tools.json` file is ignored, so the first v0.7.0 session performs a fresh bootstrap.

### Proxy Behavior

- Cached command names receive lightweight slash-command proxies. Their first invocation loads the package and invokes the captured real handler immediately.
- Cached tool names receive load-then-invoke proxies when the cached contract is safe (JSON schema, no `prepareArguments`, live schema/options match). Otherwise the first call loads/registers and returns `executed: false` `retryHandoff`; the model must call again against the live host schema. Missing tools and failed loads stay terminal (`cacheDrift` / `loadFailure`).
- Package loads remain idempotent and concurrent callers share one in-flight promise.
- Reserved registrations are staged so failed multi-entry loads do not displace startup proxies.

## Review and Verification

The v0.8.2 change was reviewed by parallel `anthropic/claude-opus-5` and `openai-codex/gpt-5.6-sol` subagents. Round 1 requested changes (the filter stayed after staging so `session_start` replay re-registered and aborted; protected names were hidden so a foreign owner could be claimed in the cache; Check 4b covered only the happy path). Round 2 returned:

- **Standards:** `APPROVE` — zero blocking findings.
- **Specification:** `APPROVE` — zero blocking findings.

The v0.8.1 extraction was reviewed on both axes:

- **Standards:** `APPROVED` — zero blocking findings.
- **Specification:** `APPROVED` — pure extraction, no behavior change and no scope creep.

The v0.8.0 change was implemented by an `xai/grok-4.6` subagent and revised after parent review. Final parent review and parallel `anthropic/claude-opus-5` reviews returned:

- **Standards:** `APPROVED` — zero blocking findings.
- **Specification:** `APPROVED` — every requested behavior verified with no scope creep.

An `openai-codex/gpt-5.6-sol` subagent used the two-axis `code-review` skill against the v0.7.1 diff. Round 1 requested changes on both axes (optimistic load-time registration risked `/name:1` suffixes; first-wins policy, order dependence, double notification). Round 2 requested changes (suffix-base indexing, fail-safe catch notification, report refresh). Round 3 returned:

- **Standards:** `APPROVED` — zero blocking findings (later-handler collision window downgraded to residual risk: no in-repo extension registers commands from `session_start`; shape matches the shipped tool-proxy precedent).
- **Specification:** `APPROVED` — zero blocking findings (Rule 9 once-only notification verified by an extended Check 6.2).

The v0.7.0 review history is preserved below. An `anthropic/claude-opus-5` subagent used the two-axis `code-review` skill. Its first pass requested changes; after atomic cache writes, command-collision protection, filter edge coverage, schema restoration, dead-code removal, and pin normalization, its second pass returned:

- **Standards:** `APPROVE` — zero blocking findings.
- **Specification:** `APPROVE` — zero blocking findings.

Verified release gates:

- Explicit TypeScript checking for `index.ts`, `src/*.ts`, and active checks.
- Bun bundle build.
- `bun run check:command`.
- `bun run check:proxy`, including configured command declarations, exact package allowlist, and clean packed install.
- `bun run check:v050`, including explicit package discovery, proxy allowlists, missing-cache bootstrap, complete command/tool capture, concurrent cache writers, failure markers, command/tool collisions, and Fabric restoration.
- Core `bun run check` checks 1–3 pass. Its external-model Check 4 is currently blocked by an invalid configured Google API key, not a repository failure.

## Published Files

The v0.7.0 package allowlist contains 13 files:

```text
README.md
index.ts
lazy-loader.schema.json
package.json
src/cache.ts
src/command-config.ts
src/command-presentation.ts
src/config.ts
src/loader.ts
src/package-locator.ts
src/package.ts
src/resolver.ts
src/tool-proxy.ts
```

## Release History

| Version | Result |
|---|---|
| `v0.1.0` | Initial targeted lazy loading |
| `v0.1.1` | Optional Pi peer dependencies |
| `v0.2.0` | Deterministic token-burden command proxy |
| `v0.2.1` | Real command-definition handoff |
| `v0.3.0` | Generic command proxies and grouped user configuration |
| `v0.3.1` | Tool-cache prompt guidance and sticky failures |
| `v0.3.2` | Tool metadata and Pi ABI fingerprints |
| `v0.3.3` | Managed-install Pi ABI fallback |
| `v0.3.4` | Symlink-aware Pi CLI resolution |
| `v0.4.0` | Two-tier direct tool proxies |
| `v0.5.0` | Consolidated load-and-retry tool proxies |
| `v0.6.0` | Settings-driven packages and unified command/tool cache |
| `v0.7.0` | Explicit lazy-loader catalog, proxy allowlists, atomic cache updates, and command collision protection |
| `v0.7.1` | Fix startup crash (`Extension runtime not initialized`): reserve command names at load, register proxies in `session_start` against the complete command set; suffix-base suppression, fail-safe unbound-runtime handling, report refresh; Check 6 post-bind collision coverage |
| `v0.8.0` | Remove LLM-facing `lazy_load`; cached real-name tool proxies load deferred packages; Fabric `keepVisible` is only `fabric_exec` |
| `v0.8.1` | Isolate the Pi late-load ABI in `src/pi-host.ts` (`getAgentDir`, `resolvePackageRoot`, `jiti` `virtualModules`, lifecycle replay, `:N` occupancy) |
| `v0.8.2` | Hide uncommitted reserved command proxies from `getCommands()` during load so skip-if-registered factories still capture; protected and already-observed names stay visible |

## Known Limitations

- Configuration currently reads only the global agent-directory `lazy-loader.json`; project-local overrides are not merged.
- The loader does not prevent Pi from eagerly loading the same extension; Pi package settings must be configured separately.
- Cache keys use the installed package name. Two deferred sources declaring the same package name cannot coexist and the later setting wins.
- A failed-bootstrap marker suppresses automatic retries until `/lazy add <package>` is used or the cache entry is removed.
- Fabric and provider/ambient extensions that must initialize before model selection should remain eager.

## Current Decision

`v0.8.2` is the active release baseline. During intercepted package load, `getCommands()` hides uncommitted reserved command proxies so skip-if-registered factories still call `registerCommand`; protected foreign owners and already-observed names stay visible. All Pi late-load ABI contact points remain isolated in `src/pi-host.ts`. There is no LLM-facing `lazy_load` tool; cached real-name proxies load deferred packages. `lazy-loader.json` remains the explicit package catalog and optional command/tool proxy allowlist; Pi `settings.json` is not inspected. Upgrade the managed package reference (`git:github.com/xulongwu4/pi-lazy-loader@v0.8.2`) and reload existing Pi sessions; the first session eagerly rebuilds the unified cache, and subsequent sessions defer cached packages normally.
