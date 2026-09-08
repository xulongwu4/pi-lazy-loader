# Tool Proxy Design (Phase 5)

**Status:** Implemented (consolidated single load-and-retry proxy design)
**Target:** `v0.5.0`
**Depends on:** v0.3.0 command-proxy machinery (`LazyLoader.reserveCommand`, staged commit)

## Goal

A call to a declared tool of a deferred package should load that package, publish the real tool, and tell the model to retry. The proxy must not execute the original tool call or echo its arguments.

Package loading is internal (`LazyLoader.loadPackage`, `/lazy add`, cache bootstrap). Retry guidance belongs to the tool proxy that knows which tool the model intended to invoke.

## Runtime Mechanics

### 1. Startup Proxy Registration

Startup proxies register under real tool names declared in `manifest.json`.

- **Description:** Leads with the cached real tool description, falling back to manifest capability, then explains that invoking the proxy loads the package and requires calling the tool again with its loaded schema.
- **Parameters:** Permissive schema (`additionalProperties: true`) avoids premature validation against an unavailable real schema.
- **Privacy:** Caller arguments are ignored and never echoed.

### 2. Proxy Invocation

For a deferred or currently loading package, the proxy:

1. Calls `LazyLoader.loadPackage(packageName)`.
2. Waits on the package's shared in-flight promise.
3. Does not invoke the real tool.
4. Returns `loaded: true`, `executed: false`, and `retryTool` with an explicit instruction to call the real tool again.

A stale proxy reference invoked after another call completed loading also returns retry guidance without loading again.

### 3. Real-Tool Displacement

During package initialization, reserved real-tool registrations are staged. After every extension entry and lifecycle replay succeeds, `LazyLoader` publishes those registrations through `pi.registerTool`. Same-name real registrations replace the startup proxies.

If loading fails, staged reserved tools are discarded and the proxies remain. Package failure is sticky for the session.

### 4. Terminal Guards

- **Missing declaration:** If loading succeeds but the requested declared tool was not registered, the proxy returns a terminal manifest-drift error without retry guidance.
- **Failed package:** The proxy returns terminal reload/restart guidance without retry guidance.
- **Collision:** If an eager extension already owns a declared name, proxy registration is skipped and that name is protected from overwrite during deferred loading.

### 5. Internal package load

`LazyLoader.loadPackage()` remains the internal load seam. `/lazy add` and cache bootstrap call it. There is no LLM-facing `lazy_load` tool; cached real-name proxies load deferred packages on first invocation.

### 6. Advisory Tool Cache (v3)

`lazy-loader-tools.json` stores only declared tool names and descriptions:

```json
{ "version": 3, "packages": { "pkg": { "tools": [{ "name": "tool", "description": "Capability" }] } } }
```

- Proxy descriptions use cached descriptions when available.
- Only manifest-declared tools observed during loading are cached.
- v1 and v2 files normalize to v3 on read.
- Reads and writes fail soft and enforce a 64 KiB cap.
- Schemas, fingerprints, ABI checks, prompt metadata, and execution metadata are not cached.

### 7. Fabric Integration

Proxy-triggered loading lets Fabric observe newly registered tools before restoring the previous native active-tool set in `finally`.
