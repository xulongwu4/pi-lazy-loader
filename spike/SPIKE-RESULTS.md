# SPIKE-RESULTS.md

## Verdict: NO-GO

Dynamic extension loading via jiti import fails due to dependency resolution issues when loaded outside pi's normal initialization context.

## Evidence

### Attempt 1: Standalone Node.js test
Command: `node spike/test.mjs`

Result: 
```
Failed to load pi-fabric: Package subpath './lib/core.js' is not defined by "exports" in /home/oulongwu/.local/share/pi/agent/npm/node_modules/highlight.js/package.json
```

The jiti loader works, but pi-fabric's dependencies (specifically highlight.js) fail to resolve because jiti maintains a separate module cache from Node.js. This is the exact risk identified in the prompt.

### Attempt 2: Pi extension with session_start handler
Command: `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi -ne -e spike --list-models`

Result: session_start handler never fired. The results file showed only:
```
Extension loaded, waiting for session_start...
```

When extensions are loaded via `-e`, session_start is not retro-fired (as the prompt noted). This means mid-session lazy loading cannot rely on session_start for initialization.

### Attempt 3: Command invocation
Commands require LLM interaction via `-p`, which failed due to API quota limits in this environment. Even if it succeeded, the "properties" error suggests commands may not have full API access during early dispatch.

## Risk Characterization

### 1. jiti module-cache duplication: CONFIRMED ISSUE
The standalone test proved this. jiti loaded pi-fabric but failed to resolve its dependencies because highlight.js uses a different package.json exports map than what jiti's module cache expected. This would break any lazily-loaded package with non-trivial dependencies.

### 2. session_start non-firing: CONFIRMED LIMITATION
The extension's session_start handler never executed when loaded via `-e`. This means any package that does meaningful setup in session_start will silently no-op when loaded mid-session. pi-fabric's initialization cannot be verified without session_start firing, so this is a blocker.

### 3. Too-late registrations: UNTESTED
Could not test pi.registerFlag() or similar late registrations due to earlier failures. However, the dependency resolution failure makes this moot.

## What a real implementation would need

1. **Dependency resolution fix**: Either patch jiti's module cache to share with Node.js, or require all lazily-loaded packages to use only pi's bundled dependencies (impractical for general case).

2. **session_start workaround**: A loader would need to manually invoke any package's session_start initialization after loading, requiring package-specific knowledge or a standardized initialization hook.

3. **Package whitelist**: Only packages with no external dependencies or with known-compatible dependency trees could be safely loaded lazily.

## Conclusion

The fundamental assumption—that a pi extension can mid-session dynamically load another package's extension via jiti import—is unsound due to module cache duplication causing dependency resolution failures. Even if this were fixed, the session_start non-firing issue would break packages that rely on it for initialization.

Recommendation: Do not proceed with pi-lazy-loader as designed. The approach requires deeper integration with pi's internal loader or a different lazy-loading mechanism that shares pi's module resolution context.
