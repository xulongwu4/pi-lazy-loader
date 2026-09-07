import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import lazyLoaderExtension from "../index.js";
import { LazyLoader } from "../src/loader.js";
import { MANIFEST } from "../src/manifest.js";
import {
  registerToolProxies,
  formatProxyGuidance,
  formatProxyDescription,
} from "../src/tool-proxy.js";
import {
  readToolCache,
  writeToolCache,
  updateCachedPackageTools,
  TOOL_CACHE_FILENAME,
  MAX_CACHE_FILE_SIZE,
  type CachedTool,
  type ToolCacheData,
} from "../src/tool-cache.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function fixture(root: string, packageName: string, body: string) {
  const dir = join(root, "npm", "node_modules", packageName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      pi: { extensions: ["index.js"] },
    }),
    "utf-8"
  );
  writeFileSync(join(dir, "index.js"), body, "utf-8");
}

function fakePi(active: string[] = []) {
  const tools = new Map<string, any>();
  const restored: string[][] = [];
  return {
    tools,
    restored,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
    getAllTools() {
      return Array.from(tools.values());
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      restored.push([...names]);
    },
  };
}

function entry(name: string) {
  const found = MANIFEST.find((item) => item.name === name);
  assert(found, `manifest entry ${name} must exist`);
  return found;
}

const emptyCache: ToolCacheData = { version: 3, packages: {} };

console.log("=== Running v0.5.0 Tool Proxy Checks ===\n");

// ---------------------------------------------------------------------------
// Check 1: Proxy Registration & Description (Cached vs Manifest Fallback)
// ---------------------------------------------------------------------------
console.log("--- Check 1: Proxy Registration & Description ---");
{
  const pi = fakePi();
  const loader = new LazyLoader(pi as any, tmpdir(), false);
  const cacheWithDesc: ToolCacheData = {
    version: 3,
    packages: {
      "pi-web-access": {
        tools: [
          { name: "web_search", description: "Search the web using multi-provider queries." },
        ],
      },
    },
  };

  registerToolProxies(pi, loader, [entry("pi-web-access")], cacheWithDesc);

  const searchProxy = pi.tools.get("web_search");
  const fetchProxy = pi.tools.get("fetch_content");
  assert(searchProxy, "web_search proxy must be registered");
  assert(fetchProxy, "fetch_content proxy must be registered");

  const expectedSearchGuidance = formatProxyGuidance("pi-web-access", "web_search");
  assert(
    searchProxy.description.includes("Search the web using multi-provider queries"),
    "web_search description must prefer cached description"
  );
  assert(
    searchProxy.description.includes(expectedSearchGuidance),
    "web_search description must contain next-step guidance"
  );

  const webManifest = entry("pi-web-access");
  const expectedFetchGuidance = formatProxyGuidance("pi-web-access", "fetch_content");
  assert(
    fetchProxy.description.includes(webManifest.capability),
    "fetch_content description must fall back to manifest capability when un-cached"
  );
  assert(
    fetchProxy.description.includes(expectedFetchGuidance),
    "fetch_content description must contain next-step guidance"
  );

  console.log("  ✓ Proxy descriptions prefer cached description and fall back to manifest capability with guidance");
}

