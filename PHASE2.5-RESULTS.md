# Phase 2.5 — Dogfood and integration validation

**Verdict: GO with `pi-fabric` kept eager.**

## Results by gate

1. **Checkpoint:** initialized Git and committed Phase 2 as `d6c4a50`.
2. **Clean install:** `npm pack` installed into an isolated temporary project. The installed copy loaded under Pi, lazily loaded `pi-fabric`, and executed `fabric_exec` (`6*7 → 42`). The package contains eight runtime files only.
3. **Fabric load order:** loading Fabric late registers `fabric_exec`, but its capture interceptor cannot attach to the already-running bundled `ExtensionRunner`; late tools remain top-level. Keeping Fabric eager works: `lazy_load` and newly loaded tools are captured as `extensions.*`, while the active tool set remains only `fabric_exec`.
4. **Guarded configuration:** preserved the `settings.json` symlink, backed up its target, enabled this checkout as an eager extension, kept `pi-fabric` eager, and set `extensions: []` only on `pi-web-access` and `pi-mcp-adapter`.
5. **Fresh-process dogfood:** `/lazy list` reports eight eager/loaded and two deferred packages. Web loaded in 133 ms and MCP in 216 ms in the explicit probes; both tools executed through Fabric. `session_shutdown: quit` was observed. SDK `newSession()` changed the session ID and `/lazy list` remained available after replacement.
6. **Cold discovery:** without mentioning the loader or package names, a web request discovered `lazy_load`, loaded `pi-web-access`, and used `fetch_content`/`web_search`; an MCP request loaded `pi-mcp-adapter` and used `mcp`. Phase 3 semantic discovery is not required yet.
7. **Final setting:** retain the verified two-package trial configuration.

## Startup

Fresh three-run minimum before the trial: **5.99 s**. After enabling the loader and deferring web/MCP: **5.47 s** (0.52 s / 8.7% improvement). This intentionally leaves the 1.102 s Fabric cost eager for gateway correctness.

## Defects found and fixed

- `/lazy list` initially called every manifest entry deferred, including eagerly configured packages. `LazyLoader.syncConfiguredEager()` now reconciles string/object settings before commands can run, preventing duplicate factories.
- SDK commands may run before a mode emits `session_start`; reconciliation now also occurs during loader construction.
- Deterministic checks can run with `PI_LAZY_SKIP_E2E=1`, avoiding unrelated model quota failures.
- Diagnostic reports now record active-tool snapshots around each load.

## Current configuration and rollback

Settings symlink:

```text
/home/oulongwu/.pi/agent/settings.json
  -> /home/oulongwu/Documents/dotfiles/snowblocks/pi/settings.json
```

Backup:

```text
/home/oulongwu/.pi/agent/settings.json.phase2.5-backup-20260904-001915
```

Atomic rollback (preserves the symlink):

```bash
target="$(readlink -f ~/.pi/agent/settings.json)"
cp -p ~/.pi/agent/settings.json.phase2.5-backup-20260904-001915 "${target}.phase2.5-restore"
mv -f "${target}.phase2.5-restore" "$target"
```

## Remaining caveats

- The loader is currently enabled by absolute checkout path; publishing/installing should replace that with a package source.
- `pi-antigravity` remains eager because provider models may be required before a tool can request lazy loading.
- The local Vertex retry matcher hot patch is outside this repository and will be overwritten by a Pi update.
