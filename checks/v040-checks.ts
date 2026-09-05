import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LazyLoader } from "../src/loader.js";
import { MANIFEST } from "../src/manifest.js";
import { registerToolProxies, selectToolProxyTier } from "../src/tool-proxy.js";
import { computePackageFingerprint, type CachedTool, type ToolCacheData } from "../src/tool-cache.js";
import { resolvePackageEntries, resolvePackageRoot } from "../src/resolver.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function fixture(root: string, packageName: string, body: string) {
  const dir = join(root, "npm", "node_modules", packageName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: packageName,
    version: "1.0.0",
    pi: { extensions: ["index.js"] },
  }), "utf-8");
  writeFileSync(join(dir, "index.js"), body, "utf-8");
}

function fakePi(active: string[] = []) {
  const tools = new Map<string, any>();
  const restored: string[][] = [];
  return {
    tools,
    restored,
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
    getAllTools() { return Array.from(tools.values()); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { restored.push([...names]); },
  };
}

function entry(name: string) {
  const found = MANIFEST.find((item) => item.name === name);
  assert(found, `manifest entry ${name} must exist`);
  return found;
}

function warmCache(root: string, packageName: string, tools: CachedTool[]): ToolCacheData {
  const manifest = entry(packageName);
  const paths = resolvePackageEntries(manifest, root);
  return {
    version: 2,
    packages: {
      [packageName]: {
        fingerprint: computePackageFingerprint(resolvePackageRoot(manifest.source, root), paths),
        tools,
      },
    },
  };
}

const emptyCache: ToolCacheData = { version: 2, packages: {} };
console.log("=== Running v0.4.0 Tool Proxy Checks ===\n");

console.log("--- Check 1: Tier Selection ---");
{
  const complete: CachedTool = {
    name: "web_search", label: "Web Search", description: "Search", parameters: { type: "object" },
    hasPrepareArguments: false,
  };
  assert(selectToolProxyTier({ name: "web_search", faithful: true }, complete, true) === 1, "complete fresh faithful tool -> Tier 1");
  assert(selectToolProxyTier({ name: "web_search", faithful: true }, complete, false) === 2, "stale cache -> Tier 2");
  assert(selectToolProxyTier({ name: "web_search", faithful: true }, { ...complete, hasPrepareArguments: true }, true) === 2, "prepare hook -> Tier 2");
  assert(selectToolProxyTier({ name: "web_search" }, complete, true) === 2, "undeclared fidelity -> Tier 2");
  assert(selectToolProxyTier({ name: "web_search", faithful: true }, { ...complete, parameters: null }, true) === 2, "invalid cached schema -> Tier 2");
  console.log("  ✓ Tier 1 requires explicit fidelity, fresh complete metadata, and no prepare hook");
}

console.log("--- Check 2: Tier 1 Concurrent Load + Exact Forwarding ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-tier1-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "pi-web-access", `
      export default function (pi) {
        globalThis.__v040Factory = (globalThis.__v040Factory || 0) + 1;
        for (const name of ["web_search", "fetch_content"]) pi.registerTool({
          name, label: name === "web_search" ? "Web Search" : "Fetch Content",
          description: name === "web_search" ? "Search" : "Fetch",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          async execute(id, params, signal, onUpdate, ctx) {
            globalThis.__v040Executed = (globalThis.__v040Executed || 0) + 1;
            onUpdate?.({ content: [{ type: "text", text: "real update" }], details: {} });
            return { content: [{ type: "text", text: "real:" + params.q }], details: { id, aborted: signal.aborted, marker: ctx.marker } };
          }
        });
      }
    `);
    (globalThis as any).__v040Factory = 0;
    (globalThis as any).__v040Executed = 0;
    const pi = fakePi(["fabric_exec"]);
    const loader = new LazyLoader(pi as any, root, false);
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const cache = warmCache(root, "pi-web-access", [
      { name: "web_search", label: "Web Search", description: "Search", parameters: schema, hasPrepareArguments: false },
      { name: "fetch_content", label: "Fetch Content", description: "Fetch", parameters: schema, hasPrepareArguments: false },
    ]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], cache);
    const searchStub = pi.tools.get("web_search");
    const fetchStub = pi.tools.get("fetch_content");
    assert(searchStub && fetchStub, "real-name stubs must exist before load");
    const signal = new AbortController().signal;
    let updates = 0;
    const onUpdate = () => updates++;
    const ctx = { marker: "same-context" };
    const [a, b] = await Promise.all([
      searchStub.execute("call-a", { q: "alpha" }, signal, onUpdate, ctx),
      fetchStub.execute("call-b", { q: "beta" }, signal, onUpdate, ctx),
    ]);
    assert((globalThis as any).__v040Factory === 1, "concurrent calls share one factory load");
    assert((globalThis as any).__v040Executed === 2, "both Tier 1 calls execute the real tools");
    assert(a.details.id === "call-a" && b.details.id === "call-b", "toolCallId forwarded exactly");
    assert(a.details.marker === "same-context" && b.details.marker === "same-context", "ctx forwarded exactly");
    assert(a.content[0].text === "real:alpha" && b.content[0].text === "real:beta", "params forwarded exactly");
    assert(updates === 4, "stub and real tool both use the original onUpdate callback");
    assert(pi.tools.get("web_search") !== searchStub, "real registration replaces Tier 1 stub");
    assert(pi.restored.length === 2 && pi.restored.every((v) => v[0] === "fabric_exec"), "Fabric active set restored for both calls");
    console.log("  ✓ One load, two real executions, all five arguments forwarded, Fabric set restored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 3: Tier 2 Announces and Does Not Execute ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-tier2-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "@quintinshaw/pi-dynamic-workflows", `
      export default function (pi) {
        pi.registerTool({ name: "workflow", label: "Workflow", description: "Run", parameters: { type: "object" },
          prepareArguments() {}, execute() { globalThis.__v040Tier2Exec = (globalThis.__v040Tier2Exec || 0) + 1; return { content: [] }; } });
      }
    `);
    (globalThis as any).__v040Tier2Exec = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("@quintinshaw/pi-dynamic-workflows")], emptyCache);
    const stub = pi.tools.get("workflow");
    const result = await stub.execute("id", { secret: "DO_NOT_ECHO" }, new AbortController().signal, undefined, { marker: 1 });
    assert(result.details.executed === false && result.details.retryTool === "workflow", "Tier 2 marks non-execution and retry target");
    assert((globalThis as any).__v040Tier2Exec === 0, "Tier 2 first call must not execute real tool");
    assert(!JSON.stringify(result).includes("DO_NOT_ECHO"), "Tier 2 must not echo caller arguments");
    assert(pi.tools.get("workflow") !== stub, "real tool replaces Tier 2 stub after load");
    pi.tools.get("workflow").execute();
    assert((globalThis as any).__v040Tier2Exec === 1, "retry reaches the real tool");
    console.log("  ✓ Cold Tier 2 loads, does not execute or echo args, and retry reaches real tool");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 4: Manifest Drift Cannot Loop ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-drift-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "pi-web-access", `export default function (pi) { pi.registerTool({ name: "web_search", label: "S", description: "S", parameters: { type: "object" }, execute() {} }); }`);
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);
    const missingStub = pi.tools.get("fetch_content");
    const result = await missingStub.execute("id", {}, new AbortController().signal);
    assert(result.isError === true && result.details.manifestDrift === true, "missing registration returns manifest-drift error");
    assert(!result.content[0].text.includes("retry"), "manifest drift must not advise a looping retry");
    assert(pi.tools.get("fetch_content") === missingStub, "missing real registration leaves stub present");
    console.log("  ✓ Missing declared registration errors honestly and leaves no retry loop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 5: Failed Load Leaves Stub + Sticky Failure ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-fail-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "@quintinshaw/pi-dynamic-workflows", `
      export default function (pi) {
        globalThis.__v040FailFactory = (globalThis.__v040FailFactory || 0) + 1;
        pi.registerTool({ name: "workflow", label: "W", description: "W", parameters: { type: "object" }, execute() {} });
        throw new Error("factory failed after registration");
      }
    `);
    (globalThis as any).__v040FailFactory = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("@quintinshaw/pi-dynamic-workflows")], emptyCache);
    const stub = pi.tools.get("workflow");
    const first = await stub.execute("id", {}, new AbortController().signal);
    const second = await stub.execute("id2", {}, new AbortController().signal);
    assert(first.isError && second.isError, "both failed calls answer with errors");
    assert(pi.tools.get("workflow") === stub, "staged real registration never replaces stub on failure");
    assert((globalThis as any).__v040FailFactory === 1, "sticky failure prevents factory re-entry");
    console.log("  ✓ Partial factory failure preserves stub and never re-enters the factory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 6: Collision Guard Survives Sibling Load ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-collision-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "pi-web-access", `
      export default function (pi) {
        pi.registerTool({ name: "web_search", label: "Package", description: "must be discarded", parameters: { type: "object" }, execute() {} });
        pi.registerTool({ name: "fetch_content", label: "Fetch", description: "sibling", parameters: { type: "object" }, execute() {} });
      }
    `);
    const pi = fakePi();
    const eager = { name: "web_search", label: "Eager", description: "existing", parameters: { type: "object" }, execute() {} };
    pi.registerTool(eager);
    const loader = new LazyLoader(pi as any, root, false);
    const diagnostics = registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);
    assert(pi.tools.get("web_search") === eager, "existing eager tool must not be overwritten at startup");
    assert(diagnostics.some((d) => d.includes("web_search") && d.includes("already registered")), "collision diagnostic names the tool");
    const sibling = pi.tools.get("fetch_content");
    await sibling.execute("id", {}, new AbortController().signal);
    assert(pi.tools.get("web_search") === eager, "loading a sibling must not overwrite the protected eager tool");
    console.log("  ✓ Existing eager tool remains protected when a sibling stub loads the package");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 7: Tier 1 Metadata Drift Fails and Refreshes Cache ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-metadata-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "pi-web-access", `
      export default function (pi) {
        pi.registerTool({ name: "web_search", label: "Web Search", description: "new description",
          parameters: { type: "object" }, execute() { globalThis.__v040DriftExecuted = (globalThis.__v040DriftExecuted || 0) + 1; return { content: [] }; } });
      }
    `);
    (globalThis as any).__v040DriftExecuted = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    const cache = warmCache(root, "pi-web-access", [{
      name: "web_search", label: "Web Search", description: "old description",
      parameters: { type: "object" }, hasPrepareArguments: false,
    }]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], cache);
    const stub = pi.tools.get("web_search");
    const result = await stub.execute("id", {}, new AbortController().signal);
    assert(result.isError === true && result.details.metadataDrift === true, "drift must fail before forwarding");
    assert(pi.tools.get("web_search") === stub, "drift must restore the Tier 1 guard stub");
    const retry = await pi.tools.get("web_search").execute("retry", {}, new AbortController().signal);
    assert(retry.details.metadataDrift === true, "same-session retry must remain behind the drift guard");
    assert((globalThis as any).__v040DriftExecuted === 0, "mismatched real tool must never execute in this session");
    const refreshed = JSON.parse(await Bun.file(join(root, "lazy-loader-tools.json")).text());
    assert(
      refreshed.packages["pi-web-access"].tools.find((t: any) => t.name === "web_search")?.description === "new description",
      "successful load must refresh stale cached metadata"
    );
    console.log("  ✓ Stale Tier 1 metadata blocks forwarding and refreshes the next-session cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


console.log("--- Check 8: Sibling Publication Waits for Its Own Validation ---");
{
  const root = join(tmpdir(), `pi-lazy-v040-sibling-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(root, "pi-web-access", `
      export default function (pi) {
        pi.registerTool({ name: "web_search", label: "Web Search", description: "search",
          parameters: { type: "object" }, execute() { globalThis.__v040SearchExec = (globalThis.__v040SearchExec || 0) + 1; return { content: [] }; } });
        pi.registerTool({ name: "fetch_content", label: "Fetch Content", description: "changed fetch",
          parameters: { type: "object" }, execute() { globalThis.__v040FetchExec = (globalThis.__v040FetchExec || 0) + 1; return { content: [] }; } });
      }
    `);
    (globalThis as any).__v040SearchExec = 0;
    (globalThis as any).__v040FetchExec = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    const cache = warmCache(root, "pi-web-access", [
      { name: "web_search", label: "Web Search", description: "search", parameters: { type: "object" }, hasPrepareArguments: false },
      { name: "fetch_content", label: "Fetch Content", description: "old fetch", parameters: { type: "object" }, hasPrepareArguments: false },
    ]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], cache);
    const searchStub = pi.tools.get("web_search");
    const fetchStub = pi.tools.get("fetch_content");
    await searchStub.execute("search", {}, new AbortController().signal);
    assert((globalThis as any).__v040SearchExec === 1, "matching requested tool must execute");
    assert(pi.tools.get("web_search") !== searchStub, "validated requested tool publishes itself");
    assert(pi.tools.get("fetch_content") === fetchStub, "unvalidated sibling must remain a stub");
    const drift = await fetchStub.execute("fetch", {}, new AbortController().signal);
    assert(drift.details.metadataDrift === true, "drifted sibling must run its own guard");
    assert(pi.tools.get("fetch_content") === fetchStub, "drifted sibling stays guarded");
    assert((globalThis as any).__v040FetchExec === 0, "drifted sibling must never execute");
    console.log("  ✓ Loading one tool does not publish or bypass validation for its siblings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n==============================================");
console.log("ALL v0.4.0 TOOL PROXY CHECKS PASSED");
console.log("==============================================");