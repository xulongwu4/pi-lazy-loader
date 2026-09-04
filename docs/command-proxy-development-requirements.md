# Command Proxy Development Requirements

**Target release:** `pi-lazy-loader v0.3.0`  
**Status:** Draft for implementation  
**Scope:** Manifest-driven and user-supplied slash-command proxies  
**Primary migration:** Replace the hardcoded `/token-burden` proxy and add MCP command proxies

## Problem Statement

Pi must know slash commands before it dispatches user input. If a package is configured with `"extensions": []`, its extension factory does not run at startup and its commands are absent. The model cannot recover an unknown slash command by calling `lazy_load` because command dispatch happens before the model runs.

`v0.2.0` proves that a permanent lightweight proxy can solve this problem, but `/token-burden` is hardcoded in `index.ts`. There is no structured command metadata in `manifest.json`, no user extension point, and no generic registration path. Consequently `/mcp`, `/pi-mcp`, and `/mcp-auth` are unavailable until users manually run `/lazy add pi-mcp-adapter`.

A second UX issue is attribution. Pi correctly reports the proxy command's canonical source as `pi-lazy-loader`, because that extension called `registerCommand`. Users also need to see the real target package behind the proxy.

## Goals

1. Declare built-in command proxies as data rather than per-command code.
2. Let users add command metadata for packages already known to `manifest.json`.
3. Automatically register proxies only when the target package is actually deferred.
4. Load the package once on first command use and invoke its real handler.
5. Capture all declared commands for a package during the same factory load.
6. Preserve handler arguments, command context, errors, and post-load completions.
7. Show both the target package and `pi-lazy-loader` proxy role honestly.
8. Make `/mcp`, `/pi-mcp`, and `/mcp-auth` work from a cold session.
9. Preserve `v0.2.0` `/token-burden` behavior without a hardcoded branch.
10. Add less startup cost than the packages being deferred.

## Non-Goals

- Do not infer command names by importing deferred packages at startup.
- Do not accept executable code, arbitrary entry paths, or JavaScript callbacks in user configuration.
- Do not allow user configuration to introduce packages absent from the built-in manifest in v0.3.0.
- Do not spoof or mutate Pi's canonical `sourceInfo`.
- Do not patch `ExtensionRunner` internals.
- Do not unregister or replace commands dynamically.
- Do not load a package while the user merely requests argument completions.
- Do not proxy dynamically generated MCP prompt commands before the adapter loads.
- Do not add project-local custom configuration that bypasses Pi's project-trust boundary.
- Do not implement profile inheritance, watchers, daemons, or semantic intent matching.

## Terminology

- **Proxy command:** Lightweight command registered eagerly by `pi-lazy-loader`.
- **Target package:** Deferred package containing the real command implementation.
- **Target command:** Real `registerCommand` definition captured during target loading.
- **Built-in declaration:** Command metadata shipped in `manifest.json`.
- **User declaration:** Command metadata from the agent-directory configuration file.
- **Canonical provenance:** Pi's immutable `sourceInfo` for the extension that registered the proxy.
- **Delegated provenance:** Human-readable target-package attribution rendered by the proxy description.

## Current Baseline

`v0.2.0` contains generic loader methods:

```ts
loader.reserveCommand(packageName, commandName);
await loader.invokeCapturedCommand(packageName, commandName, args, ctx);
```

It also contains one hardcoded registration in `index.ts`:

```text
/token-burden → pi-token-burden → token-burden
```

This command has passed deterministic tests, isolated TUI validation, packed-install TUI validation, and production TUI validation. The generic implementation must retain those guarantees.

## Configuration Model

### Built-in Manifest Declarations

Extend each `manifest.json` package entry with an optional `commands` array:

```json
{
  "name": "pi-mcp-adapter",
  "source": "npm:pi-mcp-adapter",
  "locator": "npm:pi-mcp-adapter",
  "cost": 0.2,
  "capability": "Model Context Protocol adapter and tools",
  "commands": [
    {
      "name": "mcp",
      "description": "Show MCP server status"
    },
    {
      "name": "pi-mcp",
      "description": "Show MCP server status"
    },
    {
      "name": "mcp-auth",
      "description": "Authenticate with an MCP server"
    }
  ]
}
```

