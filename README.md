# pi-lazy-loader

Deferred on-demand extension loader for Pi coding agent. It can load ten profiled packages mid-session without `/reload`; the validated Fabric-compatible configuration currently defers web access, MCP, dynamic workflows, and the token-burden command.

## Startup Overhead & Performance Impact

Phase 0 profiling on host `solus` measured total extension startup overhead at **5.268 s** (baseline `pi -ne`: 0.565 s; full startup with 36 packages: 5.833 s).

The ten packages below account for **80.8% (4.257 s)** of that overhead:

| # | Package | Cost | Capability |
|---|---|---|---|
| 1 | `npm:pi-fabric` | **1.102 s** | Programmable tool & agent runtime (`fabric_exec`, mcporter, actors) |
| 2 | `npm:@zosmaai/pi-llm-wiki` | **0.702 s** | Self-maintaining markdown LLM wiki, search, and knowledge vault |
| 3 | `npm:@tintinweb/pi-subagents` | **0.601 s** | Sub-agents and workflow orchestration with parallel execution |
| 4 | `npm:@quintinshaw/pi-dynamic-workflows` | **0.501 s** | Dynamic workflows fan-out and deep-research execution (`/workflows`) |
| 5 | `npm:@narumitw/pi-goal` | **0.401 s** | Autonomous single-objective goal completion (`/goal`) |
| 6 | `npm:pi-token-burden` | **0.300 s** | Token-budget breakdown of system prompt (`/token-burden`) |
| 7 | `npm:pi-antigravity` | **0.250 s** | Cloud Code Assist / Antigravity Google OAuth provider |
| 8 | `npm:pi-mcp-adapter` | **0.200 s** | Model Context Protocol (MCP) server adapter and tools |
| 9 | `npm:pi-web-access` | **0.100 s** | Web search, URL fetching, repo cloning, and PDF extraction |
| 10 | `git:github.com/xulongwu4/pi-quotas` | **0.100 s** | API quota and token usage monitoring and status |

The table is the Phase 0 opportunity map, not a recommendation to defer every entry. Phase 2.6 validated `pi-web-access`, `pi-mcp-adapter`, and `@quintinshaw/pi-dynamic-workflows`. Phase 4.2 additionally validated the deterministic `/token-burden` command proxy. Interleaved A/B testing measured at least **0.71 s** improvement from workflows alone; the earlier web/MCP trial improved its fresh-start minimum by **0.52 s**.

---

## Installation and Configuration

```bash
pi install git:github.com/xulongwu4/pi-lazy-loader@v0.3.2
```

Keep skills, prompts, and themes eager while filtering only the four validated extension entries in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/xulongwu4/pi-lazy-loader@v0.3.2",
    "npm:pi-fabric",
    { "source": "npm:@quintinshaw/pi-dynamic-workflows", "extensions": [] },
    { "source": "npm:pi-token-burden", "extensions": [] },
    { "source": "npm:pi-mcp-adapter", "extensions": [] },
    { "source": "npm:pi-web-access", "extensions": [] }
  ]
}
```

When Fabric captures extension tools, keep the loader prompt-visible in `~/.pi/agent/fabric.json`:

```json
{
  "capture": {
    "keepVisible": ["fabric_exec", "lazy_load"]
  }
}
```

Other package entries remain unchanged and eager.

---

## Architectural Principles & Constraints

### 1. Skills, Prompts, and Themes Remain Eager
Phase 0 control measurements verified that skills, prompts, and themes contribute **0.000 s** to startup time (baseline with `-ns` is identical to baseline without `-ns`). Keeping them eager in settings allows:
- Skills to remain listed in system prompt `<available_skills>` from the first turn.
- Slash commands like `/skill:*` and prompt templates to remain functional immediately.
- Zero startup penalty while deferring heavy TypeScript compilation and runtime module trees.

### 2. Provider Extensions Should Not Be Deferred
Extensions that register LLM providers (e.g. `pi-devin`, `pi-cline-pass`) must run during initial startup when their models need to be available for `--model` validation or model cycling. Keep those providers eager.

`pi-antigravity` appears in the measured top ten because it costs 0.250 s. Defer it only when you do **not** need an Antigravity-provided model at startup; otherwise leave its settings entry eager and accept the smaller saving (4.007 s, 76.1% of the measured overhead). It can still be loaded later before switching models.

### 3. Lifecycle Replay
Extensions such as `pi-fabric` initialize internal state (e.g. `state.bootstrap(context)`) inside `session_start` listeners. When loaded mid-session, that event has already fired.
- `pi-lazy-loader` captures genuine `session_start` and `resources_discover` event objects and contexts at eager startup.
- Late-loaded factories run with a `pi` Proxy that intercepts `pi.on`.
- Handlers registered for `session_start` and `resources_discover` are replayed **exactly once** using the genuine event and context objects.
- This lets `pi-fabric` bootstrap cleanly without throwing `"Pi Fabric has not bootstrapped"`.

### 4. Fabric Gateway Compatibility

Keep `pi-fabric` **eager** when using Fabric as the exclusive tool gateway. Although late loading registers and executes `fabric_exec`, Fabric loaded after session startup cannot attach its capture interceptor to the already-running bundled `ExtensionRunner`; subsequently loaded extension tools remain top-level. With Fabric eager, dynamically loaded tools are captured correctly. Keep `lazy_load` visible alongside `fabric_exec`; after each load the loader refreshes Fabric's catalog and restores that two-tool active set, preventing same-turn policy leaks.

The v0.3.2 configuration defers `pi-web-access`, `pi-mcp-adapter`, `@quintinshaw/pi-dynamic-workflows`, and `pi-token-burden`, but not `pi-fabric` or `@tintinweb/pi-subagents`.

### 5. Resources-Discovery Ceiling
Pi runs its resource discovery pass (`resources_discover`) strictly during session startup. While `pi-lazy-loader` replays `resources_discover` so extension callbacks execute their internal book-keeping, Pi does not discover new skills or themes mid-session. This is why keeping skills eager in `settings.json` is essential.

---

## Commands & Tools

### Slash Commands

- Command Proxies: Built-in stubs for deferred packages (`/mcp`, `/pi-mcp`, `/mcp-auth` from `pi-mcp-adapter`; `/token-burden` from `pi-token-burden`), plus user-declared proxies from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json`.
  - Registered only when the target package is deferred (`"extensions": []`).
  - Pre-load completions return `null` without loading the package.
  - First invocation executes the target factory once, stages and atomically commits registrations, forwards decorated description with delegated provenance (`[target: <pkg>; via pi-lazy-loader]`), and invokes the captured real handler for the in-flight call.
  - Replacement within Pi's command map creates no numeric `:1` suffixes.
