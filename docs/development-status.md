# pi-lazy-loader Development Status

**Updated:** 2026-09-07
**Repository:** <https://github.com/xulongwu4/pi-lazy-loader>  
**Released version:** `v0.5.0`
**Release reference:** `v0.5.0`

## Executive Status

`pi-lazy-loader` v0.5.0 is implemented, reviewed, released, and pushed. `main`, `origin/main`, and annotated tag `v0.5.0` point to the reviewed load-and-retry proxy implementation. The current managed production setting remains on v0.4.0 until explicitly upgraded; sessions require `/reload` after that upgrade.

The loader currently supports three complementary lazy-loading paths:

1. **Direct tool proxies:** real-name load-and-retry startup proxies load their package on invocation, publish real tools, and ask the model to retry using the loaded schema without executing the original call.
2. **LLM tool loading:** the prompt-visible `lazy_load` tool independently imports a selected package on demand; it does not prescribe tool retries.
3. **Slash-command proxies:** lightweight startup commands load deferred packages before invoking their real handlers. v0.3.0 supports manifest-driven and user-configured command declarations.

The validated production configuration defers four extension packages while keeping their skills, prompts, themes, and installed files available:

- `pi-web-access`
- `pi-mcp-adapter`
- `@quintinshaw/pi-dynamic-workflows`
- `pi-token-burden`

`pi-fabric`, `@tintinweb/pi-subagents`, wiki/ambient extensions, and provider extensions remain eager for correctness.

## Release History

| Version | Commit | Result |
|---|---|---|
| `v0.1.0` | `1052dbd` | Initial targeted lazy loading and workflow validation |
| `v0.1.1` | `d1351be` | Optional peer dependencies; removed duplicate Pi runtime installation |
| `v0.2.0` | `5572202` | Deterministic `/token-burden` command proxy |
| `v0.2.1` | `5be632a` | Target command-definition/description handoff |
| `v0.3.0` | `82488c4` | Manifest-driven/user-configured command proxies, MCP matrix, atomic staged commit, review hardening |
| `v0.3.1` | `6988909` | Tool-cache prompt generation, bounded prompt budget, item boundary truncation, sticky session failure |
| `v0.3.2` | `05a88c6` | Tool metadata capture harvest, JSON serialization safety, Pi ABI fingerprinting, cache v2 format |
| `v0.3.3` | `b304e11` | Managed-install Pi ABI fallback through the running CLI entrypoint |
| `v0.3.4` | `36db2d4` | Resolve the symlinked Pi CLI entrypoint before walking to its package metadata |
| `v0.4.0` | `e9f917f` | Two-tier real-name tool proxies with faithful forwarding and announce-and-retry fallback |
| `v0.5.0` | `v0.5.0` | Single load-and-retry real-name tool proxies, cache v3 simplification, and generic `lazy_load` guidance |

## Phase Status

| Phase | Status | Outcome |
|---|---|---|
| Phase 0 — Cost profiling | Complete | 36 packages measured; extension loading identified as the startup cost |
| Phase 1 — Dynamic-loading spike | Complete | Newly loaded `fabric_exec` executed in the same session |
| Phase 2 — Loader implementation | Complete | jiti loading, state machine, lifecycle replay, `/lazy`, and `lazy_load` |
| Phase 2.5 — Integration dogfood | Complete | Clean install, Fabric topology, session lifecycle, web/MCP validation |
| Phase 2.6 — Controlled expansion | Complete | Workflows retained deferred; subagents restored eager |
| Phase 3 — Minimal discovery | Complete | Prompt metadata plus Fabric-visible `lazy_load`; no semantic classifier |
| Phase 4.0 — Model-selected tool proxy | Stopped / NO-GO | `lazy_agent` was bypassed; no tool-proxy runtime shipped |
| Phase 4.2 — Command proxy | Complete | `/token-burden` and generic command handoff proven |
| Phase 4.3 / v0.3.0 | Complete | Grouped user config, MCP command proxies, provenance UX, release gates |
| Phase 5 prereqs / v0.3.1 | Complete | Tool-cache prompt guidance, bounded prompt budget, item boundary truncation, sticky failure, diagnostic cleanup |
| Phase 5 prereqs / v0.3.2 | Complete | Tool metadata harvest (eight fields), prepareArguments flag, Pi ABI fingerprint, cache v2 compatibility |
| Phase 5 prereqs / v0.3.3 | Complete | Resolve Pi ABI from the running CLI when managed git installs cannot resolve the peer dependency |
| Phase 5 prereqs / v0.3.4 | Complete | Resolve `~/.local/bin/pi` symlink before the managed-install ABI fallback walk |
| Phase 5 / v0.4.0 | Complete | Tier 1 same-call execution for static web tools; Tier 2 load-and-retry floor for workflows and MCP gateway tools |
| Phase 5 consolidation / v0.5.0 | Complete | Single load-and-retry tool proxies with package activation and real-tool displacement |

