# Phase 4.2 — Command Proxy Result

**Verdict: GO for `/token-burden`.**

Phase 4.0's model-selected tool proxy remains a NO-GO. Phase 4.2 is independent because Pi dispatches slash commands deterministically before the model runs.

## Implementation

When settings configure `pi-token-burden` with `"extensions": []`, the eager loader:

1. reserves the target `token-burden` command registration;
2. registers a lightweight `/token-burden` startup stub with a synthesized lazy description;
3. loads `pi-token-burden` on first invocation;
4. captures and forwards the target registration, replacing the stub with the real description, completions, and handler in the same extension command map;
5. invokes the captured real handler for the in-flight first command with the original argument string and genuine `ExtensionCommandContext`.

If the package is eager, the loader does not reserve or register the proxy, avoiding collisions.

## Deterministic Checks

`checks/phase4-command-checks.ts` verifies:

- invocation before loading fails clearly;
- concurrent first loads share one factory execution;
- the target command registration is captured and replaces the startup stub without a numeric suffix;
- the real description and argument completions replace the synthesized metadata;
- command arguments and context identity are forwarded unchanged;
- subsequent calls use the real registered handler without reloading;
- target errors propagate unchanged.

## Real TUI Proof

An isolated tmux session started Pi with `pi-token-burden` filtered and the loader extension eager. Sending:

```text
/token-burden
```

opened the genuine bordered **Token Burden** overlay. The loader diagnostic contained:

```json
{
  "step": "proxy_call",
  "proxy": "/token-burden",
  "target": "token-burden"
}
```

The overlay was absent before command invocation, proving it came from first-use loading rather than eager registration.

## Description Handoff Proof

A real Pi TUI session queried `pi.getCommands()` before and after first invocation:

```text
before: [lazy] load pi-token-burden then run /token-burden
after:  Show token budget breakdown and manage skills
```

Both snapshots contained exactly one unsuffixed `token-burden` command. Canonical `sourceInfo` remained `pi-lazy-loader`, because Pi derives provenance from the registering `ExtensionAPI`; only the target's real command options are inherited.

The managed `v0.2.1` production install reproduced the same transition with source path `/home/oulongwu/.pi/agent/git/github.com/xulongwu4/pi-lazy-loader/index.ts` and opened the genuine overlay. Its pre-upgrade rollback backup is:

```text
/home/oulongwu/.pi/agent/settings.json.command-description-backup-20260904-114748
```

## Performance

Alternating-order A/B startup measurements:

```text
eager: 8.62, 6.15, 8.77, 8.28, 7.44, 6.23
lazy:  6.83, 5.36, 6.43, 7.82, 6.12, 4.98
```

- Eager minimum: **6.15 s**
- Deferred minimum: **4.98 s**
- Minimum improvement: **1.17 s**
- Median improvement: approximately **1.59 s**

## Release and Production Proof

- Initial command-proxy release: `v0.2.0` (`5572202`)
- Description-handoff release: `v0.2.1` (`5be632a`)
- Installed source: `git:github.com/xulongwu4/pi-lazy-loader@v0.2.0`
- Managed dependencies: `jiti` only; zero duplicate Pi peers
- Production tmux invocation of `/token-burden`: **PASS**
- Production startup runs: **5.05 s, 4.86 s, 5.28 s**
- `/lazy list` reports token-burden, workflows, MCP, and web as deferred

Pre-install settings backup:

```text
/home/oulongwu/.pi/agent/settings.json.phase4-command-backup-20260904-110550
```

Atomic rollback:

```bash
target="$(readlink -f ~/.pi/agent/settings.json)"
cp -p ~/.pi/agent/settings.json.phase4-command-backup-20260904-110550 "${target}.restore"
mv -f "${target}.restore" "$target"
pi install git:github.com/xulongwu4/pi-lazy-loader@v0.1.1
```

## Scope

Only `/token-burden` uses the startup-stub handoff. `pi-goal` and other command/ambient extensions remain eager until separately measured and proven. No profile engine or intent heuristic was added.

---

# Phase 4.3 — v0.3.0 Command Proxy & MCP Matrix Result

**Verdict: GO for `pi-mcp-adapter` (`/mcp`, `/pi-mcp`, `/mcp-auth`) and `pi-token-burden` (`/token-burden`).**

## v0.3.0 Release Verification & Clean Pack Smoke

- **Version bump**: `v0.3.0`
- **Packed tarball**: `pi-lazy-loader-0.3.0.tgz`
- **Explicit packaging allowlist**: Exactly 11 published files validated by `npm pack --dry-run --json`:
  `README.md`, `index.ts`, `lazy-loader.schema.json`, `manifest.json`, `package.json`, `src/command-config.ts`, `src/command-presentation.ts`, `src/loader.ts`, `src/manifest.ts`, `src/resolver.ts`, `src/settings.ts`. Extra files fail the check.
