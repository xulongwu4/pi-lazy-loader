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