- `/lazy list`: Show status (`deferred`, `loading`, `loaded`, `failed`), measured startup cost, capabilities, and per-command readiness (`deferred`, `ready`, `missing`) for all packages.
- `/lazy add <package>`: Dynamically load a package extension into the current session.
  - Idempotent: Subsequent calls return immediately.
  - Concurrent-safe: In-flight calls share a single promise.
  - Atomic multi-entry: All entry points must succeed; partial failure leaves status as `failed`.
- `/lazy pin <package>`: Remove `"extensions": []` from matching package object in `settings.json` so it loads eagerly on subsequent startups.
  - Preserves all unknown/custom properties.
  - Writes atomically (temp file + rename).
  - Refuses missing or ambiguous package entries.

---

## User Configuration (`lazy-loader.json`)

To add or customize slash-command proxies for packages known to `manifest.json`, place a `lazy-loader.json` file in the active agent directory:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json
```

A JSON Schema (`lazy-loader.schema.json`) ships with the package and validates the structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/xulongwu4/pi-lazy-loader/v0.3.0/lazy-loader.schema.json",
  "version": 1,
  "packages": {
    "pi-mcp-adapter": {
      "targetLabel": "mcp-service",
      "commands": [
        "mcp",
        "pi-mcp",
        {
          "name": "mcp-auth",
          "description": "Authenticate with an MCP server"
        }
      ]
    }
  }
}
```

### Configuration Syntax & Rules

- **Version**: `version: 1` is required.
- **`$schema`**: Optional string; ignored at runtime and exempt from unknown-property checks.
- **Grouped packages**: `packages` is keyed by manifest package name or alias (e.g. `pi-mcp-adapter` or `npm:pi-mcp-adapter`). Keys must resolve through the built-in manifest.
- **Command shorthand & objects**: The `commands` array accepts string shorthand (e.g. `"mcp"`) or command objects (`{ "name": "...", "description": "..." }`). String shorthand is normalized to `{ "name": "<str>" }` and preserves built-in descriptions.
- **Supplemental `targetLabel`**: An optional string per package group. It is rendered alongside the canonical package name (e.g. `pi-mcp-adapter (mcp-service)`), never replacing it.
- **String constraints**: Command names must match `^[a-z0-9][a-z0-9-]*$` (no leading slash). Descriptions (1–240 chars) and labels (1–100 chars) reject newlines and control characters.
- **File size limit**: The configuration file must not exceed 64 KiB.

### Validation, Diagnostics, and Soft Failure

Configuration loading is strictly non-fatal:
- Syntactic errors, schema violations, unknown packages, or oversized files write diagnostic warnings to `stderr` at startup and surface a notification in the UI at `session_start`. Pi startup never crashes.
- Conflicting user declarations (e.g. differing descriptions for the same command name, or the same command name mapped to multiple packages) skip proxy registration for the conflicted name; valid declarations continue to register.
- If `lazy-loader.json` is missing or invalid, the loader seamlessly falls back to built-in command declarations.

### Provenance and Canonical `sourceInfo` Limitation

Pi's public extension API does not permit third-party extensions to spoof or mutate `sourceInfo`. Pi derives canonical provenance strictly from the registering `ExtensionAPI`, so `sourceInfo` remains `pi-lazy-loader`.

