# Command Proxy Development Requirements

**Target release:** `pi-lazy-loader v0.3.0`  
**Status:** Draft for implementation  
**Scope:** Manifest-driven and user-supplied slash-command proxies  
**Primary migration:** Replace the hardcoded `/token-burden` proxy and add MCP command proxies

## Problem Statement

Pi must know slash commands before it dispatches user input. If a package is configured with `"extensions": []`, its extension factory does not run at startup and its commands are absent. The model cannot recover an unknown slash command by calling `lazy_load` because command dispatch happens before the model runs.

`v0.2.1` proves that a lightweight startup stub can solve this problem and hand off to the real command definition after loading, but `/token-burden` is hardcoded in `index.ts`. There is no structured command metadata in `manifest.json`, no user extension point, and no generic registration path. Consequently `/mcp`, `/pi-mcp`, and `/mcp-auth` are unavailable until users manually run `/lazy add pi-mcp-adapter`.

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
9. Preserve `v0.2.1` `/token-burden` description-handoff behavior without a hardcoded branch.
10. Add less startup cost than the packages being deferred.

## Non-Goals

- Do not infer command names by importing deferred packages at startup.
- Do not accept executable code, arbitrary entry paths, or JavaScript callbacks in user configuration.
- Do not allow user configuration to introduce packages absent from the built-in manifest in v0.3.0.
- Do not spoof or mutate Pi's canonical `sourceInfo`.
- Do not patch `ExtensionRunner` internals.
- Do not mutate Pi command maps or unregister commands through internal APIs. The only supported replacement is the target package's normal `registerCommand` call forwarded through the same public `ExtensionAPI`.
- Do not load a package while the user merely requests argument completions.
- Do not proxy dynamically generated MCP prompt commands before the adapter loads.
- Do not add project-local custom configuration that bypasses Pi's project-trust boundary.
- Do not implement profile inheritance, watchers, daemons, or semantic intent matching.

## Terminology

- **Command proxy:** The complete first-use mechanism: an eager startup stub followed by a target-definition handoff.
- **Startup stub:** Lightweight command initially registered by `pi-lazy-loader`; it owns only the first invocation.
- **Target package:** Deferred package containing the real command implementation.
- **Target command:** Real `registerCommand` definition captured during target loading.
- **Built-in declaration:** Command metadata shipped in `manifest.json`.
- **User declaration:** Command metadata from the agent-directory configuration file.
- **Canonical provenance:** Pi's immutable `sourceInfo` for the extension that registered the proxy.
- **Delegated provenance:** Human-readable target-package attribution rendered by the proxy description.

## Current Baseline

`v0.2.1` contains generic loader methods:

```ts
loader.reserveCommand(packageName, commandName);
await loader.invokeCapturedCommand(packageName, commandName, args, ctx);
```

It also contains one hardcoded registration in `index.ts`:

```text
/token-burden → pi-token-burden → token-burden
```

This command has passed deterministic tests, isolated TUI validation, packed-install TUI validation, and production TUI validation. `v0.2.1` additionally proves that the target's real description and completions replace the synthesized stub metadata after first load. The generic implementation must retain those guarantees.

## Command Definition Handoff

A command proxy has three observable states:

```text
startup
  /command → startup stub
  description → declared lazy description + target attribution

first invocation (stub handler already on the call stack)
  → load target package
  → capture target registerCommand(name, realOptions)
  → forward registerCommand through the same pi-lazy-loader ExtensionAPI
  → Pi's extension.commands.set(name, ...) replaces the stub entry
  → call the captured real handler for this in-flight invocation

subsequent invocation
  /command → forwarded real command definition directly
  description/completions/handler → target options
  sourceInfo → pi-lazy-loader (unchanged canonical registrar)
```

The first invocation cannot redispatch the slash command because command parsing has already completed. It must call the captured real handler. Future invocations resolve the updated command map and bypass the stub handler entirely.

Forwarding through the same `ExtensionAPI` is load-bearing: Pi performs a map replacement within one extension instead of resolving two extension-owned commands as `/command:1` and `/command:2`.

If loading fails or the target never registers the declared command, no replacement occurs; the startup stub remains available so a later invocation can report or retry the failure.

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

The built-in package entry supplies the canonical target label through its `name`. User configuration may override that label once at package-group scope.

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
  "packages": {
    "pi-mcp-adapter": {
      "targetLabel": "pi-mcp-adapter",
      "commands": [
        {
          "name": "mcp",
          "description": "Show MCP server status"
        }
      ]
    }
  }
}
```

Requirements:

- `version` is required and must equal `1`.
- `packages` is required and must be an object keyed by package name or manifest alias. The wrapper keeps `$schema` and `version` separate from dynamic package keys and leaves room for future file-level metadata.
- Each package value requires a `commands` array.
- Each command requires non-empty `name` and `description` strings.
- Package keys must resolve through the built-in manifest.
- `targetLabel` is optional, cosmetic, and applies to every command in its package group; it defaults to the resolved manifest package name.
- Command names omit the leading `/`.
- Command names must match `^[a-z0-9][a-z0-9-]*$`.
- Descriptions and labels must have bounded lengths defined by the shipped JSON Schema and reject control characters/newlines.
- Unknown fields are rejected.
- The file size is limited to 64 KiB.
- Missing configuration is valid and means “built-ins only.”
- Configuration changes take effect on `/reload` or restart. No watcher is added.

### Security Boundary

A user package key may reference only a package resolved by the existing built-in manifest aliases. It cannot provide `source`, `locator`, entry files, module paths, or code. Packages must already be installed and separately configured through Pi settings.

Only the global agent-directory file is read in v0.3.0. Project-specific eager/deferred selection continues to use trusted native Pi settings. The loader must not read an arbitrary project-local `lazy-loader.json`.

## Merge and Validation Rules

Built-in declarations load first; valid user declarations overlay them.

1. The identity key is `(resolved package name, command name)`.
2. An exact user command match may override `description`; a package-group `targetLabel` overrides the display label for every command in that group.
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
}

interface ManifestEntry {
  // existing fields
  commands?: CommandProxyDeclaration[];
}

interface UserPackageCommandConfig {
  targetLabel?: string;
  commands: CommandProxyDeclaration[];
}

interface UserCommandConfig {
  version: 1;
  packages: Record<string, UserPackageCommandConfig>;
}
```

