# pi-lazy-loader Development Status

**Updated:** 2026-09-07
**Released version:** `v0.6.0`
**Release reference:** `v0.6.0`

## Executive Status

`pi-lazy-loader` v0.6.0 is implemented, independently reviewed, merged to `main`, tagged, and pushed. It replaces the fixed package manifest and separate tool cache with settings-driven package discovery and one unified command/tool cache.

## v0.6.0 Architecture

### Package Discovery

Any installed package configured in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json` with exactly `"extensions": []` is lazy-loadable. Package identity and source come from the settings entry and installed `package.json`; `manifest.json` is no longer shipped.

### Unified Cache

The cache is `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader-cache.json`:

```json
{
  "version": 1,
  "packages": {
    "example-package": {
      "tools": [{ "name": "example_tool", "description": "Example tool" }],
      "commands": [{ "name": "example-command", "description": "Example command" }]
    }
  }
}
```

- A missing or incomplete package entry causes one eager load during `session_start`.
- Every successful load replaces the package entry with all observed `registerTool` and `registerCommand` registrations.
- Tools or commands registered later through captured lifecycle handlers also refresh the entry.
- A failed eager bootstrap writes an empty complete entry to avoid blocking every later startup. Use `/lazy add <package>` to retry explicitly, or remove that package entry from the cache before restarting.
- The obsolete `lazy-loader-tools.json` file is ignored, so the first v0.6.0 session performs a fresh bootstrap.

### Proxy Behavior

- Cached command names receive lightweight slash-command proxies. Their first invocation loads the package and invokes the captured real handler immediately.
- Cached tool names receive load-and-retry proxies. Their first invocation loads the package without executing the requested tool and asks the caller to retry using the real loaded schema.
- Package loads remain idempotent and concurrent callers share one in-flight promise.
- Reserved registrations are staged so failed multi-entry loads do not displace startup proxies.

### User Command Overrides

Optional `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader.json` metadata still supports command description overrides and additional declarations. Package keys resolve against settings-discovered deferred packages rather than a fixed manifest.

## Review and Verification

Two independent `anthropic/claude-opus-5` reviews approved the final working-tree diff:

- **Standards:** `APPROVE` — zero blocking findings.
- **Specification:** `APPROVE` — zero blocking findings.

Verified release gates:

- Explicit TypeScript checking for `index.ts`, `src/*.ts`, and active checks.
- Bun bundle build.
- `bun run check:command`.
- `bun run check:proxy`, including exact package allowlist and clean packed install.
- `bun run check:v050`, including arbitrary package discovery, missing-cache bootstrap, complete command/tool capture, failure markers, cache-driven proxies, collisions, and Fabric restoration.
- Core `bun run check` checks 1–3 pass. Its external-model Check 4 is currently blocked by an invalid configured Google API key, not a repository failure.

## Published Files

The v0.6.0 package allowlist contains 13 files:

```text
README.md
index.ts
lazy-loader.schema.json
package.json
src/cache.ts
src/command-config.ts
src/command-presentation.ts
src/loader.ts
src/package-locator.ts
src/package.ts
src/resolver.ts
src/settings.ts
src/tool-proxy.ts
```

## Release History

| Version | Result |
|---|---|
| `v0.1.0` | Initial targeted lazy loading |
| `v0.1.1` | Optional Pi peer dependencies |
| `v0.2.0` | Deterministic token-burden command proxy |
| `v0.2.1` | Real command-definition handoff |
| `v0.3.0` | Generic command proxies and grouped user configuration |
| `v0.3.1` | Tool-cache prompt guidance and sticky failures |
| `v0.3.2` | Tool metadata and Pi ABI fingerprints |
| `v0.3.3` | Managed-install Pi ABI fallback |
| `v0.3.4` | Symlink-aware Pi CLI resolution |
| `v0.4.0` | Two-tier direct tool proxies |
| `v0.5.0` | Consolidated load-and-retry tool proxies |
| `v0.6.0` | Settings-driven packages and unified command/tool cache |

## Known Limitations

- Discovery currently reads the global agent-directory settings file; project-local `.pi/settings.json` overrides are not merged.
- Cache keys use the installed package name. Two deferred sources declaring the same package name cannot coexist and the later setting wins.
- A failed-bootstrap marker suppresses automatic retries until `/lazy add <package>` is used or the cache entry is removed.
- Fabric and provider/ambient extensions that must initialize before model selection should remain eager.

## Current Decision

`v0.6.0` is the active release baseline. Upgrade the managed package reference and reload existing Pi sessions; the first session eagerly rebuilds the unified cache, and subsequent sessions defer cached packages normally.