// ---------------------------------------------------------------------------
// Check 2: Proxy Execution Loads but Does Not Execute and Requests Retry
// ---------------------------------------------------------------------------
console.log("--- Check 2: Proxy Loads Package, Does Not Execute, and Requests Retry ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk2-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        globalThis.__v050FactoryCount = (globalThis.__v050FactoryCount || 0) + 1;
        pi.registerTool({
          name: "web_search",
          description: "Real web search",
          execute() {
            globalThis.__v050ExecCount = (globalThis.__v050ExecCount || 0) + 1;
            return { content: [{ type: "text", text: "executed" }] };
          }
        });
      }
    `
    );
    (globalThis as any).__v050FactoryCount = 0;
    (globalThis as any).__v050ExecCount = 0;

    const active = ["fabric_exec", "lazy_load"];
    const pi = fakePi(active);
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);

    const proxy = pi.tools.get("web_search");
    assert(proxy, "web_search proxy must be registered");

    const callerArgs = { query: "super_secret_query_DO_NOT_LEAK", apiKey: "secret_12345" };
    const result = await proxy.execute("call-1", callerArgs);

    assert((globalThis as any).__v050FactoryCount === 1, "proxy execution must load the package once");
    assert((globalThis as any).__v050ExecCount === 0, "proxy execution must not execute the real tool");
    assert(pi.tools.get("web_search") !== proxy, "successful load must replace the proxy with the real tool");
    assert(result.content[0].text.includes("was not executed"), "result must make non-execution explicit");
    assert(result.content[0].text.includes("Call \"web_search\" again"), "result must request a retry");
    assert(result.details.loaded === true, "details.loaded must be true");
    assert(result.details.executed === false, "details.executed must be false");
    assert(result.details.package === "pi-web-access", "details.package must match canonical package");
    assert(result.details.loadTool === undefined, "loaded proxy result must not redirect through lazy_load");
    assert(result.details.retryTool === "web_search", "details.retryTool must match declared tool name");
    assert(JSON.stringify(pi.restored.at(-1)) === JSON.stringify(active), "proxy load must restore Fabric active tools");

    const staleProxyResult = await proxy.execute("call-2", {});
    assert(staleProxyResult.details.alreadyLoaded === true, "a stale proxy reference must report the package already loaded");
    assert(staleProxyResult.details.retryTool === "web_search", "a stale proxy reference must still request the real-tool retry");
    assert((globalThis as any).__v050FactoryCount === 1, "stale proxy reference must not reload the package");

    const serialized = JSON.stringify(result);
    assert(!serialized.includes("super_secret_query_DO_NOT_LEAK"), "must not echo caller query argument");
    assert(!serialized.includes("secret_12345"), "must not echo caller apiKey argument");

    console.log("  ✓ Proxy loads once, never executes or echoes arguments, restores Fabric, and requests a real-tool retry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 3: Package Load Publishes Staged Real Tools, Replacing Proxies
// ---------------------------------------------------------------------------
console.log("--- Check 3: Package Load Publishes Staged Real Tools Replacing Proxies ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk3-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        globalThis.__v050Chk3Factory = (globalThis.__v050Chk3Factory || 0) + 1;
        pi.registerTool({
          name: "web_search",
          description: "Real web search",
          parameters: { type: "object" },
          async execute(id, params) {
            return {
              content: [{ type: "text", text: "search-result for " + params.q }],
              details: { ok: true, id }
            };
          }
        });
        pi.registerTool({
          name: "fetch_content",
          description: "Real fetch content",
          parameters: { type: "object" },
          async execute(id, params) {
            return {
              content: [{ type: "text", text: "fetch-result for " + params.url }],
              details: { ok: true, id }
            };
          }
        });
      }
    `
    );
    (globalThis as any).__v050Chk3Factory = 0;

    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);

    const searchProxy = pi.tools.get("web_search");
    const fetchProxy = pi.tools.get("fetch_content");
    assert(searchProxy && fetchProxy, "proxies must exist before load");

    // Concurrent proxy calls share one package load and each request a retry.
    const [res1, res2] = await Promise.all([
      searchProxy.execute("search-proxy", { q: "ignored" }),
      fetchProxy.execute("fetch-proxy", { url: "ignored" }),
    ]);

    assert((globalThis as any).__v050Chk3Factory === 1, "concurrent proxy calls must share one load promise");
    assert(res1.details.retryTool === "web_search", "search proxy must request a web_search retry");
    assert(res2.details.retryTool === "fetch_content", "fetch proxy must request a fetch_content retry");

    const realSearch = pi.tools.get("web_search");
    const realFetch = pi.tools.get("fetch_content");
    assert(realSearch !== searchProxy, "real web_search must replace proxy in registry");
    assert(realFetch !== fetchProxy, "real fetch_content must replace proxy in registry");

    const execResult = await realSearch.execute("call-10", { q: "quantum computing" });
    assert(execResult.content[0].text === "search-result for quantum computing", "real tool must execute with args");

    console.log("  ✓ Staged real tools published on load, replacing proxies; concurrent loads deduplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 4: Surviving Proxy in Loaded State Returns Terminal Manifest Drift
// ---------------------------------------------------------------------------
console.log("--- Check 4: Surviving Proxy in Loaded State Returns Terminal Manifest Drift ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk4-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    // Package only provides web_search, missing fetch_content, source_check, get_search_content
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "web_search",
          description: "Real web search",
          parameters: { type: "object" },
          execute() { return { content: [] }; }
        });
      }
    `
    );

    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);

    const fetchProxy = pi.tools.get("fetch_content");
    assert(fetchProxy, "fetch_content proxy must be registered at startup");

    const driftResult = await fetchProxy.execute("call-drift", {});
    assert(driftResult.isError === true, "missing tool must return an error after proxy-triggered load");
    const loadResult = await loader.loadPackage("pi-web-access");
    assert(loadResult.success, "package must remain successfully loaded");
    assert(loadResult.missingTools?.includes("fetch_content"), "load result must track missing fetch_content");
    const repeatedResult = await loader.loadPackage("pi-web-access");
    assert(repeatedResult.missingTools?.includes("fetch_content"), "repeated load must retain missing-tool diagnostics");

    // The fetch_content proxy survived because the package never registered it
    assert(pi.tools.get("fetch_content") === fetchProxy, "fetch_content proxy survives when package didn't provide it");

    const repeatedDrift = await fetchProxy.execute("call-drift-again", {});
    assert(repeatedDrift.isError === true, "surviving proxy must keep returning an error");
    assert(driftResult.details.manifestDrift === true, "details.manifestDrift must be true");
    assert(driftResult.details.executed === false, "details.executed must be false");
    assert(driftResult.details.retryTool === undefined, "terminal drift must not include retryTool");
    assert(driftResult.details.loadTool === undefined, "terminal drift must not include loadTool");
    assert(
      driftResult.content[0].text.includes("did not register declared tool"),
      "content must state tool was not registered"
    );

    console.log("  ✓ Surviving proxy in loaded state returns terminal manifest drift with no retry-loop guidance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 5: Failed Package Load Leaves Atomicity & Returns Terminal Reload Guidance
// ---------------------------------------------------------------------------
console.log("--- Check 5: Failed State Returns Terminal Reload Guidance ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk5-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        globalThis.__v050Chk5Factory = (globalThis.__v050Chk5Factory || 0) + 1;
        pi.registerTool({
          name: "web_search",
          description: "Staged tool that should not be published",
          execute() {}
        });
        throw new Error("Syntax error in package extension");
      }
    `
    );

    (globalThis as any).__v050Chk5Factory = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);

    const proxy = pi.tools.get("web_search");
    const failResult = await proxy.execute("load-fail", {});
    assert(failResult.isError === true, "proxy must report package load failure");
    assert(failResult.details.failed === true, "proxy failure details must be terminal");
    const repeatedLoad = await loader.loadPackage("pi-web-access");
    assert(repeatedLoad.success === false, "sticky failure must reject repeated loads");
    assert((globalThis as any).__v050Chk5Factory === 1, "sticky failure must not re-enter the package factory");

    // Atomicity: staged tool was NOT published
    assert(pi.tools.get("web_search") === proxy, "failed load must not publish staged tool over proxy");

    // A stale proxy reference remains terminal without reloading.
    const repeatedFailure = await proxy.execute("call-fail", {});
    assert(repeatedFailure.isError === true, "must return isError: true");
    assert(repeatedFailure.details.failed === true, "details.failed must be true");
    assert(repeatedFailure.details.retryTool === undefined, "terminal failure must not include retryTool");
    assert(repeatedFailure.details.loadTool === undefined, "terminal failure must not include loadTool");
    assert(
      repeatedFailure.content[0].text.includes("Reload the session or restart Pi"),
      "content must guide to reload or restart Pi"
    );

    console.log("  ✓ Failed load preserves proxy atomicity and returns terminal reload guidance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 6: Collision with Existing Eager Tool Leaves Eager Tool Protected
// ---------------------------------------------------------------------------
console.log("--- Check 6: Collision with Existing Eager Tool Leaves Eager Protected ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk6-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({ name: "web_search", description: "Impostor search", execute() {} });
        pi.registerTool({ name: "fetch_content", description: "Real fetch", execute() {} });
      }
    `
    );

    const pi = fakePi();
    const eager = { name: "web_search", description: "Genuine eager search tool", execute() {} };
    pi.registerTool(eager);

    const loader = new LazyLoader(pi as any, root, false);
    const diags = registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);

    assert(pi.tools.get("web_search") === eager, "eager tool must not be displaced by proxy at startup");
    assert(diags.some((d) => d.includes("web_search") && d.includes("already registered")), "diagnostic emitted");

    await loader.loadPackage("pi-web-access");
    assert(pi.tools.get("web_search") === eager, "eager tool must remain protected when package loads");

    console.log("  ✓ Eager tool collisions skipped at startup and protected across package load");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 7: Advisory Cache v3 Format, Manifest-Declared Filtering & Migration
// ---------------------------------------------------------------------------
console.log("--- Check 7: Advisory Cache v3, Manifest-Declared Filtering & Migration ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk7-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    // 1. Package registers a declared tool AND an undeclared tool
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({ name: "web_search", description: "Fresh web search description", execute() {} });
        pi.registerTool({ name: "undeclared_bonus_tool", description: "Bonus", execute() {} });
      }
    `
    );

    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, false);
    registerToolProxies(pi, loader, [entry("pi-web-access")], emptyCache);

    await loader.loadPackage("pi-web-access");

    const cache = readToolCache(root);
    assert(cache.version === 3, "cache version must be 3");
    const cachedPkg = cache.packages["pi-web-access"];
    assert(cachedPkg, "pi-web-access must be cached");

    const cachedSearch = cachedPkg.tools.find((t) => t.name === "web_search");
    assert(cachedSearch?.description === "Fresh web search description", "declared tool description cached");

    const undeclared = cachedPkg.tools.find((t) => t.name === "undeclared_bonus_tool");
    assert(undeclared === undefined, "only manifest-declared proxy tools must be cached");
    updateCachedPackageTools(root, "pi-web-access", []);
    assert(
      readToolCache(root).packages["pi-web-access"]?.tools.length === 0,
      "empty observations must clear stale package descriptions"
    );

    // 2. Migration from v2 cache
    const v2Cache = {
      version: 2,
      packages: {
        "@quintinshaw/pi-dynamic-workflows": {
          fingerprint: "old-fp",
          tools: [
            {
              name: "workflow",
              label: "Workflow",
              description: "Run dynamic workflow",
              parameters: { type: "object" },
              hasPrepareArguments: false,
            },
          ],
        },
      },
    };
    writeFileSync(join(root, TOOL_CACHE_FILENAME), JSON.stringify(v2Cache), "utf-8");

    const migrated = readToolCache(root);
    assert(migrated.version === 3, "migrated cache version must be 3");
    const migratedTool = migrated.packages["@quintinshaw/pi-dynamic-workflows"]?.tools[0];
    assert(migratedTool?.name === "workflow", "migrated tool name preserved");
    assert(migratedTool?.description === "Run dynamic workflow", "migrated description preserved");
    assert(!("fingerprint" in (migrated.packages["@quintinshaw/pi-dynamic-workflows"] as any)), "fingerprint removed");
    assert(!("parameters" in (migratedTool as any)), "parameters schema removed");
    assert(!("hasPrepareArguments" in (migratedTool as any)), "prepareArguments removed");

    // 3. Migration from v1 string entries
    const v1Cache = {
      version: 1,
      packages: {
        "pi-web-access": { fingerprint: "legacy", tools: ["web_search"] },
      },
    };
    writeFileSync(join(root, TOOL_CACHE_FILENAME), JSON.stringify(v1Cache), "utf-8");
    const migratedV1 = readToolCache(root);
    assert(migratedV1.packages["pi-web-access"]?.tools[0]?.name === "web_search", "v1 string tool name preserved");

    writeFileSync(join(root, TOOL_CACHE_FILENAME), "{not-json", "utf-8");
    assert(Object.keys(readToolCache(root).packages).length === 0, "corrupt cache must fail soft");
    writeFileSync(join(root, TOOL_CACHE_FILENAME), JSON.stringify({ version: 99, packages: {} }), "utf-8");
    assert(Object.keys(readToolCache(root).packages).length === 0, "unknown cache version must fail soft");

    // 4. Oversize cache checks (>64 KiB)
    const bigTools: CachedTool[] = [];
    for (let i = 0; i < 2000; i++) {
      bigTools.push({ name: `tool_${i}`, description: "a".repeat(100) });
    }
    const oversizeCache: ToolCacheData = {
      version: 3,
      packages: { big: { tools: bigTools } },
    };
    const beforeWrite = readToolCache(root);
    writeToolCache(root, oversizeCache);
    const afterWrite = readToolCache(root);
    assert(
      JSON.stringify(beforeWrite) === JSON.stringify(afterWrite),
      "writeToolCache must skip writing when file exceeds 64 KiB"
    );

    writeFileSync(join(root, TOOL_CACHE_FILENAME), JSON.stringify(oversizeCache), "utf-8");
    assert(
      Object.keys(readToolCache(root).packages).length === 0,
      "readToolCache must reject files over 64 KiB before parsing"
    );

    console.log("  ✓ Advisory cache v3 filters declarations, migrates v1/v2, and caps reads and writes at 64 KiB");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 8: Production lazy_load Restores Fabric Active Tools