To provide clear attribution without violating this boundary:
- **Before load**: The startup stub description displays delegated provenance:
  `Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]`
- **After load**: The committed command retains the target's real description and adds delegated attribution:
  `<real description> [target: pi-mcp-adapter; via pi-lazy-loader]`
- **Eager packages**: Packages configured eagerly in `settings.json` bypass proxy registration entirely and retain their genuine package `sourceInfo`.

### Settings Scope & Project Overrides Limitation

In v0.3.0, only the global agent-directory file `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json` is read, preserving Pi's project-trust boundary.

Similarly, `syncConfiguredEager()` observes the global agent-directory settings (`${agentDir}/settings.json`). Project-level configuration overrides in `.pi/settings.json` are not merged by the loader in v0.3.0. A project-level override can therefore leave a proxy registered for a package that project settings made eager, or leave a proxy absent for a package that project settings deferred.

### Reload & Restart Semantics

Modifications to `lazy-loader.json` or `settings.json` take effect when Pi is restarted or when `/reload` is issued in an interactive session. No active filesystem watchers or background daemons are used.

### Rollback Procedure

Before deploying or updating:
1. Create timestamped backups of `settings.json` (resolving symlinks) and `lazy-loader.json`:
   ```bash
   cp -p "$(readlink -f ~/.pi/agent/settings.json)" ~/.pi/agent/settings.json.backup
   [ -f ~/.pi/agent/lazy-loader.json ] && cp -p ~/.pi/agent/lazy-loader.json ~/.pi/agent/lazy-loader.json.backup
   ```
2. To roll back to `v0.2.1`:
   ```bash
   pi install git:github.com/xulongwu4/pi-lazy-loader@v0.2.1
   ```
3. Restore `settings.json` and remove or restore `lazy-loader.json`:
   ```bash
   cp -f ~/.pi/agent/settings.json.backup "$(readlink -f ~/.pi/agent/settings.json)"
   rm -f ~/.pi/agent/lazy-loader.json
   ```
   Restart Pi. In `v0.2.1`, `pi-token-burden` remains lazy-loadable via `/token-burden`, while `pi-mcp-adapter` requires manual `/lazy add pi-mcp-adapter` before use.

### LLM Tool

- `lazy_load`: Strict TypeBox schema accepting exactly one string parameter:
  ```json
  {
    "package": "@quintinshaw/pi-dynamic-workflows"
  }
  ```
  Dynamically loads the target package and makes its tools available in the same session. Under Fabric, the tools are captured as `extensions.*` while the native active set remains `fabric_exec` plus `lazy_load`.
  - **Tool Cache & Discovery**: Dynamically advertises deferred packages and their cached tools (`lazy-loader-tools.json`), degrading to manifest capabilities when the cache is empty.
  - **Bounded Prompt Budget**: Total prompt overhead across description, snippet, guidelines, and parameter description is strictly bounded by `MAX_LAZY_LOAD_PROMPT_BUDGET` (1200 characters). Truncation drops whole list items cleanly and appends an honest marker like `(+N more, see /lazy list)` without cutting words or tool names in half.
  - **Sticky Session Failure**: If a package fails to load during a session, subsequent `lazy_load` calls fail fast without re-entering the load path. Retrying requires `/reload` or session restart.

---

## Verification & Checks

Run the verification suite:

```bash
bun checks/run-checks.ts
```

Run `bun checks/phase4-command-checks.ts` for command-proxy capture, concurrency, repeat-call, forwarding, and error checks.
Run `bun checks/command-proxy-checks.ts` for manifest command validation, user configuration, atomic staged-commit, multi-command capture, and packaging allowlist checks.
Run `bun checks/v031-checks.ts` for sticky failure, tool-cache resilience, tool interception passthrough, prompt budget bounding, and partial extension filter checks.
Run `bun checks/v032-checks.ts` for tool metadata harvest, serialization safety, Pi ABI fingerprinting, and cache v2 compatibility checks.

The suite covers:
1. **File/Directory Entry Resolution**: Validates resolution of single files, directory conventions (`llm-wiki/index.ts`), and multi-file packages (`pi-quotas` 6 entries), plus error handling.
2. **Idempotent & Concurrent State**: Proves 5 concurrent load requests share one promise, reload is idempotent, and partial failure is marked `failed`.
3. **Safe Settings Pin Transform**: Proves unknown properties are preserved, writes are atomic, and missing/ambiguous entries are refused (tested strictly on temporary data; never modifies user settings).
4. **Non-interactive End-to-End Proof**: Runs `pi` non-interactively with `google/gemini-3.8-flash`:
   - `fabric_exec` is verified absent before lazy load.
   - Model calls `lazy_load` for `pi-fabric`.
   - `fabric_exec` is dynamically registered and executed in the same session (`return 40+2` -> `42`).
   - Zero `"Pi Fabric has not bootstrapped"` errors.
