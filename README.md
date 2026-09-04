# pi-lazy-loader

Deferred on-demand extension loader for Pi coding agent. Recovers **4.257 seconds** (80.8%) of extension startup overhead across the ten highest-cost Phase 0 packages, loading them on-demand mid-session without `/reload`.

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

Deferring these ten packages reduces startup time from **5.83 s to ~1.58 s**.

---

## Configuration

To defer extension loading while keeping skills, prompts, and themes eager, configure the ten packages in `~/.pi/agent/settings.json` using Pi's object-form filter with `"extensions": []`:

```json
{
  "packages": [
    { "source": "npm:pi-fabric", "extensions": [] },
    { "source": "npm:@zosmaai/pi-llm-wiki", "extensions": [] },
    { "source": "npm:@tintinweb/pi-subagents", "extensions": [] },
    { "source": "npm:@quintinshaw/pi-dynamic-workflows", "extensions": [] },
    { "source": "npm:@narumitw/pi-goal", "extensions": [] },
    { "source": "npm:pi-token-burden", "extensions": [] },
    { "source": "npm:pi-antigravity", "extensions": [] },
    { "source": "npm:pi-mcp-adapter", "extensions": [] },
    { "source": "npm:pi-web-access", "extensions": [] },
    { "source": "git:github.com/xulongwu4/pi-quotas", "extensions": [] }
  ]
}
```

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

Keep `pi-fabric` **eager** when using Fabric as the exclusive tool gateway. Although late loading registers and executes `fabric_exec`, Fabric loaded after session startup cannot attach its capture interceptor to the already-running bundled `ExtensionRunner`; subsequently loaded extension tools remain top-level. With Fabric eager, dynamically loaded tools are captured correctly and the active set remains only `fabric_exec`.

The Phase 2.5 guarded configuration therefore defers `pi-web-access` and `pi-mcp-adapter`, but not `pi-fabric`.

### 5. Resources-Discovery Ceiling
Pi runs its resource discovery pass (`resources_discover`) strictly during session startup. While `pi-lazy-loader` replays `resources_discover` so extension callbacks execute their internal book-keeping, Pi does not discover new skills or themes mid-session. This is why keeping skills eager in `settings.json` is essential.

---

## Commands & Tools

### Slash Commands

- `/lazy list`: Show status (`deferred`, `loading`, `loaded`, `failed`), measured startup cost, and capabilities for all 10 packages.
- `/lazy add <package>`: Dynamically load a package extension into the current session.
  - Idempotent: Subsequent calls return immediately.
  - Concurrent-safe: In-flight calls share a single promise.
  - Atomic multi-entry: All entry points must succeed; partial failure leaves status as `failed`.
- `/lazy pin <package>`: Remove `"extensions": []` from matching package object in `settings.json` so it loads eagerly on subsequent startups.
  - Preserves all unknown/custom properties.
  - Writes atomically (temp file + rename).
  - Refuses missing or ambiguous package entries.

### LLM Tool

- `lazy_load`: Strict TypeBox schema accepting exactly one string parameter:
  ```json
  {
    "package": "pi-fabric"
  }
  ```
  Dynamically loads the target package and makes its tools (e.g. `fabric_exec`) available to the model within the same session.

---

## Verification & Checks

Run the verification suite:

```bash
bun checks/run-checks.ts
```

The suite covers:
1. **File/Directory Entry Resolution**: Validates resolution of single files, directory conventions (`llm-wiki/index.ts`), and multi-file packages (`pi-quotas` 6 entries), plus error handling.
2. **Idempotent & Concurrent State**: Proves 5 concurrent load requests share one promise, reload is idempotent, and partial failure is marked `failed`.
3. **Safe Settings Pin Transform**: Proves unknown properties are preserved, writes are atomic, and missing/ambiguous entries are refused (tested strictly on temporary data; never modifies user settings).
4. **Non-interactive End-to-End Proof**: Runs `pi` non-interactively with `google/gemini-3.8-flash`:
   - `fabric_exec` is verified absent before lazy load.
   - Model calls `lazy_load` for `pi-fabric`.
   - `fabric_exec` is dynamically registered and executed in the same session (`return 40+2` -> `42`).
   - Zero `"Pi Fabric has not bootstrapped"` errors.