// ---------------------------------------------------------------------------
console.log("--- Check 8: Production lazy_load Restores Fabric Active Tools ---");
{
  const active = ["fabric_exec", "lazy_load"];
  const successPi = fakePi(active);
  const successLoader = lazyLoaderExtension(successPi as any);
  (successLoader as any).loadPackage = async () => ({
    success: true,
    status: "loaded",
    package: "pi-web-access",
    source: "npm:pi-web-access",
    newTools: ["web_search"],
    missingTools: ["fetch_content"],
    loadMs: 1,
  });
  const lazyLoad = successPi.tools.get("lazy_load");
  assert(!lazyLoad.description.includes("pi-web-access"), "lazy_load description must not enumerate packages");
  assert(!lazyLoad.description.includes("web_search"), "lazy_load description must not enumerate tools");
  assert(!/retry|again/i.test(lazyLoad.description), "lazy_load description must not discuss tool retries");
  const successResult = await lazyLoad.execute("load-success", { package: "pi-web-access" });
  assert(successResult.details.success === true, "production lazy_load success path must complete");
  assert(successResult.content[0].text.includes("fetch_content"), "production lazy_load must warn about missing declared tools");
  assert(
    JSON.stringify(successPi.restored.at(-1)) === JSON.stringify(active),
    "production lazy_load must restore Fabric active tools after success"
  );

  const failurePi = fakePi(active);
  const failureLoader = lazyLoaderExtension(failurePi as any);
  (failureLoader as any).loadPackage = async () => ({
    success: false,
    status: "failed",
    package: "pi-web-access",
    source: "npm:pi-web-access",
    error: "simulated failure",
  });
  const failureResult = await failurePi.tools.get("lazy_load").execute("load-failure", { package: "pi-web-access" });
  assert(failureResult.isError === true, "production lazy_load failure path must report an error");
  assert(
    JSON.stringify(failurePi.restored.at(-1)) === JSON.stringify(active),
    "production lazy_load must restore Fabric active tools after failure"
  );

  console.log("  ✓ Production lazy_load restores Fabric active tools after success and failure");
}

console.log("\n==============================================");
console.log("ALL v0.5.0 TOOL PROXY CHECKS PASSED");
console.log("==============================================");
