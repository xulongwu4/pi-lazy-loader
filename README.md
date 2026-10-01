# pi-lazy-loader

General-purpose deferred extension loader for Pi coding agent. Packages listed in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json` can be loaded mid-session without `/reload`; command and tool proxies are discovered from one persistent cache.

## v0.16.2

- **Added (0.16.0):** Per-tool `toolExposure` overrides, and cache invalidation when a package's fingerprint changes (an upgraded package is re-cached at startup instead of changing tools mid-session).
- **Fixed (0.16.0–0.16.1):** Tool proxies declare the cached description and schema verbatim, so loading the real tool no longer redeclares it and breaks the prompt cache. `prepareArguments` tools still hand off once on their first call.
- **Fixed (0.16.2):** A tool call aborted while its package is loading no longer runs once loading finishes.
- **Known limitation:** With `--no-builtin-tools`, a settings-selected inactive lazy tool can activate differently from an eager tool. Use `--no-tools` to disable all tools or an explicit `--tools` allowlist.

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
pi install git:github.com/xulongwu4/pi-lazy-loader@v0.15.0
```

Declare lazy packages in one of three places, checked in this order (first match wins, never merged):

1. **Inline in `settings.json` `packages`** — add `"lazy"` to an object entry. `"lazy": true` defers with all cached proxies; `"lazy": {tools, commands}` carries the same allowlists as the catalog object form. Pair with `"extensions": []` so Pi installs the package but does not load its extension code eagerly.
2. **`"lazy-loader"` key in `settings.json`** — a `{ "packages": [...] }` block, same entry shape as below.
3. **`lazy-loader.json`** in `${PI_CODING_AGENT_DIR:-~/.pi/agent}` — the standalone fallback.

Inline form, the least duplicated option:

```json
{
  "packages": [
    { "source": "npm:pi-web-access", "extensions": [], "lazy": true },
    { "source": "npm:pi-mcp-adapter", "extensions": [], "lazy": { "tools": ["mcp", "mcpScript"] } }
  ]
}
```

Catalog form (options 2 and 3):

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

Native Pi codemode needs no additional gateway extension. Enable it in `settings.json`:

```json
{
  "defaultTools": ["+codemode"],
  "codemode": { "mode": "only" }
}
```

Use `"mode": "on"` to keep direct tool declarations alongside codemode.

The catalog is read from the first matching location above; the three are never merged. Writes (`/lazy pin`) go back to whichever location provided the catalog — for inline entries, `pin` strips the `"lazy"` flag and leaves the rest of the package entry alone — resolving symlinks so dotfiles links survive. Pi must still be configured not to load the same extension eagerly—for installed resource packages, an `"extensions": []` filter remains one way to do that (built into the inline form).

