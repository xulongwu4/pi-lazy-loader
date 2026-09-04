# Phase 2.6 — Controlled expansion and release validation

**Verdict: retain web, MCP, and dynamic workflows as deferred. Keep Fabric and subagents eager.**

## Expansion

Settings backup before expansion:

```text
/home/oulongwu/.pi/agent/settings.json.phase2.6-backup-20260904-093628
```

Fabric settings backup:

```text
/home/oulongwu/.pi/agent/fabric.json.phase2.6-backup-20260904-094220
```

Final extension filters:

- `npm:pi-web-access`
- `npm:pi-mcp-adapter`
- `npm:@quintinshaw/pi-dynamic-workflows`

## Findings

### Fabric integration

`lazy_load` must be listed with `fabric_exec` in Fabric's `capture.keepVisible`; otherwise its prompt metadata is removed and cold discovery is unreliable. Newly registered target tools briefly became native-active during the same turn. The loader now snapshots the active set, refreshes Fabric's captured catalog through `getAllTools()`, and restores the prior set. Verified after loading workflows: active tools remained exactly `lazy_load` and `fabric_exec`, while `workflow` executed through Fabric.

### Subagents rejected for deferral

`@tintinweb/pi-subagents` loads technically, but three natural-language delegation probes bypassed it and executed work directly through Fabric. One probe falsely claimed a worker read a nonce while the trace showed direct `fabric_exec` → `read`. The package was restored eager rather than adding proxy/stub complexity.

### Dynamic workflows accepted

A cold request discovered `lazy_load`, loaded `@quintinshaw/pi-dynamic-workflows` in 752 ms, and executed `workflow`. No bootstrap errors occurred, and `workflow`/`workflow_control` remained off the native active path after the isolation fix.

## Startup A/B

Interleaved settings comparison, alternating order to reduce cache bias:

```text
eager: 8.45, 7.43, 7.32, 9.78, 8.08, 6.72
lazy:  6.91, 6.10, 6.74, 6.70, 6.27, 6.01
```

- Minimum improvement: **0.71 s**
- Median improvement: approximately **1.27 s**

These figures compare only dynamic workflows eager vs deferred under otherwise identical Phase 2.6 settings.

## Verification

- TypeScript compilation: passed.
- Deterministic checks 1–3: passed.
- Fresh Pi startup: passed.
- `/lazy list`: reflects actual settings (seven eager/loaded, three deferred).
- Fabric active set at `before_agent_start`: `lazy_load`, `fabric_exec`.
- Workflow cold discovery and execution: passed.
- Same-turn Fabric isolation after dynamic registration: passed.

## Release

- Public repository: https://github.com/xulongwu4/pi-lazy-loader
- Installed package source: `git:github.com/xulongwu4/pi-lazy-loader@v0.1.1`
- `v0.1.1` makes Pi peer dependencies optional; the managed install contains only `jiti`, not a duplicate Pi runtime.
- The absolute checkout extension path was removed from settings after the tagged package passed a fresh-start smoke test.

## Upstream Vertex retry report

The exact historical issue was updated rather than duplicated: https://github.com/earendil-works/pi/issues/3218#issuecomment-5541622435

The comment includes the 0.84.4 deterministic retry-classification repro, 12/12 healthy ADC refresh controls, both failing agent transports, and the tested `request to .* failed, reason:` pattern.

## Rollback

Restore both settings atomically:

```bash
settings_target="$(readlink -f ~/.pi/agent/settings.json)"
cp -p ~/.pi/agent/settings.json.phase2.6-backup-20260904-093628 "${settings_target}.restore"
mv -f "${settings_target}.restore" "$settings_target"

fabric_target="$(readlink -f ~/.pi/agent/fabric.json)"
cp -p ~/.pi/agent/fabric.json.phase2.6-backup-20260904-094220 "${fabric_target}.restore"
mv -f "${fabric_target}.restore" "$fabric_target"
```
