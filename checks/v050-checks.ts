import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import lazyLoaderExtension from "../index.js";
import { LazyLoader } from "../src/loader.js";
import { CONFIG_FILENAME, readLazyLoaderConfig } from "../src/config.js";
import {
  registerToolProxies,
  formatProxyGuidance,
  formatProxyDescription,
} from "../src/tool-proxy.js";
import {
  readCache,
  selectCachedRegistrations,
  writeCache,
  updateCachedPackage,
  CACHE_FILENAME,
  type LazyLoaderCache,
} from "../src/cache.js";

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
  const commands = new Map<string, any>();
  const restored: string[][] = [];
  const handlers = new Map<string, Function[]>();
  return {
    tools,
    commands,
    restored,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getCommands() {
      return Array.from(commands, ([name, command]) => ({ name, ...command }));
    },
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
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
  return {
    name,
    source: `npm:${name}`,
    aliases: [name.toLowerCase(), `npm:${name.toLowerCase()}`],
  };
}

const webCache: LazyLoaderCache = {
  version: 1,
  packages: {
    "pi-web-access": { tools: [{ name: "web_search" }, { name: "fetch_content" }], commands: [] },
  },
};

console.log("=== Running v0.8.0 Tool Proxy Checks ===\n");

// ---------------------------------------------------------------------------
// Check 1: Cache-Driven Proxy Registration & Description
// ---------------------------------------------------------------------------
console.log("--- Check 1: Proxy Registration & Description ---");
{
  const pi = fakePi();
  const loader = new LazyLoader(pi as any, tmpdir(), [entry("pi-web-access")]);
  const cacheWithDesc: LazyLoaderCache = {
    version: 1,
    packages: {
      "pi-web-access": {
        tools: [
          { name: "web_search", description: "Search the web using multi-provider queries." },
          { name: "fetch_content" },
        ],
        commands: [],
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

  const expectedFetchGuidance = formatProxyGuidance("pi-web-access", "fetch_content");
  assert(
    fetchProxy.description.includes("Tools provided by pi-web-access"),
    "cached tool without a description must use the package-name fallback"
  );
  assert(
    fetchProxy.description.includes(expectedFetchGuidance),
    "fetch_content description must contain next-step guidance"
  );

  assert(selectCachedRegistrations(cacheWithDesc.packages["pi-web-access"].tools, []).length === 0, "empty allowlist must disable the proxy type");
  assert(selectCachedRegistrations([], ["conditional_tool"])[0]?.name === "conditional_tool", "listed uncached names must still receive proxies");
  console.log("  ✓ Cached tools, empty allowlists, and uncached explicit names drive proxy registration");
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

    const active = ["fabric_exec"];
    const pi = fakePi(active);
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);

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
    assert(result.details.loadTool === undefined, "loaded proxy result must request a direct tool retry");
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
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);

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
// Check 4: Surviving Proxy in Loaded State Returns Terminal Cache Drift
// ---------------------------------------------------------------------------
console.log("--- Check 4: Surviving Proxy in Loaded State Returns Terminal Cache Drift ---");
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
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);

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
    assert(driftResult.details.cacheDrift === true, "details.cacheDrift must be true");
    assert(driftResult.details.executed === false, "details.executed must be false");
    assert(driftResult.details.retryTool === undefined, "terminal drift must not include retryTool");
    assert(driftResult.details.loadTool === undefined, "terminal drift must not include loadTool");
    assert(
      driftResult.content[0].text.includes("did not register cached tool"),
      "content must state tool was not registered"
    );

    console.log("  ✓ Surviving proxy in loaded state returns terminal cache drift with no retry-loop guidance");
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
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);

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

    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    const diags = registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);

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
// Check 7: Unified Command and Tool Cache
// ---------------------------------------------------------------------------
console.log("--- Check 7: Unified Command and Tool Cache ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk7-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({ name: "web_search", description: "Fresh web search description", execute() {} });
        pi.registerTool({ name: "bonus_tool", description: "Bonus", execute() {} });
        pi.registerCommand("web-status", { description: "Show web status", handler() {} });
      }
    `
    );

    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    await loader.loadPackage("pi-web-access");

    const cache = readCache(root);
    assert(cache.version === 1, "unified cache version must be 1");
    const cachedPackage = cache.packages["pi-web-access"];
    assert(cachedPackage, "pi-web-access must be cached");
    assert(cachedPackage.tools.find((item) => item.name === "web_search")?.description === "Fresh web search description", "tool description cached");
    assert(cachedPackage.tools.find((item) => item.name === "bonus_tool")?.description === "Bonus", "every exposed tool cached");
    assert(cachedPackage.commands.find((item) => item.name === "web-status")?.description === "Show web status", "every exposed command cached");

    updateCachedPackage(root, "pi-web-access", [], []);
    const cleared = readCache(root).packages["pi-web-access"];
    assert(cleared?.tools.length === 0 && cleared.commands.length === 0, "empty observations clear stale registrations");

    writeFileSync(join(root, CACHE_FILENAME), JSON.stringify({ version: 1, packages: { incomplete: { tools: [] } } }), "utf-8");
    assert(!readCache(root).packages.incomplete, "package entries missing commands or tools must be repopulated");

    writeFileSync(join(root, CACHE_FILENAME), "{not-json", "utf-8");
    assert(Object.keys(readCache(root).packages).length === 0, "corrupt cache must fail soft");
    writeFileSync(join(root, CACHE_FILENAME), JSON.stringify({ version: 99, packages: {} }), "utf-8");
    assert(Object.keys(readCache(root).packages).length === 0, "unknown cache version must fail soft");

    writeCache(root, { version: 1, packages: {} });
    const cacheModule = new URL("../src/cache.ts", import.meta.url).href;
    const exits = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      new Promise<number | null>((resolveExit) => {
        const worker = spawn(process.execPath, [
          "-e",
          `import { updateCachedPackage } from ${JSON.stringify(cacheModule)}; updateCachedPackage(${JSON.stringify(root)}, "worker-${index}", [{ name: "tool-${index}" }], []);`,
        ], { stdio: "ignore" });
        worker.on("exit", resolveExit);
      })
    ));
    assert(exits.every((code) => code === 0), "concurrent cache writers must exit successfully");
    assert(Object.keys(readCache(root).packages).filter((name) => name.startsWith("worker-")).length === 8, "concurrent cache updates must preserve every package");
    assert(!existsSync(join(root, `${CACHE_FILENAME}.lock`)), "cache lock must be cleaned up");

    console.log("  ✓ Unified cache captures all registrations, rejects invalid entries, and preserves concurrent updates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 8: Production Surface Has No lazy_load
// ---------------------------------------------------------------------------
console.log("--- Check 8: Production Surface Has No lazy_load ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk8-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    fixture(root, "pi-web-access", `export default function () {}`);
    writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    writeCache(root, webCache);
    process.env.PI_CODING_AGENT_DIR = root;
    const pi = fakePi();
    lazyLoaderExtension(pi as any);
    assert(!pi.tools.has("lazy_load"), "production extension must not register lazy_load");
    assert(pi.commands.has("lazy"), "production extension must register /lazy");
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
    assert(pi.tools.has("web_search"), "cached tool proxy must be registered");
    assert(!pi.tools.has("lazy_load"), "session_start must not register lazy_load");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
  console.log("  ✓ Production extension has no lazy_load; /lazy and cached proxies remain");
}

// ---------------------------------------------------------------------------
// Check 9: Explicit Catalog, Cache Bootstrap, and Filtered Proxies
// ---------------------------------------------------------------------------
console.log("--- Check 9: Explicit Catalog, Cache Bootstrap & Filtered Proxies ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk9-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    fixture(
      root,
      "arbitrary-pi-package",
      `
      export default function (pi) {
        pi.registerTool({ name: "arbitrary_one", description: "First arbitrary tool", execute() {} });
        pi.registerTool({ name: "arbitrary_two", description: "Second arbitrary tool", execute() {} });
        pi.registerCommand("arbitrary-command", { description: "Arbitrary command", handler() {} });
        pi.registerCommand("hidden-command", { description: "Hidden command", handler() {} });
        pi.registerCommand("colliding-command", { description: "Lazy collision", handler() {} });
      }
    `
    );
    fixture(root, "failing-pi-package", `export default function () { throw new Error("bootstrap failure"); }`);
    writeFileSync(
      join(root, CONFIG_FILENAME),
      JSON.stringify({ packages: [
        {
          source: "npm:arbitrary-pi-package@1.0.0",
          commands: ["arbitrary-command", "colliding-command"],
          tools: ["arbitrary_one"],
        },
        "npm:failing-pi-package",
      ] }),
      "utf-8"
    );
    process.env.PI_CODING_AGENT_DIR = root;

    const discovered = readLazyLoaderConfig(root).packages;
    assert(discovered.length === 2, "configured lazy packages must be discovered from lazy-loader.json");
    assert(discovered[0].name === "arbitrary-pi-package", "package.json name must be used as cache identity");

    const firstPi = fakePi();
    const firstLoader = lazyLoaderExtension(firstPi as any);
    await firstPi.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
    assert(firstLoader.getPackageState("arbitrary-pi-package")?.status === "loaded", "cache miss must eagerly load package");
    assert(firstLoader.getPackageState("failing-pi-package")?.status === "failed", "failed bootstrap must retain failed state");
    const failedCache = readCache(root).packages["failing-pi-package"];
    assert(failedCache?.tools.length === 0 && failedCache.commands.length === 0, "failed bootstrap must leave a complete empty cache marker");
    const cachedPackage = readCache(root).packages["arbitrary-pi-package"];
    const cachedNames = cachedPackage?.tools.map((tool) => tool.name).sort();
    assert(
      JSON.stringify(cachedNames) === JSON.stringify(["arbitrary_one", "arbitrary_two"]),
      "cache bootstrap must capture every exposed tool"
    );
    assert(
      JSON.stringify(cachedPackage?.commands.map((command) => command.name).sort()) ===
        JSON.stringify(["arbitrary-command", "colliding-command", "hidden-command"]),
      "cache bootstrap must capture every exposed command regardless of proxy filters"
    );

    const secondPi = fakePi();
    const eagerCommand = { description: "Existing eager command", handler() {} };
    secondPi.registerCommand("colliding-command", eagerCommand);
    const secondLoader = lazyLoaderExtension(secondPi as any);
    await secondPi.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
    assert(secondLoader.getPackageState("arbitrary-pi-package")?.status === "deferred", "cache hit must keep package deferred");
    assert(secondLoader.getPackageState("failing-pi-package")?.status === "deferred", "failed bootstrap marker must prevent repeated eager loading");
    assert(secondPi.tools.has("arbitrary_one"), "configured cached tool must create a proxy");
    assert(!secondPi.tools.has("arbitrary_two"), "unlisted cached tool must not create a proxy");
    assert(secondPi.commands.has("arbitrary-command"), "configured cached command must create a proxy");
    assert(!secondPi.commands.has("hidden-command"), "unlisted cached command must not create a proxy");
    assert(secondPi.commands.get("colliding-command") === eagerCommand, "existing command must not be replaced by a proxy");
    await secondLoader.loadPackage("arbitrary-pi-package");
    assert(secondPi.commands.get("colliding-command") === eagerCommand, "loaded package must not replace protected eager command");

    console.log("  ✓ Explicit packages bootstrap once, cache every command/tool, and expose only configured proxies");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n==============================================");
console.log("ALL v0.8.0 TOOL PROXY CHECKS PASSED");
console.log("==============================================");