The unified cache is stored at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader-cache.json`. Each package entry contains `commands` and `tools`. A deferred package without an entry is loaded eagerly once to populate both lists. Later sessions register proxies from the cached names, schemas, and metadata. Every successful package load refreshes the entry with all commands and tools exposed by that package.

Cache format **v2** preserves native Pi tool contracts. Old v1 caches are automatically discarded and rebuilt on the next session; this causes a one-time eager load of configured packages.

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
Extensions often initialize internal state inside `session_start` listeners. When loaded mid-session, that event has already fired.
- `pi-lazy-loader` captures genuine `session_start` and `resources_discover` event objects and contexts at eager startup.
- Late-loaded factories run with a `pi` Proxy that intercepts `pi.on`.
- Handlers registered for `session_start` and `resources_discover` are replayed **exactly once** using the genuine event and context objects.

### 4. Native Codemode Compatibility

Verified against Pi **0.99.1** in both `on` and `only` modes. Proxies preserve `exposure`, `defaultActive`, `outputSchema`, `namespace`, and `annotations` before first use. Hidden/model-only tools stay unavailable to codemode; codemode/deferred tools stay inactive but callable. Structured results are objects from the first cache-safe call.

Tool activation is owned by Pi; the loader does not restore or override a gateway-specific active set. Explicit `defaultTools` selections also apply to newly registered proxies, including tools with `defaultActive: false`, using Pi’s own settings resolver. `/reload` preserves user activation choices for those inactive-by-default tools instead of resetting them from settings; reload state is isolated per session. Host exclusions remain enforced. A live metadata mismatch hands off without executing the target. Packages with `prepareLoadout` hooks or non-JSON metadata load eagerly each session because those contracts cannot be serialized safely.

Invalid cached `exposure` or `defaultActive` values invalidate the entire package entry and trigger an eager rebuild, rather than exposing a tool with unsafe fallback defaults.

Pi 0.99.1’s CLI `--no-tools` maps to SDK `noTools: "all"`; both keep lazy tools unavailable, even when listed in `defaultTools`. The SDK also accepts `"builtin"` for built-in-only disabling; boolean `noTools: true` is not a supported option. Use `tools: [...]` for an explicit allowlist.

### 5. Resources-Discovery Ceiling
Pi runs its resource discovery pass (`resources_discover`) strictly during session startup. While `pi-lazy-loader` replays `resources_discover` so extension callbacks execute their internal book-keeping, Pi does not discover new skills or themes mid-session. This is why keeping skills eager in `settings.json` is essential.

---

## Commands & Tools

### Slash Commands

- Command Proxies: Cached stubs for every command exposed by a deferred package.
  - Registered only when the target package appears in `lazy-loader.json`.
  - Pre-load completions return `null` without loading the package, unless the cache recorded that the target has `getArgumentCompletions` (`hasArgumentCompletions`); then Tab loads the package on demand and serves the real completions.
  - First invocation executes the target factory once, stages and atomically commits registrations, forwards decorated description with delegated provenance (`[target: <pkg>; via pi-lazy-loader]`), and invokes the captured real handler for the in-flight call.
  - Replacement within Pi's command map creates no numeric `:1` suffixes.
  - Each proxy loads its own package, and the real command keeps the proxy's name. Names are recomputed each session from the cache, so they can shift if a package gains or drops a shared name.
    - Deferred packages sharing a name get proxies named like Pi core would: `/cmd:1`, `/cmd:2`, ... in cache order (the order packages were first cached, i.e. bootstrapped).
    - Another extension already holds `/cmd` (or `/cmd:N`): it keeps its name, and lazy proxies are still registered under the next free `/cmd:N` starting at `/cmd:2`. The rename is reported in the startup warning. Only commands registered before session start are seen; if another extension registers `/cmd` later, Pi suffixes the two on its own, and `/lazy list` and the proxy description keep showing the original name.
    - A late command the cache didn't know about (e.g. a package bootstrapped this session) never replaces a registered command: it gets the next free `/cmd:N` starting at `/cmd:2`. A registered `/cmd` cannot be renamed mid-session: if its holder is another deferred package, it stays `/cmd` for that session and becomes `/cmd:1` from the next session on (another extension's `/cmd` never changes).
    - Ranks follow the order packages were cached, not the order they gained a name. A package that was cached before it gained a shared command (stale cache) is ranked by its original cache position, so after its first session it can move ahead of a package that held the name earlier.
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

Package catalogs follow the Configuration sources above. Tool activation reads Pi’s effective `defaultTools` through the extension API; the loader does not rewrite Pi settings files.

### Reload & Restart Semantics

Changes to `lazy-loader.json` take effect after restarting Pi or issuing `/reload`. No filesystem watcher or background daemon is used.
### LLM Tools

- **Direct tool proxies:** Startup proxies register under every cached tool name for deferred packages. Cache-safe tools (JSON-representable schema, no `prepareArguments`, live schema/options match the cache) load the package and invoke the captured `execute` on the first deferred call. Every proxy declares the cached description verbatim, and the cached parameters whenever they are JSON-safe (including `prepareArguments` tools), so loading the real tool does not change the declaration. Missing/stale/non-JSON schema, `prepareArguments`, or metadata mismatch return `executed: false` `retryHandoff` and require a new call against the live host schema/options (a new script for codemode). A proxy declaring `outputSchema` marks this handoff `isError: true`, so scripts reject instead of silently treating guidance text as structured output. Surviving stale-cache proxies return terminal `cacheDrift`; failed loads return terminal reload guidance. Command proxies still load and invoke the captured handler on first use.
- **Sticky Session Failure**: If a package fails to load during a session, subsequent proxy or `/lazy add` calls fail fast without re-entering the load path. Retrying requires `/reload` or session restart.

### Tool Exposure Overrides

A package entry may set `"toolExposure": { "<tool name>": "direct" | "codemode" | "deferred" | "hidden" }` (catalog object form, or inside the inline `"lazy": {...}` options). Names are exact; there are no globs.

```json
{ "source": "npm:pi-web-access", "extensions": [], "lazy": { "toolExposure": { "web_search": "codemode", "fetch_content": "hidden" } } }
```

- The override applies only when the package registers the tool as `direct` (or without an exposure), `codemode`, or `deferred`. A tool the package registers as `hidden` or `model-only` is never promoted.
- The same policy is applied to the startup proxy and to every live registration (first load, late registrations, `/reload`), so an override never makes the loaded tool's exposure differ from the proxy's, and the prompt cache is preserved. Drift checks compare effective exposures, so an override never causes a retry handoff. Loading can still change a declaration for other reasons: a non-JSON-safe cached schema (the proxy declares a loose object) and metadata drift the fingerprint does not detect.
- The cache keeps the package's own exposure; adding or removing an override needs no re-bootstrap. Changes take effect after `/reload` or a new session.

### Cache Freshness

Proxies are declared from `lazy-loader-cache.json`, so a stale entry would only surface on first use, as a mid-session tool redeclaration that invalidates the prompt cache. Each cache entry therefore stores a best-effort package fingerprint; when it is missing or differs at startup, the package is eagerly re-bootstrapped once (the cost moves to that startup). Detected:

- `package.json` content changes, including a version bump
- an entry file replaced, touched, or resized (mtime/size)
- a changed entry list
- a moved package root (realpath)

Not detected: edits only to non-entry files the entries import, dependency changes, same-version repacks that preserve entry mtime and size, registrations that depend on config or environment, and updates while a session is running (caught at the next startup). For those, delete `lazy-loader-cache.json` or load the package eagerly. If a package's bootstrap fails, automatic startup retries are suppressed until its fingerprint changes, but only when the fingerprint was computed successfully; a package whose fingerprint cannot be computed (unresolvable) is retried at every startup. If the cause was transient or environmental, fix it, then run `/reload` (or start a new session) and `/lazy add <pkg>`. The failure only blocks retries for the rest of that session, and a successful load rewrites the cache entry. The package's tools only get proxies from the next startup.

---

## Verification & Checks

Install test dependencies with `bun install`. All checks use temporary fixtures; no globally installed extensions, model credentials, or paid API calls are required.

```bash
bun run check          # resolver, lifecycle, config, and real Pi/QuickJS integration
bun run check:command  # command forwarding, concurrency, failures
bun run check:proxy    # command collisions, atomic commits, packaging
bun run check:v050     # cache, schemas, first-call handoff, late registrations
bun run check:codemode # native on/only modes, metadata, visibility, structured results
bun run check:fingerprint # upgrade re-bootstrap; stable prompt prefix after exposure-changing upgrades
```

Native codemode checks use the pinned Pi 0.99.1 development dependency and cover cold/warm caches, concurrent first calls, exposure and activation defaults, explicit tool selections, reload/session isolation, CLI-equivalent `--no-tools`, eager-only contracts, metadata drift, structured-output error paths, corrupt policy fields, and v1 cache invalidation.