- **Clean consumer install**: Installed packed tarball via `bun add` in an isolated clean temporary project. Verified zero duplicate `@earendil-works` Pi runtime peer dependencies.
- **Installed entry startup**: Started Pi non-interactively directly from `node_modules/pi-lazy-loader/index.ts` with zero errors.

## Isolated Detached tmux TUI Matrix

A cold Pi session was initialized in detached tmux with `pi-mcp-adapter` and `pi-token-burden` deferred (`"extensions": []`) inside an isolated temporary `PI_CODING_AGENT_DIR` (symlinking cache/auth files; never mutating `~/.pi`).

### Startup Proxy Stubs Snapshot

Prior to invoking any command, Pi's registered slash commands map contained:

- `/token-burden`: `Show token-budget usage [lazy target: pi-token-burden; proxy: pi-lazy-loader]`
- `/mcp`: `Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]`
- `/pi-mcp`: `Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]`
- `/mcp-auth`: `Authenticate with an MCP server [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]`
- **Numeric suffixes**: None (`token-burden:1`, `mcp:1`, `pi-mcp:1`, `mcp-auth:1` were verified absent).
- **Tab completions**: Pre-load `getArgumentCompletions` returned `null` without loading the package or executing factory code.

### Command Execution Evidence

1. **`/token-burden`** (first use: 1,282 ms):
   - Opened genuine bordered **Token Burden** overlay showing category breakdown (`Base`, `Skills`, `Tools`, `System Prompt`).
   - Diagnostic captured: `{ step: "proxy_call", proxy: "/token-burden", target: "token-burden" }`.
   - Dismissed via `Escape`.

2. **`/mcp`** (first use: 765 ms):
   - Dynamically loaded `pi-mcp-adapter` in one factory execution and staged all three target registrations.
   - Atomically replaced `/mcp`, `/pi-mcp`, and `/mcp-auth` stubs in Pi's command map.
   - Opened genuine bordered **MCP Servers** panel (`╭───────────────────────────────── MCP Servers ──────────────────────────────────╮`).
   - Dismissed via `Escape`.

3. **`/pi-mcp`** (subsequent call: 259 ms):
   - Reused already-loaded adapter without re-executing extension factory.
   - Opened genuine bordered **MCP Servers** panel directly.
   - Dismissed via `Escape`.

4. **`/mcp-auth missing-server`** (execution: 260 ms):
   - Invoked captured target handler for `mcp-auth` with argument `"missing-server"`.
   - Rendered real handler error notification:
     ```text
     Error: Server "missing-server" not found in config
     ```
   - Confirmed **zero OAuth flow or browser window launched** for unknown/missing server argument.

### Post-Load Handoff & Provenance Verification

Querying `pi.getCommands()` after all four invocations confirmed:
- All four commands replaced their startup stubs in-place within Pi's command map.
- Descriptions inherited real target descriptions and appended delegated attribution:
  - `/token-burden`: `... [target: pi-token-burden; via pi-lazy-loader]`
  - `/mcp`: `... [target: pi-mcp-adapter; via pi-lazy-loader]`
  - `/pi-mcp`: `... [target: pi-mcp-adapter; via pi-lazy-loader]`
  - `/mcp-auth`: `... [target: pi-mcp-adapter; via pi-lazy-loader]`
- **Numeric suffixes**: Confirmed absent (0 suffixed entries).
- Canonical `sourceInfo` remained `pi-lazy-loader` without spoofing.

## v0.3.0 Alternating A/B Startup Benchmark

Measured across 6 alternating iterations on isolated test agent directories using `pi --list-models`:
- **Eager configuration**: `pi-mcp-adapter` and `pi-token-burden` eager in `settings.json`.
- **Deferred (Lazy) configuration**: `pi-mcp-adapter` and `pi-token-burden` deferred with `"extensions": []`, `pi-lazy-loader` active.

### Raw Measurements

| Iteration | Order | Eager (s) | Deferred / Lazy (s) | Net Savings (s) |
|---|---|---|---|---|
| 1 | Eager → Lazy | 1.179 | 0.659 | +0.520 |
| 2 | Lazy → Eager | 1.412 | 0.698 | +0.714 |
| 3 | Eager → Lazy | 1.325 | 0.679 | +0.646 |
| 4 | Lazy → Eager | 1.348 | 0.694 | +0.654 |
| 5 | Eager → Lazy | 1.217 | 0.661 | +0.556 |
| 6 | Lazy → Eager | 1.405 | 0.639 | +0.767 |

### Summary Statistics

- **Eager runs**: 1.179, 1.412, 1.325, 1.348, 1.217, 1.405 s
  - Minimum: **1.179 s**
  - Median: **1.336 s**
- **Deferred / Lazy runs**: 0.659, 0.698, 0.679, 0.694, 0.661, 0.639 s
  - Minimum: **0.639 s**
  - Median: **0.670 s**
- **Median net improvement**: **+0.667 s** (~50% reduction in cold startup time)
- **All iterations**: Positive net savings across every alternating order.
