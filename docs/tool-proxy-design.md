# Tool Proxy Design (Phase 5)

**Status:** Implemented (cache-safe load-then-invoke; retry handoff when the live contract differs)
**Target:** `v0.5.0`
**Depends on:** v0.3.0 command-proxy machinery (`LazyLoader.reserveCommand`, staged commit)

## Goal

A call to a declared tool of a deferred package loads that package and publishes the real tool. When the cached schema/options are JSON-safe and match the live tool, the proxy invokes the captured `execute` with the original arguments and returns that result unchanged. Otherwise it returns `executed: false` `retryHandoff` and the model must call the live tool again. Command proxies still invoke the captured handler on the in-flight first call.

Package loading is internal (`LazyLoader.loadPackage`, `/lazy add`, cache bootstrap). Invocation belongs to the tool proxy that knows which tool the model intended to invoke.

## Runtime Mechanics

### 1. Startup Proxy Registration

Startup proxies register under cached tool names for deferred packages (honor `lazy-loader.json` `tools` allowlists).

- **Description:** Cached tool description, else `Tools provided by <package>`. Appends a load-then-invoke note when the cached schema is JSON-safe and `hasPrepareArguments` is not true; otherwise appends retry-guidance.
- **Parameters:** Cached JSON-safe `parameters` when `isCachedToolSchema`; otherwise `Type.Object({}, { additionalProperties: true })`. Cached `executionMode` / `constrainedSampling` are copied onto the proxy.
- **Privacy:** Proxy payloads never echo caller params.

### 2. Proxy Invocation

For a deferred or currently loading package, the proxy:

1. Calls `LazyLoader.loadPackage(packageName)`.
2. Waits on the package's shared in-flight promise.
3. Invokes the captured tool when `canInvoke` is set and live schema/options match the cache; otherwise returns `retryHandoff` (`executed: false`) so the model retries against the live host schema.
4. On a cache-safe match, calls `LazyLoader.invokeCapturedTool(...)` with the original tool-call ID, parameters, abort signal, update callback, and context, and returns that result unchanged.

A stale proxy reference after a successful cache-safe invoke calls the captured tool again without loading again. A stale proxy after `retryHandoff` still requires the second call against the live tool.

### 3. Real-Tool Displacement

During package initialization, reserved real-tool registrations are staged. After every extension entry and lifecycle replay succeeds, `LazyLoader` publishes those registrations through `pi.registerTool`. Same-name real registrations replace the startup proxies.

If loading fails, staged reserved tools are discarded and the proxies remain. Package failure is sticky for the session.

### 4. Terminal Guards

- **Missing declaration:** If loading succeeds but the requested declared tool was not registered, the proxy returns a terminal manifest-drift error without retry guidance.
- **Failed package:** The proxy returns terminal reload/restart guidance without retry guidance.
- **Collision:** If an eager extension already owns a declared name, proxy registration is skipped and that name is protected from overwrite during deferred loading.

### 5. Internal package load

`LazyLoader.loadPackage()` remains the internal load seam. `/lazy add` and cache bootstrap call it. There is no LLM-facing `lazy_load` tool; cached real-name proxies load deferred packages on first invocation.

### 6. Unified Cache (`lazy-loader-cache.json` v1)

`${PI_CODING_AGENT_DIR:-~/.pi/agent}/lazy-loader-cache.json` (`version: 1`) stores observed tools and commands per `src/cache.ts`:

```json
{
  "version": 1,
  "packages": {
    "pkg": {
      "tools": [{
        "name": "tool",
        "description": "Capability",
        "parameters": { "type": "object" },
        "executionMode": "parallel",
        "constrainedSampling": false,
        "hasPrepareArguments": true
      }],
      "commands": [{ "name": "cmd", "description": "Slash command" }]
    }
  }
}
```

- Tool entries may include JSON-safe cached `parameters` plus `executionMode` / `constrainedSampling` / `hasPrepareArguments`. Commands store name and description only.
- Non-JSON, cyclic, Refine/Codec, and unknown `~` schemas are omitted (fail closed); invalid files read as empty.
- Cache-safe first deferred call load-then-invokes after live schema/options equivalence. Missing, stale, non-JSON, Refine/Codec, `prepareArguments`, or metadata mismatch returns `executed: false` `retryHandoff`; the model must call the live host tool. Proxy payloads never echo params.
- Command proxies still load and invoke the captured handler on the in-flight first call.
- Every successful load (and later observed registrations) replaces that package entry. Reads/writes fail soft; updates are lock/rename atomic. Obsolete `lazy-loader-tools.json` is ignored.

### 7. Fabric Integration

Proxy-triggered loading lets Fabric observe newly registered tools before restoring the previous native active-tool set in `finally`.