## Production Configuration

### Managed Package

Pi settings reference the tagged release:

```text
git:github.com/xulongwu4/pi-lazy-loader@v0.4.0
```

The managed checkout reports package version `0.4.0`.

### Deferred Packages

`~/.pi/agent/settings.json` currently contains `"extensions": []` for:

```json
[
  "npm:@quintinshaw/pi-dynamic-workflows",
  "npm:pi-token-burden",
  "npm:pi-mcp-adapter",
  "npm:pi-web-access"
]
```

`pi-fabric` and `@tintinweb/pi-subagents` remain eager.

### Fabric Visibility

`~/.pi/agent/fabric.json` keeps two tools model-visible:

```json
{
  "capture": {
    "keepVisible": ["fabric_exec", "lazy_load"]
  }
}
```

This lets the model discover lazy loading while Fabric retains ownership of dynamically registered extension tools.

### User Command Configuration

`~/.pi/agent/lazy-loader.json` is a symlink to:

```text
~/Documents/dotfiles/snowblocks/pi/lazy-loader.json
```

Current contents declare:

```json
{
  "$schema": "https://raw.githubusercontent.com/xulongwu4/pi-lazy-loader/v0.3.0/lazy-loader.schema.json",
  "version": 1,
  "packages": {
    "pi-mcp-adapter": {
      "commands": ["mcp", "pi-mcp", "mcp-auth"]
    },
    "pi-token-burden": {
      "commands": ["token-burden"]
    }
  }
}
```

These declarations repeat built-in v0.3.0 metadata intentionally and can later override descriptions or add declarations for other packages already present in `manifest.json`.

The dotfiles repository currently has uncommitted configuration changes:

```text
M  snowblocks/pi/fabric.json
M  snowblocks/pi/settings.json
?? snowblocks/pi/lazy-loader.json
```

## Implemented Capabilities

### Package Discovery and Loading

- Fixed manifest of ten measured package candidates.
- npm and git package-cache resolution under `PI_CODING_AGENT_DIR` or the normal user agent directory.
- File and directory `pi.extensions` entry resolution.
- jiti TypeScript/JavaScript loading with `{ default: true }`.
- Pi runtime sharing through `virtualModules`; no duplicate Pi/typebox/TUI instances.
- One in-flight promise per package and idempotent successful loads.
- Multi-entry loading with explicit failure state.

### Lifecycle Replay

- Captures real `session_start` and `resources_discover` events and contexts.
- Intercepts late `pi.on(...)` registrations.
- Replays missed lifecycle handlers before package load is committed.
- Preserves future event registrations.

### LLM Tool Interface

`lazy_load` is always available as a concise generic interface for loading a deferred Pi extension package on demand. It does not enumerate packages or tools and does not discuss retry behavior; direct tool proxies own the retry instruction.

Failed loads are sticky for the remainder of the session: subsequent `lazy_load` calls fail fast without re-entering the load path, directing the user or agent to `/reload` or restart the session.

After loading, the result reports package name, source, duration, new tool names, and whether it was already loaded. Pi refreshes tool registrations immediately. Under Fabric, target tools become callable through `extensions.*` while the native active set remains controlled.