Move token-burden's hardcoded mapping into its manifest entry:

```json
{
  "name": "pi-token-burden",
  "commands": [
    {
      "name": "token-burden",
      "description": "Show token-budget usage"
    }
  ]
}
```

The package entry supplies the canonical target package name. A command may optionally supply `targetLabel` for display; it defaults to the package `name`.

### User Configuration

Read one global file from the active agent directory:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json
```

Schema version 1:

```json
{
  "$schema": "https://raw.githubusercontent.com/xulongwu4/pi-lazy-loader/v0.3.0/lazy-loader.schema.json",
  "version": 1,
  "commands": [
    {
      "package": "pi-mcp-adapter",
      "name": "mcp",
      "description": "Show MCP server status",
      "targetLabel": "pi-mcp-adapter"
    }
  ]
}
```

Requirements:

- `version` is required and must equal `1`.
- `commands` is required and must be an array.
- `package`, `name`, and `description` are required non-empty strings.
- `targetLabel` is optional and cosmetic.
- Command names omit the leading `/`.
- Command names must match `^[a-z0-9][a-z0-9-]*$`.
- Descriptions and labels must have bounded lengths defined by the shipped JSON Schema and reject control characters/newlines.
- Unknown fields are rejected.
- The file size is limited to 64 KiB.
- Missing configuration is valid and means “built-ins only.”
- Configuration changes take effect on `/reload` or restart. No watcher is added.

### Security Boundary

A user declaration may reference only a package resolved by the existing built-in manifest aliases. It cannot provide `source`, `locator`, entry files, module paths, or code. Packages must already be installed and separately configured through Pi settings.

Only the global agent-directory file is read in v0.3.0. Project-specific eager/deferred selection continues to use trusted native Pi settings. The loader must not read an arbitrary project-local `lazy-loader.json`.

## Merge and Validation Rules

Built-in declarations load first; valid user declarations overlay them.

1. The identity key is `(resolved package name, command name)`.
2. An exact user match may override `description` and `targetLabel`.
3. Duplicate identical declarations collapse to one proxy.
4. The same command name mapped to different packages is a conflict.
5. Conflicted command names register no proxy; other valid declarations continue.
6. Unknown packages, malformed names, empty descriptions, oversized files, unsupported versions, and unknown fields produce diagnostics and are skipped.
7. Invalid entries must not crash Pi startup.
8. Diagnostics are written to stderr immediately and shown once through `ctx.ui.notify` at `session_start` when UI is available.
9. Validation must be deterministic; declaration ordering must not change conflict outcomes.
10. `manifest.json` itself is validated with the same command-definition rules during tests and package startup.

A JSON Schema, `lazy-loader.schema.json`, must ship with the package and cover the user file. TypeScript validation remains authoritative at runtime.

## Functional Requirements

### FR-1: Manifest Types

Extend `ManifestEntry`:

```ts
interface CommandProxyDeclaration {
  name: string;
  description: string;
  targetLabel?: string;
}

