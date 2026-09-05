# pi-lazy-loader Development Status

**Updated:** 2026-09-05
**Repository:** <https://github.com/xulongwu4/pi-lazy-loader>  
**Released version:** `v0.3.3`
**Release commit:** tag `v0.3.3`

## Executive Status

`pi-lazy-loader` is implemented, released, installed, and active in production configuration. The repository working tree was clean before this document was added; `main`, `origin/main`, and annotated tag `v0.3.0` all point to the verified release history.

The loader currently supports two complementary lazy-loading paths:

1. **LLM tool loading:** the prompt-visible `lazy_load` tool imports selected package extensions on demand and immediately refreshes the available tool catalog.
2. **Slash-command proxies:** lightweight startup commands load deferred packages before invoking their real handlers. v0.3.0 supports manifest-driven and user-configured command declarations.

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
| `v0.3.3` | tag `v0.3.3` | Managed-install Pi ABI fallback through the running CLI entrypoint |

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

## Production Configuration

### Managed Package

Pi settings reference the tagged release:

```text
git:github.com/xulongwu4/pi-lazy-loader@v0.3.0
```

The managed checkout reports package version `0.3.0`.

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

`lazy_load` is always available and dynamically advertises deferred packages along with their cached tools (`lazy-loader-tools.json`), degrading to manifest capabilities when the cache is empty.

Total generated prompt text across description, snippet, guidelines, and parameter description is strictly bounded by `MAX_LAZY_LOAD_PROMPT_BUDGET` (1200 characters). When deferred packages or tool lists exceed this budget, truncation drops whole list items cleanly and appends an honest marker like `(+N more, see /lazy list)` rather than cutting words or tool names in half.

Failed loads are sticky for the remainder of the session: subsequent `lazy_load` calls fail fast without re-entering the load path, directing the user or agent to `/reload` or restart the session.

After loading, the result reports package name, source, duration, new tool names, and whether it was already loaded. Pi refreshes tool registrations immediately. Under Fabric, target tools become callable through `extensions.*` while the native active set remains controlled.

The full manifest and user command configuration are not injected into the LLM prompt.

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

The v0.3.0 package allowlist contains exactly 11 runtime files:

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
```

Clean install includes `jiti` and zero duplicate `@earendil-works` Pi peer packages.

## Known Limitations

### Eager Command Readiness Display

When a package has command declarations but is configured eagerly, the real commands work and are attributed to the real package. However, `/lazy list` may currently display those commands as `missing` because readiness checks the loader's captured-command map, which eager commands bypass.

Expected future display:

```text
/mcp [ready (eager)]
```

### Partial `extensions` Arrays

The loader treats any non-empty `extensions` array as eager for the entire package. If a partial array excludes the entry that registers a declared command, no proxy is created and the command may be missing.

Use either fully eager package configuration or exactly `"extensions": []` for command-proxied packages.

### Global Settings Scope

The loader reads global agent-directory settings only. It does not merge project-level `.pi/settings.json` package overrides. Project overrides can therefore disagree with proxy registration.

### LLM Capability Discovery

The LLM sees four hardcoded intent mappings in `lazy_load`; it does not receive the complete manifest or dynamically generated capability guidance. Missing tools outside those mappings may not trigger the correct package load.

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

### Recommended v0.3.1 Fixes

1. Correct `/lazy list` readiness for eagerly loaded real commands.
2. Detect or explicitly reject partial non-empty `extensions` filters for command-proxied packages.
3. Generate `lazy_load` capability guidance from manifest data instead of maintaining four hardcoded mappings.

### Operational Work

1. Commit the pending dotfiles changes for `settings.json`, `fabric.json`, and `lazy-loader.json`.
2. Dogfood all four deferred packages across normal interactive sessions.
3. Monitor the upstream Vertex retry issue and remove the hot patch after an official release includes the fix.
4. Preserve existing rollback backups until v0.3.0 has completed a longer production trial.

### Deferred Work

- Native delegated `sourceInfo` requires an upstream Pi API.
- Project-aware effective settings require a supported merged-settings seam.
- Additional command proxies require individual lifecycle/TUI proof.
- Do not resume model-selected tool proxies until the unknown-nonce subagent acceptance test passes.

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

`v0.3.0` is the active stable baseline. No further broad lazy-loading phase is planned. The next justified release is a focused `v0.3.1` addressing eager command readiness, partial extension filters, and manifest-derived LLM guidance, followed by continued dogfooding rather than additional abstractions.