The full manifest and user command configuration are not injected into the LLM prompt.

### Direct Tool Proxies

Declared tool names are registered during `session_start`, after Pi action methods become available and before the first model turn.

| Package | Tool | Mode | First invocation |
|---|---|---:|---|
| `pi-web-access` | `web_search`, `fetch_content`, `get_search_content`, `source_check` | Load-and-retry | Loads package, does not execute tool, requests retry |
| `@quintinshaw/pi-dynamic-workflows` | `workflow`, `workflow_control` | Load-and-retry | Loads package, does not execute tool, requests retry |
| `pi-mcp-adapter` | `mcp`, `mcpScript` | Load-and-retry | Loads package, does not execute tool, requests retry |

A proxy description prefers the cached real tool description (from the v3 advisory cache) and falls back to the manifest package capability. It explains that invoking the proxy loads the package and that the real tool must be called again afterward.

Proxy execution loads the package, never executes or echoes the original tool arguments, and returns structured details (`loaded: true`, `executed: false`, `package`, `retryTool`). `LazyLoader` publishes staged real tools so they displace the startup proxies. Failed loads leave proxies intact (atomicity). Missing declared tools are tracked so `lazy_load` can warn; surviving proxies in loaded state return terminal manifest drift errors with no retry loop, and failed loads return terminal reload guidance.

Configuration-derived `mcp__*` tools are intentionally outside the initial static rollout.

### Slash-Command Proxies

Built-in command declarations:

| Package | Commands |
|---|---|
| `pi-token-burden` | `/token-burden` |
| `pi-mcp-adapter` | `/mcp`, `/pi-mcp`, `/mcp-auth` |

Startup behavior:

1. Parse and merge built-in declarations with optional grouped user configuration.
2. Register lightweight command stubs only for globally deferred packages.
3. Return `null` for argument completions without loading a package.

First invocation:

1. Load all target package entries.
2. Stage reserved target command registrations.
3. Replay missed lifecycle events.
4. Commit nothing if any entry/replay fails, leaving startup stubs intact.
5. On success, atomically forward shallow-cloned target options through Pi's public API.
6. Preserve target handlers/completions by reference and decorate only the description.
7. Invoke the captured real handler for the already-running first call.

Subsequent invocations use the forwarded real command definition directly. Duplicate target registrations are diagnosed and abort the atomic handoff.

### User Configuration

- Optional global `${PI_CODING_AGENT_DIR}/lazy-loader.json`.
- Grouped by package name/manifest alias.
- String shorthand and object command declarations may be mixed.
- User descriptions override built-in descriptions for the same command.
- Optional `targetLabel` is supplemental; the resolved manifest package name remains visible.
- Strict names, lengths, control-character rejection, 64 KiB limit, schema versioning, and unknown-field rejection.
- Invalid files or entries fail softly with stderr/UI diagnostics; valid built-ins continue.
- Configuration takes effect after `/reload` or restart; no watcher.

### Provenance

Pi does not allow extensions to supply canonical command `sourceInfo`. Proxy commands therefore remain canonically attributed to `pi-lazy-loader`.

Descriptions provide honest delegated provenance:

```text
Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]
```

After handoff, the real target description is retained and decorated:

```text
<real description> [target: pi-mcp-adapter; via pi-lazy-loader]
```

No Pi internals or command maps are mutated directly.

## Verification Status

### Deterministic Checks

Current release verification includes:

- TypeScript compilation of `index.ts`, `src/*.ts`, and `checks/*.ts`.
- Base resolver/state/settings checks.
- Phase 4 command capture/forwarding checks.
- Manifest and user-config validation/merge tests.
- Production registrar pre-load completion test.
- Concurrent first-load and exact handler/context forwarding tests.
- Staged atomic failure and duplicate registration tests.
- Command readiness and provenance formatting tests.
- Exact package-file allowlist and clean packed consumer install.
- v0.5.0 load-and-retry proxy regression suite.
- Proxy-triggered loading, non-execution/privacy, retry guidance, staged real-tool displacement, concurrent load deduplication, drift guards, failed-load preservation, and eager collision protection.

