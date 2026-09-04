# Phase 1 verdict: **GO**

Supersedes `spike/SPIKE-RESULTS.md`, which returned NO-GO on a broken harness (see "Why the first spike was wrong" below).

Working spike: `spike2/index.ts`. Evidence: `spike2/report.json`.

## The question

Can a pi extension, mid-session, dynamically load another package's extension and have that package's tools become usable in the same session, without `/reload`?

**Yes.** Proven end to end.

## Proof

```bash
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi -ne -e spike2/index.ts \
  --model google/gemini-3.8-flash \
  -p "First call the lazy_load tool. Then call the fabric_exec tool with code: return 40+2. Tell me the number it returned."
```

Output: `The tool returned **42**.`

```json
{
  "steps": [
    { "step": "before", "fabricPresent": false, "count": 9 },
    { "step": "tool_call_observed", "name": "fabric_exec" }
  ],
  "factoryType": "function",
  "loadMs": 4118,
  "newTools": ["fabric_exec"],
  "fabricExecPresentAfter": true,
  "loadOk": true,
  "ownSessionStartFired": true
}
```

1. `fabric_exec` **absent** at startup (9 tools, `fabricPresent: false`).
2. Present after the mid-session load (`newTools: ["fabric_exec"]`).
3. **Actually executed** by the model, returning the correct answer. Registration alone would not have counted.

## The working recipe

This mirrors pi's own loader (`@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:417`):

```ts
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

const { createJiti } = await import("<jiti>/lib/jiti.mjs");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tryNative: false,
  virtualModules: {
    "@earendil-works/pi-coding-agent": piCodingAgent,
    "@mariozechner/pi-coding-agent": piCodingAgent,
  },
});
const factory = await jiti.import(entryPath, { default: true });
await factory(pi); // the live ExtensionAPI handle
```

Three non-obvious requirements, each of which cost a failed run:

1. **`virtualModules` is mandatory.** Without it the target package's `@earendil-works/pi-coding-agent` peer dependency resolves to a *different copy* of pi, which fails with `Package subpath './lib/core.js' is not defined by "exports"` in `highlight.js`. That error is peer-dep misresolution, not jiti cache duplication. Handing jiti the module objects **we** imported means the loaded extension shares pi's exact instances, which also disposes of the duplicate-instance risk (`typebox`, `withFileMutationQueue`) the plan flagged.
2. **`{ default: true }`** on `jiti.import`, or you get a module namespace rather than the factory function.
3. **No action methods during the load phase.** `pi.getAllTools()` inside the factory throws `Extension runtime not initialized`. Call them only inside tool/command bodies.

## Confirmed caveat: late lifecycle events

`pi-fabric` initialises in a `session_start` handler and printed **"Pi Fabric has not bootstrapped"** when loaded late, exactly the failure mode predicted. The fix belongs in the loader: pass `factory()` a `Proxy` of the `ExtensionAPI` that intercepts `pi.on(...)`, then replay the missed lifecycle events.

Partially validated here: replaying a *synthetic* `session_start` threw `Cannot read properties of undefined (reading 'sessionManager')`. **The real loader must capture the genuine `session_start` event object when it fires at startup and replay that exact object**, not a hand-built stub.

## Design consequence for Phase 2

`pi -ne` showed that **provider extensions contribute models**. `devin/*` models vanish when `pi-devin` isn't loaded. Provider packages (`pi-devin`, `pi-quotas`, `pi-cline-pass`) are therefore poor lazy candidates, since model resolution happens before any tool could trigger a load. They are cheap anyway (~0.10 s each) and are not in the Phase 0 deferral set, so this costs nothing.

## Why the first spike was wrong

The `spike/` NO-GO rested on five defects; three were fatal to its conclusion:

| Claim | Reality |
|---|---|
| `await fabricFactory(mockApi)` | `jiti.import()` returns a namespace; needs `.default` or `{ default: true }`. Calling a namespace always throws. |
| `tool.handler({...})` proves execution | Pi tools expose `execute()`, and `getAllTools()` returns metadata only, with no callable. That test could never pass. |
| "`session_start` never fires via `-e`" | Tested with `--list-models`, which exits without starting a session. It does fire: `ownSessionStartFired: true`. |
| "jiti module-cache duplication" | The error was a Node exports-map mismatch from peer-dep misresolution, fixed by `virtualModules`. |
| Attempt 3 (real end-to-end proof) | Never ran, blocked on API quota. The central question went untested before the NO-GO was issued. |
