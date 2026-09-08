# pi-lazy-loader

General-purpose deferred extension loader for Pi coding agent. Packages listed in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json` can be loaded mid-session without `/reload`; command and tool proxies are discovered from one persistent cache.

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
pi install git:github.com/xulongwu4/pi-lazy-loader@v0.8.0
```

Declare lazy packages in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json`:

```json
{
  "packages": [
    "npm:pi-web-access",
    {
      "source": "npm:pi-mcp-adapter",
      "commands": ["mcp", "mcp-auth"],
      "tools": ["mcp", "mcp__agent-lsp__rename_symbol"]
    }
  ]
}
```

- A string package uses every command and tool found in its cache entry.
- In object form, an omitted `commands` or `tools` field uses all cached proxies of that type.
- A present array is an allowlist; `[]` disables that proxy type, and cached names not listed are suppressed.
- Explicit names absent from the cache still receive proxies, allowing conditional registrations to be requested.
- `lazy-loader.schema.json` describes this format for editor validation.

When Fabric captures extension tools, keep only `fabric_exec` prompt-visible in `~/.pi/agent/fabric.json`:

```json
{
  "capture": {
    "keepVisible": ["fabric_exec"]
  }
}
```

`lazy-loader.json` is the loader's sole package catalog; the plugin does not inspect Pi's `settings.json`. Pi must still be configured not to load the same extension eagerly—for installed resource packages, an `"extensions": []` filter remains one way to do that.

The unified cache is stored at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader-cache.json`. Each package entry contains `commands` and `tools`. A deferred package without an entry is loaded eagerly once to populate both lists. Later sessions register proxies from the cached names and descriptions. Every successful package load refreshes the entry with all commands and tools exposed by that package.

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

Keep `pi-fabric` **eager** when using Fabric as the exclusive tool gateway. Although late loading registers and executes `fabric_exec`, Fabric loaded after session startup cannot attach its capture interceptor to the already-running bundled `ExtensionRunner`; subsequently loaded extension tools remain top-level. With Fabric eager, dynamically loaded tools are captured correctly. Keep only `fabric_exec` in Fabric `capture.keepVisible`; after each load a tool proxy refreshes Fabric's catalog and restores that active set, preventing same-turn policy leaks.

A typical v0.7.0 `lazy-loader.json` defers `pi-web-access`, `pi-mcp-adapter`, `@quintinshaw/pi-dynamic-workflows`, and `pi-token-burden`, but not `pi-fabric` or `@tintinweb/pi-subagents`.

### 5. Resources-Discovery Ceiling
Pi runs its resource discovery pass (`resources_discover`) strictly during session startup. While `pi-lazy-loader` replays `resources_discover` so extension callbacks execute their internal book-keeping, Pi does not discover new skills or themes mid-session. This is why keeping skills eager in `settings.json` is essential.

---

## Commands & Tools

### Slash Commands

- Command Proxies: Cached stubs for every command exposed by a deferred package.
  - Registered only when the target package appears in `lazy-loader.json`.
  - Pre-load completions return `null` without loading the package.
  - First invocation executes the target factory once, stages and atomically commits registrations, forwards decorated description with delegated provenance (`[target: <pkg>; via pi-lazy-loader]`), and invokes the captured real handler for the in-flight call.
  - Replacement within Pi's command map creates no numeric `:1` suffixes.
- `/lazy list`: Show status (`deferred`, `loading`, `loaded`, `failed`), discovered tools, and per-command readiness (`deferred`, `ready`, `missing`) for configured deferred packages.
- `/lazy add <package>`: Dynamically load a package extension into the current session.
  - Idempotent: Subsequent calls return immediately.
  - Concurrent-safe: In-flight calls share a single promise.
  - Atomic multi-entry: All entry points must succeed; partial failure leaves status as `failed`.
- `/lazy pin <package>`: Remove the package from `lazy-loader.json`. Configure Pi itself to load that package eagerly before reloading.
  - Refuses missing or ambiguous package entries.

---

### Command Proxy Provenance

Pi's public extension API does not permit third-party extensions to spoof or mutate `sourceInfo`, so command proxies retain `pi-lazy-loader` as their canonical source.

- **Before load:** `<cached description> [lazy target: <package>; proxy: pi-lazy-loader]`
- **After load:** `<real description> [target: <package>; via pi-lazy-loader]`
- **Eager packages:** Bypass proxy registration and retain their genuine package `sourceInfo`.

### Configuration Scope

Only `${agentDir}/lazy-loader.json` is read. Pi `settings.json` and project-level `.pi/settings.json` are not inspected.

### Reload & Restart Semantics

Changes to `lazy-loader.json` take effect after restarting Pi or issuing `/reload`. No filesystem watcher or background daemon is used.
### LLM Tools

- **Direct tool proxies:** Load-and-retry startup proxies register under every cached tool name for deferred packages. Their descriptions use the cached real tool descriptions. Invoking a proxy loads its package without executing the requested tool, publishes the real tools, refreshes the package cache, and returns explicit retry guidance with `loaded: true`, `executed: false`, and `retryTool`. Caller arguments are never echoed. Under Fabric, loaded tools are captured as `extensions.*` while the native active set remains `fabric_exec` (restored reliably via `finally`). Surviving stale-cache proxies return terminal drift guidance, and failed loads return terminal reload guidance.
- **Sticky Session Failure**: If a package fails to load during a session, subsequent proxy or `/lazy add` calls fail fast without re-entering the load path. Retrying requires `/reload` or session restart.

---

## Verification & Checks

Run the verification suite:

```bash
bun checks/run-checks.ts
```

Run `bun checks/phase4-command-checks.ts` for command-proxy capture, concurrency, repeat-call, forwarding, and error checks.
Run `bun checks/command-proxy-checks.ts` for cached command validation, user configuration, atomic staged-commit, multi-command capture, and packaging allowlist checks.
Run `bun checks/v050-checks.ts` for explicit lazy-loader.json package discovery, first-run cache bootstrap, all-command/tool capture, cache-driven proxies, drift/failed terminal states, eager protection, and Fabric restoration.

The suite covers:
1. **File/Directory Entry Resolution**: Validates resolution of single files, directory conventions (`llm-wiki/index.ts`), and multi-file packages (`pi-quotas` 6 entries), plus error handling.
2. **Idempotent & Concurrent State**: Proves 5 concurrent load requests share one promise, reload is idempotent, and partial failure is marked `failed`.
3. **Safe Settings Pin Transform**: Proves unknown properties are preserved, writes are atomic, and missing/ambiguous entries are refused (tested strictly on temporary data; never modifies user settings).
4. **Non-interactive End-to-End Proof**: Runs `pi` non-interactively:
   - A missing-cache package is loaded eagerly at session start.
   - The unified cache captures its exposed tool.
   - The tool executes in the same session (`answer_42` -> `42`).