The final verification mutation-tested five essential behaviors by deliberately breaking them; every mutation was caught:

- staged atomicity;
- provenance decoration;
- command readiness;
- duplicate target registration;
- production pre-load completions.

### Real TUI Matrix

Isolated detached tmux verification passed:

- `/token-burden` opened the real Token Burden overlay.
- `/mcp` opened the real MCP Servers panel.
- `/pi-mcp` reopened the real MCP Servers panel without reloading.
- `/mcp-auth missing-server` executed the real handler and returned a safe missing-server error without opening OAuth.
- No `token-burden:1`, `mcp:1`, `pi-mcp:1`, or `mcp-auth:1` duplicates appeared.
- Canonical source remained `pi-lazy-loader`; descriptions showed target attribution.

Production configuration was also smoke-tested after installing v0.3.0:

```text
/mcp=PASS
/token-burden=PASS
duplicates=none
```

Superseded two-tier v0.4.0 fresh-process evidence (retained for history):

- Non-Fabric direct `web_search`, with no `lazy_load`, loaded `pi-web-access` and returned a real result on the original call.
- Fabric `fabric_exec -> extensions.web_search`, with no `lazy_load`, returned a real result on the original call.
- Direct `workflow` produced exactly one observed `workflow` call, loaded the package, reported `executed: false`, and did not execute before retry.
- Managed v0.3.4 metadata harvest fingerprinted the live Pi ABI as `0.85.0`; earlier `unknown` fingerprints led to the symlink-aware resolver fix.
- `openai-codex/gpt-5.6-sol` issued three high-severity race/bypass findings during v0.4.0 review; all received behavioral regressions, and the final verdict was `APPROVE`.

v0.5.0 release verification:

- `bun run check:v050` passed proxy-triggered loading, retry guidance, cache v3, drift, collision, concurrency, and Fabric restoration checks.
- Core, command-proxy packaging, command delegation, TypeScript, and `git diff --check` checks passed.
- The live model E2E remained externally blocked by Gemini HTTP 429 quota; deterministic and clean-package checks passed.

### Performance

Original Phase 0 baseline:

- No extensions: **0.565 s**
- Full 36-package startup: **5.833 s**
- Measured extension overhead: **5.268 s**

Focused v0.3.0 A/B comparison for MCP and token-burden:

- Independent eager median: **1.168 s**
- Independent lazy median: **0.665 s**
- Independent median saving: **0.503 s**

The first release-evidence run measured approximately **0.667 s** median saving. Every alternating A/B pair in both runs favored deferred loading.

### Packaging

The v0.5.0 package allowlist contains exactly 13 runtime files:

```text
README.md
index.ts
lazy-loader.schema.json
manifest.json
package.json
src/command-config.ts
src/command-presentation.ts
src/loader.ts
src/manifest.ts
src/resolver.ts
src/settings.ts
src/tool-cache.ts
src/tool-proxy.ts
```

Clean install includes `jiti` and zero duplicate `@earendil-works` Pi peer packages.

## Known Limitations

### Partial `extensions` Arrays

The loader treats any non-empty `extensions` array as eager for the entire package. If a partial array excludes the entry that registers a declared command, no proxy is created and the command may be missing. v0.3.1 now emits a startup diagnostic rather than failing silently, but does not auto-correct the setting. Use either fully eager package configuration or exactly `"extensions": []` for proxied packages.

### Global Settings Scope

The loader reads global agent-directory settings only. It does not merge project-level `.pi/settings.json` package overrides. Project overrides can therefore disagree with proxy registration.

### Tool Proxy Coverage

Load-and-retry proxies cover the eight statically declared tool names above. Invoking one loads its package and asks the model to retry the now-real tool. Configuration-derived `mcp__*` tools have no startup proxies, so they still require explicit `lazy_load`, a declared gateway proxy, or future configuration-aware declarations.

### Subagent Tool Proxy

