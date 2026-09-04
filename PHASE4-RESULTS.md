# Phase 4 — Implementation Result

**Verdict: NO-GO at Phase 4.0. No Phase 4 runtime code shipped.**

## Scope Attempted

Phase 4.0 implemented the smallest design spike:

- `LazyLoader.reserveTool(package, toolName)` captured a selected target registration.
- The real target registration was suppressed to avoid proxy/name replacement ambiguity.
- `LazyLoader.invokeCapturedTool(...)` forwarded the original tool-call ID, parameters, `AbortSignal`, update callback, and context to the captured implementation.
- A prompt-visible `lazy_agent` proxy loaded `@tintinweb/pi-subagents` and delegated to its captured `Agent.execute`.

The deterministic unit tracer passed: registration was captured, the permanent proxy was not replaced, the real target result was returned unchanged, and execution arguments retained identity.

## Live Acceptance Test

The end-to-end spike ran from `/tmp` with an isolated Pi directory and subagents configured with `"extensions": []`.

The exact active set at `before_agent_start` was:

```json
["fabric_exec", "lazy_agent", "lazy_load"]
```

The prompt required a worker to read an unknown random nonce and prohibited the parent from reading the file or using bash.

Observed trace:

```json
{
  "lazyLoadSteps": [],
  "proxyCalls": [],
  "observedToolCalls": ["fabric_exec", "read", "fabric_exec", "bash"]
}
```

The returned nonce was correct, but the parent obtained it directly through Fabric and claimed delegation. `lazy_agent` was never called, pi-subagents was never loaded, and the captured real `Agent.execute` was never invoked.

## Stop Condition

The approved Phase 4 design explicitly required stopping if:

> model behavior still bypasses the proxy

That condition was met. A proxy that exists but is ignored does not solve deferred-capability discovery. Adding keyword routing, automatic prompt classification, or global interception would violate the Phase 4 non-goals and create more machinery than the measured saving justifies.

## Cleanup

All Phase 4 runtime and test-spike changes were removed. The released Phase 3/2.6 implementation was restored and verified:

- TypeScript compilation passed.
- Deterministic checks 1–3 passed.
- Git working tree was clean before adding this report.
- Production settings still keep `@tintinweb/pi-subagents` eager.
- Production Fabric configuration remains `keepVisible: ["fabric_exec", "lazy_load"]`.

Phases 4.1 (hardening), 4.2 (command proxy), 4.3 (profiles), and the Phase 4 release were cancelled because they depended on Phase 4.0 passing.

## Reconsideration Trigger

Reopen Phase 4 only if Pi/Fabric tool-selection behavior changes enough for this same unknown-nonce test to select the proxy without explicit package/tool choreography. Until then, keeping subagents and command/ambient packages eager is the smaller and more reliable design.