interface ManifestEntry {
  // existing fields
  commands?: CommandProxyDeclaration[];
}
```

Expose one merged runtime type containing the resolved package name/source plus command metadata. Callers must not need to understand built-in-versus-user origin to register proxies.

### FR-2: Configuration Loader

Add a focused module, for example `src/command-config.ts`, responsible only for:

- reading the optional global file;
- enforcing size and JSON shape;
- resolving package aliases through `findManifestEntry`;
- merging built-in and user declarations;
- returning valid definitions plus diagnostics.

It must not register commands, load packages, or access Pi UI.

### FR-3: Reserve Before Register

For every deferred package, reserve **all** declared command names before registering any proxy. This ordering is required for packages such as `pi-mcp-adapter`: invoking `/mcp` loads one factory that also registers `/pi-mcp` and `/mcp-auth`; all three real definitions must be captured during that first load.

No proxy is reserved or registered when the target package state is `loaded` because settings configured it eagerly.

### FR-4: Generic Proxy Registration

Replace the hardcoded `/token-burden` branch with one loop over merged definitions.

Conceptual seam:

```ts
registerCommandProxies({ pi, loader, definitions, diagnostics });
```

Each registered command must:

1. use the declared command name;
2. use a description that exposes target and proxy attribution;
3. load the target package on invocation;
4. report load failure clearly;
5. invoke the captured target handler with original arguments and context;
6. retain the permanent proxy instead of relying on duplicate-name replacement;
7. record proxy/target/package details when diagnostic reporting is enabled.

### FR-5: Target Registration Capture

The existing late-factory `ExtensionAPI` proxy must intercept `registerCommand(name, options)`.

- If `(package, name)` is reserved, store the complete command options and suppress registration.
- Otherwise forward registration to Pi unchanged.
- Captured definitions are isolated by package and command name.
- Multiple commands from one factory are captured independently.
- A second registration for the same reserved key is an explicit error; it must not silently replace the first definition.
- Target commands must register synchronously or within the awaited extension factory. Registration after package load completion is unsupported and diagnosed.

### FR-6: Invocation Semantics

`invokeCapturedCommand` must preserve:

- the original argument string exactly, including whitespace;
- `ExtensionCommandContext` object identity;
- asynchronous return behavior;
- thrown error identity at the loader seam.

The UI-facing proxy may catch the error only to display a clear notification. It must retain package and command names in diagnostics.

Concurrent first invocations of different proxies belonging to the same package must share the package's existing in-flight load promise. The factory executes once.

### FR-7: Argument Completions

The permanent proxy must expose `getArgumentCompletions(prefix)`.

Before target load:

- return `null`;
- do not load the package merely because the user pressed Tab.

After target load:

- if the captured command provides `getArgumentCompletions`, delegate the original prefix and return its result unchanged;
- otherwise return `null`.

Add a loader seam such as:

```ts
loader.getCapturedCommandCompletions(packageName, commandName, prefix);
```

The completion seam must not expose or mutate the complete captured command definition.

### FR-8: MCP Commands

Built-in declarations must cover:

| Proxy | Target package | Expected behavior |
|---|---|---|
| `/mcp` | `pi-mcp-adapter` | Open/show MCP server status |
| `/pi-mcp` | `pi-mcp-adapter` | Alias for MCP server status |
| `/mcp-auth` | `pi-mcp-adapter` | Invoke real MCP authentication handler |

First invocation of any one must load the package and capture all three declarations. The invoked handler must use the real replayed MCP lifecycle state.

MCP prompt commands generated from server prompts are not declared upfront. They register normally after the first adapter load and remain unavailable before that point.

### FR-9: Token-Burden Migration

`/token-burden` must move to manifest-driven registration with no behavior change:

- still absent as a proxy when `pi-token-burden` is eager;
- still available at startup when the package is deferred;
- still opens the genuine Token Burden overlay on first use;
- still reuses the captured handler on subsequent calls;
- no duplicate `/token-burden:1` command appears.

Delete the per-command branch from `index.ts` after the generic path passes its tests.

### FR-10: Provenance UX

Pi's public command API excludes `sourceInfo` from caller-supplied options. Therefore canonical provenance remains:

```text
sourceInfo → pi-lazy-loader
```

The loader must not spoof it. Proxy descriptions must show delegated provenance in a consistent format:

```text
Show MCP server status [target: pi-mcp-adapter; proxy: pi-lazy-loader]
```

Requirements:

- target label is always visible in command completion/help text;
- proxy ownership is not hidden;
- labels come from validated data, never paths or executable values;
- eager commands retain their genuine target-package `sourceInfo` because no proxy is registered;
- `/lazy list` shows each proxy as `/command → target-package`.

If Pi later adds a supported delegated-provenance field (for example `proxyFor`), use it while preserving the textual fallback. Native support is not a v0.3.0 blocker.

### FR-11: Runtime Diagnostics

Diagnostics must distinguish:

- invalid user declaration;
- command-name conflict;
- target package missing;
- target package failed to load;
- package loaded but did not register the declared command (command proxy fails; the successfully loaded package is not reloaded);
- duplicate target registration;
- target handler failure;
- unsupported late registration;
- missing UI for a UI-only command.

Messages include proxy command, target command, and package. Do not report a command as ready merely because the package state is `loaded`.

### FR-12: Status and Management Commands

Extend `/lazy list` output for packages with command proxies:

```text
[deferred] pi-mcp-adapter  commands: /mcp, /pi-mcp, /mcp-auth
[loaded]   pi-token-burden commands: /token-burden
```

`/lazy add <package>` must populate all reserved command handlers as a side effect of normal package loading. `/lazy pin <package>` changes only next-startup settings; current-session proxies remain valid until restart.

## Non-Functional Requirements

### Startup Performance

- Parsing built-in and user command metadata plus proxy registration should add less than 50 ms to the no-extension baseline on the measured host.
- No target package module may be imported while registering proxies or requesting pre-load completions.
- The release must retain a positive interleaved A/B startup improvement for each newly deferred package.

### Compatibility

- Support Pi 0.84.x public `registerCommand` behavior.
- Preserve settings and Fabric symlinks.
- Preserve `PI_CODING_AGENT_DIR` isolation.
- Keep Pi peer dependencies optional; clean installation must include no duplicate Pi runtime.
- Work with and without Fabric. Command dispatch must not depend on model tool selection.

### Reliability

- One package load promise per package.
- One captured command definition per `(package, command)`.
- No numeric collision suffixes for the proxy/target pair.
- Invalid optional user configuration cannot prevent `/lazy`, `lazy_load`, or built-in valid proxies from registering.
- Existing lifecycle replay remains the only late-initialization mechanism.

## Development Stages

### Stage 0 — Red Tests and Schema

Write failing tests for:

- manifest command validation;
- missing/malformed/oversized user config;
- package alias resolution;
- deterministic merge and conflict handling;
- all commands reserved before first factory load;
- completion behavior before and after load;
- provenance description formatting.

Do not alter runtime registration until these tests fail for the expected reasons.

### Stage 1 — Generic Registration and Token Migration

Implement command-config parsing and the generic registrar. Move `/token-burden` from hardcoded code to `manifest.json`.

Gate: existing unit checks and three prior TUI proof shapes (isolated checkout, packed install, production-style config) still open the real overlay. No `/token-burden:1` appears.

### Stage 2 — MCP Built-ins

Add `/mcp`, `/pi-mcp`, and `/mcp-auth` declarations. Verify one first command captures all three target handlers.

Gate: a cold TUI session invokes each proxy against the real package. `/mcp` and `/pi-mcp` open the real status UI. `/mcp-auth` executes the real handler with a safe missing/unknown-server argument without launching an external OAuth flow.

### Stage 3 — User Configuration

Ship `lazy-loader.schema.json` and read `lazy-loader.json` from the agent directory. Add one synthetic user command declaration for an existing manifest package in isolated tests.

Gate: missing config, valid config, malformed config, conflict config, and symlinked agent directory all behave according to the merge rules.

### Stage 4 — Provenance and Status UX

Apply the standardized target/proxy description and extend `/lazy list`.

Gate: `pi.getCommands()` confirms canonical source remains `pi-lazy-loader`, description names the real target package, and eager-mode source remains the target package.

### Stage 5 — Performance and Release

Run clean-pack installation, deterministic checks, real TUI checks, and alternating A/B startup measurements. Publish only after all gates pass.

## Test Matrix

| Area | Required checks |
|---|---|
| Manifest | valid command arrays; invalid names; duplicate keys; unknown fields |
| User config | absent, valid, malformed JSON, wrong version, oversized, unknown package, conflict |
| Merge | built-in only; user addition; user description override; deterministic conflict skip |
| Registration | eager target skips proxy; deferred target registers proxy; all package commands reserved first |
| Loading | one factory for concurrent commands; all target handlers captured; unrelated registrations forwarded |
| Invocation | exact args/context; async return; repeated invocation; unchanged loader-seam error |
| Completions | no pre-load import; null before load; exact target result after load |
| Collision | target registration suppressed; no `:1` suffix; duplicate target registration diagnosed |
| Lifecycle | genuine events replayed; MCP and token-burden state initialized |
| Provenance | sourceInfo remains loader; target and proxy visible in description; eager source genuine |
| MCP | `/mcp`, `/pi-mcp`, `/mcp-auth`; generated prompt commands appear after first load |
| Token burden | genuine overlay; first and repeated calls; no hardcoded registrar remains |
| Packaging | eight-plus-schema runtime files only; no duplicate Pi peers; clean install smoke |
| Configuration safety | settings/fabric symlinks preserved; no automatic settings rewrite |
| Performance | proxy startup budget; per-package alternating A/B; first-use latency reported |

## Release Acceptance Criteria

`v0.3.0` may ship only when:

1. Command declarations are structured in `manifest.json`.
2. `/token-burden` uses the generic path and all existing proofs still pass.
3. `/mcp`, `/pi-mcp`, and `/mcp-auth` work before manual `/lazy add`.
4. One MCP command loads the package once and captures all declared MCP commands.
5. User configuration can add or override command metadata for existing manifest packages.
6. Invalid user configuration fails softly with actionable diagnostics.
7. Pre-load Tab completion never imports a deferred package.
8. Post-load completion delegates to the real command.
9. Command help visibly identifies both target and proxy.
10. Canonical `sourceInfo` remains unmodified and documented.
11. `/lazy list` displays command proxy mappings and readiness.
12. No proxy/target numeric command suffix appears.
13. Clean installed package contains no duplicate Pi runtime.
14. TypeScript, deterministic, packed TUI, and production-style TUI checks pass.
15. Interleaved A/B measurements show positive net startup savings.
16. Release documentation includes configuration, diagnostics, attribution limits, and rollback.

## Deployment Plan

1. Publish `v0.3.0` only after the release criteria pass.
2. Back up the real settings symlink target and `lazy-loader.json` if present.
3. Install `git:github.com/xulongwu4/pi-lazy-loader@v0.3.0`.
4. Keep `pi-mcp-adapter` and `pi-token-burden` configured with `"extensions": []`.
5. Start a fresh production TUI and invoke `/mcp`, `/pi-mcp`, `/mcp-auth <missing-server>`, and `/token-burden`.
6. Verify `/lazy list`, command descriptions, absence of numeric suffixes, and lifecycle diagnostics.
7. Retain the deployment only if all production checks pass.

## Rollback

Before deployment, create timestamped copies of:

- the resolved `settings.json` symlink target;
- `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json` when present.

Rollback steps:

```bash
pi install git:github.com/xulongwu4/pi-lazy-loader@v0.2.0
```

Restore the settings backup atomically, then restart Pi. `pi-token-burden` can remain deferred only if `v0.2.0` is restored; `pi-mcp-adapter` may remain deferred but `/mcp` again requires `/lazy add pi-mcp-adapter` before use.

## Upstream Provenance Requirement

Pi currently owns canonical command provenance and does not permit callers to set `sourceInfo`. A future upstream API should support delegated attribution without spoofing, for example:

```ts
pi.registerCommand("mcp", {
  proxyFor: { source: "npm:pi-mcp-adapter" },
  description: "Show MCP server status",
  handler,
});
```

Desired UI:

```text
/mcp  Show MCP server status  pi-mcp-adapter (via pi-lazy-loader)
```

Until such an API exists, v0.3.0 must use the honest description fallback and retain canonical `sourceInfo: pi-lazy-loader`.