The Phase 4.0 `lazy_agent` experiment failed. Even when visible, the model bypassed the proxy and performed work directly through Fabric. Subagents remain eager.

### Fabric

Fabric must remain eager so its capture interceptor attaches to the running bundled `ExtensionRunner`. Loading Fabric late registers `fabric_exec` but does not preserve exclusive captured-tool ownership.

### Providers and Ambient Extensions

Provider extensions need to register models before selection. Wiki and similar ambient extensions need their startup hooks. These remain eager.

### Dynamic MCP Prompt Commands

MCP prompt-derived slash commands appear only after `pi-mcp-adapter` first loads. Only declared `/mcp`, `/pi-mcp`, and `/mcp-auth` proxies exist before then.

### Proxy Attribution

Canonical command `sourceInfo` remains `pi-lazy-loader`; target attribution is textual until Pi provides a delegated-provenance API.

### User Configuration Package Scope

`lazy-loader.json` may declare commands only for packages already present in the built-in manifest. It cannot add arbitrary source paths or executable code.

### Vertex Retry Patch

The local Pi installation contains a hot patch adding `request to .* failed` to the retry classifier. It is outside this repository and can be overwritten by a Pi update. Current upstream evidence is at:

<https://github.com/earendil-works/pi/issues/3218#issuecomment-5541622435>

## Remaining Work

### Immediate Activation and Soak

1. Upgrade the managed package setting from `v0.4.0` to `v0.5.0`, then run `/reload`.
2. Invoke `web_search`, `workflow`, and `mcp`/`mcpScript` directly without pre-calling `lazy_load`.
3. Watch stderr/UI diagnostics for eager-name collisions or manifest drift.
4. Dogfood all four deferred packages across normal interactive sessions before expanding the rollout.

### Recommended v0.5.x Observability

1. Add proxy status to `/lazy list`.
2. Measure startup latency against `v0.3.4`, prompt/schema token overhead, and first-call guidance/retry rates.
3. Maintain load-and-retry proxies for declared gateway tools.

### Operational Work

1. Commit the pending dotfiles changes for `settings.json`, `fabric.json`, and `lazy-loader.json`.
2. Monitor the upstream Vertex retry issue and remove the hot patch after an official release includes the fix.
3. Preserve rollback backups through the v0.5.0 soak.

### Deferred Work

- Configuration-derived `mcp__*` tool proxies require explicit configuration-aware declarations; do not expose cached names automatically.
- Native delegated `sourceInfo` requires an upstream Pi API.
- Project-aware effective settings require a supported merged-settings seam.
- Additional command or tool proxies require individual lifecycle/TUI proof.

## Key Documentation

- [`README.md`](../README.md) — installation, configuration, behavior, rollback
- [`phase0-costs.md`](../phase0-costs.md) — per-package measurements
- [`PHASE1-VERDICT.md`](../PHASE1-VERDICT.md) — dynamic loading proof
- [`PHASE2.5-RESULTS.md`](../PHASE2.5-RESULTS.md) — integration dogfood
- [`PHASE2.6-RESULTS.md`](../PHASE2.6-RESULTS.md) — controlled expansion
- [`PHASE4-RESULTS.md`](../PHASE4-RESULTS.md) — failed tool-proxy experiment
- [`PHASE4-COMMAND-PROXY-RESULTS.md`](../PHASE4-COMMAND-PROXY-RESULTS.md) — command/MCP proof
- [`command-proxy-development-requirements.md`](command-proxy-development-requirements.md) — v0.3.0 requirements
- [`../reviews/v0.2.1-to-head.md`](../reviews/v0.2.1-to-head.md) — review findings
- [`../reviews/v0.3.0-resolution.md`](../reviews/v0.3.0-resolution.md) — review resolution map

## Current Decision

`v0.5.0` is the active release baseline. Upgrade the managed setting, reload existing sessions, and soak the three declared proxy paths before broadening coverage. A later v0.5.x may add `/lazy list` proxy observability; configuration-derived `mcp__*` names remain deferred until a configuration-aware design exists.
