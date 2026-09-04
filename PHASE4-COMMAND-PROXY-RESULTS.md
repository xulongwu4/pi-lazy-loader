# Phase 4.2 — Command Proxy Result

**Verdict: GO for `/token-burden`.**

Phase 4.0's model-selected tool proxy remains a NO-GO. Phase 4.2 is independent because Pi dispatches slash commands deterministically before the model runs.

## Implementation

When settings configure `pi-token-burden` with `"extensions": []`, the eager loader:

1. reserves the target `token-burden` command registration;
2. registers a permanent lightweight `/token-burden` proxy;
3. loads `pi-token-burden` on first invocation;
4. captures and suppresses the target's duplicate command registration;
5. invokes the real captured handler with the original argument string and genuine `ExtensionCommandContext`.

If the package is eager, the loader does not reserve or register the proxy, avoiding collisions.

## Deterministic Checks

`checks/phase4-command-checks.ts` verifies:

- invocation before loading fails clearly;
- concurrent first loads share one factory execution;
- the target command registration is captured and suppressed;
- command arguments and context identity are forwarded unchanged;
- repeated calls reuse the captured handler without reloading;
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

- Release: `v0.2.0` (`5572202`)
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

Only `/token-burden` is proxied. `pi-goal` and other command/ambient extensions remain eager until separately measured and proven. No profile engine or intent heuristic was added.