Expose one merged runtime type containing the resolved package name/source plus command metadata. Callers must not need to understand built-in-versus-user origin to register proxies.

### FR-2: Configuration Loader

Add a focused module, for example `src/command-config.ts`, responsible only for:

- reading the optional global file;
- enforcing size and JSON shape;
- resolving each `packages` object key through `findManifestEntry`;
- flattening validated package groups into merged runtime command definitions;
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
6. forward the captured target registration through the same public `ExtensionAPI`, so Pi replaces the startup stub with the target definition in the existing command-map slot;
7. record proxy/target/package details when diagnostic reporting is enabled.

### FR-5: Target Registration Capture

The existing late-factory `ExtensionAPI` proxy must intercept `registerCommand(name, options)`.

- If `(package, name)` is reserved, store the complete command options and forward the registration to Pi, replacing the startup stub.
- Otherwise forward registration to Pi unchanged.
- Captured definitions are isolated by package and command name.
- Multiple commands from one factory are captured independently.
- Repeated target registrations for the same reserved key preserve Pi's normal last-write-wins behavior: update the captured definition and forward the latest options into the same command-map slot. They must not create numeric suffixes.
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

The startup stub may expose `getArgumentCompletions()` that returns `null`; requesting completion must not load the package. When the target registration is forwarded, Pi replaces the stub options with the real command options. Post-load completions therefore come directly from the target's `getArgumentCompletions` without a loader completion seam. Tests must prove both the pre-load `null` result and post-load target result.

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
- still invokes the captured handler for the in-flight first call;
- subsequent calls use the forwarded real command definition;
- the synthesized description is replaced by the real description and completions;
- no duplicate `/token-burden:1` command appears.

Delete the per-command branch from `index.ts` after the generic path passes its tests.

### FR-10: Provenance UX

Pi's public command API excludes `sourceInfo` from caller-supplied options. Therefore canonical provenance remains:

```text
sourceInfo → pi-lazy-loader
```

The loader must not spoof it. Description handoff has two formats:

```text
before load: Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]
after load:  <real target description> [target: pi-mcp-adapter; via pi-lazy-loader]
```

When forwarding the real options in v0.3.0, preserve the target description as the base text and append delegated attribution. If the target omits a description, use the validated declared description as the base. All other target options, including completion behavior and handler, pass through unchanged.

Requirements:

- before load, target label is visible in the synthesized command description;
- after load, the target's real description (or declared fallback), completions, and delegated attribution are visible;
- proxy ownership is not hidden before or after handoff;
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
- repeated target registration (diagnostic only; latest definition remains authoritative);
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
- package-keyed group validation and package alias resolution;
- deterministic merge and conflict handling;
- all commands reserved before first factory load;
- completion behavior before and after load;
- provenance description formatting.

Do not alter runtime registration until these tests fail for the expected reasons.

### Stage 1 — Generic Registration and Token Migration

Implement command-config parsing and the generic registrar. Move `/token-burden` from hardcoded code to `manifest.json`.

Gate: existing unit checks and three prior TUI proof shapes (isolated checkout, packed install, production-style config) still open the real overlay. Metadata inspection proves the synthesized description before load and the target description/completions after load. No `/token-burden:1` appears.

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
| User config | absent, valid package groups, malformed JSON, wrong version, oversized, unknown package key, duplicate aliases, conflict |
| Merge | built-in only; package-group addition; group target-label override; command description override; deterministic conflict skip |
| Registration | eager target skips proxy; deferred target registers proxy; all package commands reserved first |
| Loading | one factory for concurrent commands; all target handlers captured; unrelated registrations forwarded |
| Invocation | first call uses captured handler; exact args/context; async return; subsequent call uses forwarded real handler; unchanged loader-seam error |
| Completions | no pre-load import; null before load; exact target result after load |
| Collision | target registration replaces the same-map stub; no `:1` suffix; duplicate target registration diagnosed |
| Lifecycle | genuine events replayed; MCP and token-burden state initialized |
| Provenance | sourceInfo remains loader; startup and post-load descriptions show target/proxy; target description is preserved; eager source genuine |
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
8. Post-load description and completion come from the forwarded real command definition.
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
pi install git:github.com/xulongwu4/pi-lazy-loader@v0.2.1
```

Restore the settings backup atomically, then restart Pi. `pi-token-burden` can remain deferred when `v0.2.1` is restored; `pi-mcp-adapter` may remain deferred but `/mcp` again requires `/lazy add pi-mcp-adapter` before use.

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
