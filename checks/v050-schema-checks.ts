import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai";

import { CacheDriftError, LazyLoader } from "../src/loader.js";
import {
  registerToolProxies,
  formatProxyNote,
  formatProxyGuidance,
  formatProxyDescription,
} from "../src/tool-proxy.js";
import { buildDeferredToolGuidance, DEFERRED_GUIDANCE_HEADER } from "../src/prompt-guidance.js";
import {
  readCache,
  CACHE_FILENAME,
  schemaIsJsonRepresentable,
  schemasEquivalent,
  cloneJsonValue,
  isCachedToolSchema,
  type LazyLoaderCache,
} from "../src/cache.js";
import { fakePi } from "./fake-pi.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const secretParams = { query: "no-echo-query-token-9f3c", apiKey: "no-echo-apikey-token-7b21" };

function assertNoCallerEcho(result: unknown, params: Record<string, unknown>, label: string) {
  const blob = JSON.stringify(result) ?? "";
  for (const [key, value] of Object.entries(params)) {
    assert(!blob.includes(String(value)), `${label} must not echo caller ${key} argument`);
  }
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

function entry(name: string) {
  return {
    name,
    source: `npm:${name}`,
    aliases: [name.toLowerCase(), `npm:${name.toLowerCase()}`],
  };
}

const objectSchema = { type: "object", properties: {}, additionalProperties: true };
const webCache: LazyLoaderCache = {
  version: 1,
  packages: {
    "pi-web-access": {
      tools: [
        { name: "web_search", parameters: objectSchema },
        { name: "fetch_content", parameters: objectSchema },
      ],
      commands: [],
    },
  },
};

console.log("=== Running v0.8.0 Cache/Schema Checks ===\n");

// ---------------------------------------------------------------------------
// Check 10: Cached schemas, no-schema retry, typed cache drift
// ---------------------------------------------------------------------------
console.log("--- Check 10: Cached Schemas, No-Schema Retry, Typed Cache Drift ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk10-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, CACHE_FILENAME), JSON.stringify({
      version: 1,
      packages: { "legacy-pkg": { tools: [{ name: "legacy_tool", description: "old" }], commands: [] } },
    }), "utf-8");
    const legacy = readCache(root).packages["legacy-pkg"]?.tools[0];
    assert(legacy?.name === "legacy_tool" && legacy.parameters === undefined, "old cache files without parameters must still load");

    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        globalThis.__v050Chk10Pi = pi;
        globalThis.__v050Chk10Factory = (globalThis.__v050Chk10Factory || 0) + 1;
        pi.registerTool({
          name: "web_search",
          description: "Real web search",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          execute(id, params, signal, onUpdate, ctx) {
            globalThis.__v050Chk10Exec = (globalThis.__v050Chk10Exec || 0) + 1;
            globalThis.__v050Chk10Forward = [id, params, signal, onUpdate, ctx];
            if (params?.boom) throw new Error('Package "pi-web-access" did not register reserved tool "web_search"');
            return { content: [{ type: "text", text: "ran:" + params.q }], details: { from: "real" } };
          }
        });
        pi.on("tool_call", () => {
          pi.registerTool({
            name: "late_tool",
            description: "Registered after commit",
            parameters: { type: "object" },
            execute() {
              return { content: [{ type: "text", text: "late" }], details: { from: "late" } };
            }
          });
        });
      }
    `
    );
    (globalThis as any).__v050Chk10Factory = 0;
    (globalThis as any).__v050Chk10Exec = 0;

    const schemaCache: LazyLoaderCache = {
      version: 1,
      packages: {
        "pi-web-access": {
          tools: [
            { name: "web_search", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
            { name: "late_tool", parameters: { type: "object" } },
          ],
          commands: [],
        },
      },
    };
    const noSchemaCache: LazyLoaderCache = {
      version: 1,
      packages: {
        "pi-web-access": { tools: [{ name: "web_search" }], commands: [] },
      },
    };

    const retryPi = fakePi();
    const retryLoader = new LazyLoader(retryPi as any, root, [entry("pi-web-access")]);
    registerToolProxies(retryPi, retryLoader, [entry("pi-web-access")], noSchemaCache);
    const retryProxy = retryPi.tools.get("web_search");
    assert(retryProxy.description.includes(formatProxyGuidance("pi-web-access", "web_search")), "no-schema proxy must ask the model to retry");
    const retryResult = await retryProxy.execute("retry-1", { q: "nope" });
    assert(retryResult.details.executed === false && retryResult.details.retryTool === "web_search", "no-schema proxy must not execute");
    assert((globalThis as any).__v050Chk10Exec === 0, "no-schema first call must not invoke the real tool");
    assert((globalThis as any).__v050Chk10Factory === 1, "no-schema proxy must still load the package");

    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], schemaCache);
    const searchProxy = pi.tools.get("web_search");
    assert(
      JSON.stringify(searchProxy.parameters) === JSON.stringify({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
      "proxy must register with the cached parameter schema"
    );
    assert(searchProxy.description.includes(formatProxyNote("pi-web-access", "web_search")), "schema proxy description must be load-then-invoke");
    assert(formatProxyDescription("Search", "pi-web-access", "web_search", false).includes(formatProxyGuidance("pi-web-access", "web_search")), "retry description helper must keep the handoff note");

    const signal = AbortSignal.abort();
    const onUpdate = () => {};
    const ctx = { cwd: "/fwd" };
    const ran = await searchProxy.execute("call-ok", { q: "hi" }, signal, onUpdate, ctx);
    assert(ran.content[0].text === "ran:hi", "schema proxy must invoke the real tool");
    const fwd = (globalThis as any).__v050Chk10Forward;
    assert(fwd?.[0] === "call-ok" && fwd[1]?.q === "hi" && fwd[2] === signal && fwd[3] === onUpdate && fwd[4] === ctx, "cache-safe proxy must forward toolCallId/params/signal/onUpdate/ctx to captured execute");
    assert(pi.tools.get("web_search") !== searchProxy, "load-success reserved tool must replace the host proxy");

    let boom: unknown;
    try {
      await searchProxy.execute("call-boom", { q: "x", boom: true });
    } catch (error) {
      boom = error;
    }
    assert(boom instanceof Error && (boom as Error).message.includes("did not register reserved tool"), "real tool errors must propagate");
    assert(!(boom instanceof CacheDriftError), "real tool errors quoting the drift phrase must not become CacheDriftError");

    const lateProxy = pi.tools.get("late_tool");
    const firstLate = await lateProxy.execute("late-missing", {});
    assert(firstLate.details.cacheDrift === true, "reserved tool missing at commit is cache drift");

    await (globalThis as any).__v050Chk10Pi.emit("tool_call");
    assert(pi.tools.get("late_tool") !== lateProxy, "post-commit reserved tool must register with the host");
    const lateResult = await lateProxy.execute("late-stale", {});
    assert(lateResult.content[0].text === "late", "stale proxy must invoke a tool registered after commit");
    const invoked = await loader.invokeCapturedTool("pi-web-access", "late_tool", "late-direct", {}, AbortSignal.abort(), () => {}, {});
    assert(invoked.content[0].text === "late", "invokeCapturedTool must see post-commit captures");

    let driftErr: unknown;
    try {
      await loader.invokeCapturedTool("pi-web-access", "never_tool", "x", {}, AbortSignal.abort(), () => {}, {});
    } catch (error) {
      driftErr = error;
    }
    assert(driftErr instanceof CacheDriftError, "missing capture must throw CacheDriftError");
    assert((driftErr as CacheDriftError).code === "CACHE_DRIFT", "CacheDriftError must carry a stable code");

    const persisted = readCache(root).packages["pi-web-access"]?.tools.find((item) => item.name === "web_search");
    assert(JSON.stringify(persisted?.parameters) === JSON.stringify({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }), "refreshCache must persist tool parameter schemas");

    console.log("  ✓ Cached schemas gate invoke; no-schema retries; drift is typed; post-commit tools are captured");
  } finally {
    delete (globalThis as any).__v050Chk10Pi;
    delete (globalThis as any).__v050Chk10Factory;
    delete (globalThis as any).__v050Chk10Exec;
    delete (globalThis as any).__v050Chk10Forward;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 11: Nested CacheDriftError is not attributed to the outer proxy
// ---------------------------------------------------------------------------
console.log("--- Check 11: Nested CacheDriftError Is Not Swallowed ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk11-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "outer-pkg",
      `
      export default function (pi) {
        pi.registerTool({
          name: "outer_tool",
          parameters: { type: "object", properties: {} },
          async execute(id, params, signal, onUpdate, ctx) {
            return globalThis.__v050Chk11Loader.invokeCapturedTool("outer-pkg", "missing_inner", id, params, signal, onUpdate, ctx);
          }
        });
      }
    `
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("outer-pkg")]);
    (globalThis as any).__v050Chk11Loader = loader;
    registerToolProxies(pi, loader, [entry("outer-pkg")], {
      version: 1,
      packages: {
        "outer-pkg": { tools: [{ name: "outer_tool", parameters: { type: "object", properties: {} } }], commands: [] },
      },
    });
    const proxy = pi.tools.get("outer_tool");
    let nested: unknown;
    try {
      await proxy.execute("nested", {});
    } catch (error) {
      nested = error;
    }
    assert(nested instanceof CacheDriftError, "nested missing-tool drift must propagate");
    assert((nested as CacheDriftError).target === "missing_inner", "drift must name the inner tool, not the outer proxy");
    assert((nested as CacheDriftError).packageName === "outer-pkg", "drift must keep the inner package name");
    console.log("  ✓ Nested CacheDriftError is not rewritten as outer-tool cacheDrift");
  } finally {
    delete (globalThis as any).__v050Chk11Loader;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 12: Failed load + reserved registerTool does not write an orphaned map
// ---------------------------------------------------------------------------
console.log("--- Check 12: Failed Load Does Not Stage Post-Failure Reserved Tools ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk12-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "failing-pkg",
      `
      export default function (pi) {
        pi.on("tool_call", () => {
          pi.registerTool({
            name: "web_search",
            parameters: { type: "object", properties: {} },
            execute() { return { content: [{ type: "text", text: "should-not-run" }] }; }
          });
          pi.registerCommand("web_search", { handler() { return "should-not-run"; } });
        });
        throw new Error("factory boom");
      }
    `
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("failing-pkg")]);
    registerToolProxies(pi, loader, [entry("failing-pkg")], {
      version: 1,
      packages: {
        "failing-pkg": { tools: [{ name: "web_search", parameters: objectSchema }], commands: [] },
      },
    });
    loader.reserveCommand("failing-pkg", "web_search");
    const proxy = pi.tools.get("web_search");
    const fail = await proxy.execute("load-fail", {});
    assert(fail.details.failed === true, "proxy must surface the sticky load failure");
    assert(loader.getPackageState("failing-pkg")?.status === "failed", "package stays failed");

    let lateErr: unknown;
    try {
      await pi.emit("tool_call");
    } catch (error) {
      lateErr = error;
    }
    assert(!lateErr, "surviving handler after failed load must not throw on an unrelated event");
    assert(!loader.getCapturedTool("failing-pkg", "web_search")?.execute, "must not capture reserved tool after failed load");
    assert(!loader.isCommandCaptured("failing-pkg", "web_search"), "must not capture reserved command after failed load");
    assert(pi.tools.get("web_search") === proxy, "must not host-register reserved tool after failed load");
    assert(!pi.commands.has("web_search"), "must not host-register reserved command after failed load");
    assert(loader.getPackageState("failing-pkg")?.status === "failed", "post-failure register must not revive a failed package");
    const again = await proxy.execute("still-failed", {});
    assert(again.details.failed === true, "proxy must keep returning loadFailure");
    console.log("  ✓ Failed-load leftover handler drops reserved tool/command without throwing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 13: Live schema mismatch is drift (retry handoff, refresh cache)
// ---------------------------------------------------------------------------
console.log("--- Check 13: Schema Mismatch Takes Retry Handoff ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk13-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        globalThis.__v050Chk13Exec = (globalThis.__v050Chk13Exec || 0) + 0;
        pi.registerTool({
          name: "web_search",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          execute() {
            globalThis.__v050Chk13Exec = (globalThis.__v050Chk13Exec || 0) + 1;
            return { content: [{ type: "text", text: "ran" }], details: { from: "real" } };
          }
        });
      }
    `
    );
    (globalThis as any).__v050Chk13Exec = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": {
          tools: [{ name: "web_search", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
          commands: [],
        },
      },
    });
    const proxy = pi.tools.get("web_search");
    const result = await proxy.execute("stale-schema", { q: "hi", ...secretParams });
    assert(result.details.executed === false, "schema mismatch must not execute with stale-validated params");
    assert(result.details.retryTool === "web_search", "schema mismatch must hand off a retry");
    assertNoCallerEcho(result, secretParams, "retryHandoff");
    assert((globalThis as any).__v050Chk13Exec === 0, "real tool must not run on a renamed-parameter schema");
    const persisted = readCache(root).packages["pi-web-access"]?.tools.find((item) => item.name === "web_search");
    assert(
      JSON.stringify(persisted?.parameters) === JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
      "mismatch must refresh the cache with the live schema"
    );
    const alreadyLoaded = await proxy.execute("stale-schema-again", secretParams);
    assert(alreadyLoaded.details.executed === false && alreadyLoaded.details.alreadyLoaded === true, "loaded mismatch must retry without reloading");
    assertNoCallerEcho(alreadyLoaded, secretParams, "alreadyLoaded retryHandoff");
    console.log("  ✓ Parameter rename is schema drift: retry handoff, cache refreshed, no execute");
  } finally {
    delete (globalThis as any).__v050Chk13Exec;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 14: Non-object cached schemas do not skip retry handoff
// ---------------------------------------------------------------------------
console.log("--- Check 14: Invalid Cached Schema Falls Back To Retry Handoff ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk14-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, CACHE_FILENAME), JSON.stringify({
      version: 1,
      packages: { "disk-pkg": { tools: [{ name: "array_tool", parameters: [] }], commands: [] } },
    }), "utf-8");
    assert(readCache(root).packages["disk-pkg"]?.tools[0]?.parameters === undefined, "array parameters on disk must not be treated as a schema");

    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "web_search",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute() {
            globalThis.__v050Chk14Exec = (globalThis.__v050Chk14Exec || 0) + 1;
            return { content: [{ type: "text", text: "ran" }], details: { from: "real" } };
          }
        });
      }
    `
    );
    (globalThis as any).__v050Chk14Exec = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": { tools: [{ name: "web_search", parameters: [] }], commands: [] },
      },
    });
    const proxy = pi.tools.get("web_search");
    assert(proxy.description.includes(formatProxyGuidance("pi-web-access", "web_search")), "array schema must use retry guidance");
    const result = await proxy.execute("array-schema", { q: "nope" });
    assert(result.details.executed === false && result.details.retryTool === "web_search", "array schema must not invoke");
    assert((globalThis as any).__v050Chk14Exec === 0, "invalid cached schema must not forward unvalidated params");
    console.log("  ✓ Array/typeless cached parameters take retryHandoff instead of invoke");
  } finally {
    delete (globalThis as any).__v050Chk14Exec;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 14b: hasPrepareArguments Gates First-Call Invoke ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk14b-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "prepare_tool",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          prepareArguments() { return {}; },
          execute() {
            globalThis.__v050Chk14bPrepare = (globalThis.__v050Chk14bPrepare || 0) + 1;
            return { content: [{ type: "text", text: "prepare" }], details: { from: "real" } };
          }
        });
        pi.registerTool({
          name: "plain_tool",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute() {
            globalThis.__v050Chk14bPlain = (globalThis.__v050Chk14bPlain || 0) + 1;
            return { content: [{ type: "text", text: "plain" }], details: { from: "real" } };
          }
        });
      }
    `,
    );
    (globalThis as any).__v050Chk14bPrepare = 0;
    (globalThis as any).__v050Chk14bPlain = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": {
          tools: [
            { name: "prepare_tool", parameters: objectSchema, hasPrepareArguments: true },
            { name: "plain_tool", parameters: objectSchema, hasPrepareArguments: false },
          ],
          commands: [],
        },
      },
    });
    const prepareProxy = pi.tools.get("prepare_tool");
    const plainProxy = pi.tools.get("plain_tool");
    assert(prepareProxy.description.includes(formatProxyGuidance("pi-web-access", "prepare_tool")), "hasPrepareArguments true must use retry guidance");
    assert(plainProxy.description.includes(formatProxyNote("pi-web-access", "plain_tool")), "hasPrepareArguments false must use invoke note");
    const prepareResult = await prepareProxy.execute("prep", {});
    assert(prepareResult.details.executed === false && prepareResult.details.retryTool === "prepare_tool", "hasPrepareArguments true must not first-call invoke");
    assert((globalThis as any).__v050Chk14bPrepare === 0, "hasPrepareArguments true must not run execute");
    const plainResult = await plainProxy.execute("plain", {});
    assert(plainResult.details.from === "real", "hasPrepareArguments false must invoke like undefined");
    assert((globalThis as any).__v050Chk14bPlain === 1, "hasPrepareArguments false must run execute");
    console.log("  ✓ hasPrepareArguments true is first-call-unsafe; false matches undefined");
  } finally {
    delete (globalThis as any).__v050Chk14bPrepare;
    delete (globalThis as any).__v050Chk14bPlain;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 14c: Unsafe Cached Schema Uses Permissive Host Validation ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk14c-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "prepare_tool",
          parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
          prepareArguments() { return { n: 1 }; },
          execute() {
            globalThis.__v050Chk14cExec = (globalThis.__v050Chk14cExec || 0) + 1;
            return { content: [{ type: "text", text: "prepare" }], details: { from: "real" } };
          }
        });
      }
    `,
    );
    (globalThis as any).__v050Chk14cExec = 0;
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    const strictSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    registerToolProxies(pi, loader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": {
          tools: [{ name: "prepare_tool", parameters: strictSchema, hasPrepareArguments: true }],
          commands: [],
        },
      },
    });
    const proxy = pi.tools.get("prepare_tool");
    assert(proxy.description.includes(formatProxyGuidance("pi-web-access", "prepare_tool")), "unsafe schema must use retry guidance");
    const shim = { n: "1" };
    validateToolArguments(proxy, { type: "toolCall", id: "shim", name: "prepare_tool", arguments: { ...shim } });
    validateToolArguments(proxy, { type: "toolCall", id: "missing", name: "prepare_tool", arguments: {} });
    const result = await proxy.execute("prep-shim", shim);
    assert(result.details.executed === false && result.details.retryTool === "prepare_tool", "shim input must reach execute and retry");
    assert((globalThis as any).__v050Chk14cExec === 0, "hasPrepareArguments true must not run execute");
    assertNoCallerEcho(result, shim, "prepareArguments retry");
    console.log("  ✓ Unsafe first-call schema is permissive so host validation cannot block retry");
  } finally {
    delete (globalThis as any).__v050Chk14cExec;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 14d: Truthy Non-Function execute Is Cache Drift ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk14d-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "web_search",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute: true,
        });
      }
    `,
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    const proxy = pi.tools.get("web_search");
    const loaded = await loader.loadPackage("pi-web-access");
    assert(loaded.success, loaded.error ?? "execute:true package must load");
    assert(loaded.missingTools?.includes("web_search"), "execute:true reserved tool must be missing after load");
    assert(!(loaded.newTools ?? []).includes("web_search"), "execute:true reserved tool must not be new/published");
    const drifted = await proxy.execute("oops", {});
    assert(drifted.details.cacheDrift === true, "stale proxy must cacheDrift for execute:true");
    let invokeErr: unknown;
    try {
      await loader.invokeCapturedTool("pi-web-access", "web_search", "x", {}, AbortSignal.abort(), () => {}, {});
    } catch (error) {
      invokeErr = error;
    }
    assert(invokeErr instanceof CacheDriftError, "execute:true public invoke must throw CacheDriftError");
    assert(!(invokeErr instanceof TypeError), "execute:true must not TypeError");
    console.log("  ✓ execute:true is cacheDrift on proxy and public invoke");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 14e: Reserved Tools Hidden From getAllTools/getActiveTools During Load ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk14e-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        globalThis.__v050Chk14eSeen = {
          all: (pi.getAllTools?.() ?? []).map((t) => t.name),
          active: pi.getActiveTools?.() ?? [],
        };
        const taken = (pi.getAllTools?.() ?? []).some((t) => t.name === "web_search");
        if (!taken) {
          pi.registerTool({
            name: "web_search",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            execute() {
              return { content: [{ type: "text", text: "ran" }], details: { from: "real" } };
            }
          });
        }
      }
    `,
    );
    const pi = fakePi(["web_search", "other_tool"]);
    pi.registerTool({ name: "other_tool", execute() { return { details: { from: "other" } }; } });
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    const proxy = pi.tools.get("web_search");
    const loaded = await loader.loadPackage("pi-web-access");
    assert(loaded.success, loaded.error ?? "skip-if-registered tools package must load");
    const seen = (globalThis as any).__v050Chk14eSeen;
    assert(!seen.all.includes("web_search"), "uncommitted reserved tool must be hidden from getAllTools");
    assert(seen.all.includes("other_tool"), "unrelated tools must stay visible on getAllTools");
    assert(!seen.active.includes("web_search"), "uncommitted reserved tool must be hidden from getActiveTools");
    assert(seen.active.includes("other_tool"), "unrelated active tools must stay visible");
    const result = await proxy.execute("first", {});
    assert(result.details.from === "real", "first deferred call must capture and invoke after skip-if-registered factory");
    console.log("  ✓ getAllTools skip-if-registered factory still captures");
  } finally {
    delete (globalThis as any).__v050Chk14eSeen;
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = join(tmpdir(), `pi-lazy-v050-chk14e-active-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        const taken = (pi.getActiveTools?.() ?? []).some((name) => name === "web_search");
        if (!taken) {
          pi.registerTool({
            name: "web_search",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            execute() {
              return { content: [{ type: "text", text: "ran" }], details: { from: "active" } };
            }
          });
        }
      }
    `,
    );
    const pi = fakePi(["web_search", "other_tool"]);
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    const proxy = pi.tools.get("web_search");
    const loaded = await loader.loadPackage("pi-web-access");
    assert(loaded.success, loaded.error ?? "active-tools skip-if-registered package must load");
    const result = await proxy.execute("first-active", {});
    assert(result.details.from === "active", "getActiveTools skip-if-registered factory must capture and invoke");
    console.log("  ✓ getActiveTools skip-if-registered factory still captures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("--- Check 14f: Live Host execute:true Does Not Shadow Proxy ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk14f-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "web_search",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute: true,
        });
      }
    `,
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    const loaded = await loader.loadPackage("pi-web-access");
    assert(loaded.success, loaded.error ?? "execute:true package must load");
    assert(loaded.missingTools?.includes("web_search"), "execute:true reserved tool must be missing after load");
    assert(!(loaded.newTools ?? []).includes("web_search"), "execute:true reserved tool must not be new/published");
    const live = (pi.getAllTools?.() ?? []).find((tool: any) => tool.name === "web_search");
    assert(typeof live?.execute === "function", "execute:true must not replace the live host proxy");
    const drifted = await live.execute("live", {});
    assert(drifted.details.cacheDrift === true, "live host execute:true must cacheDrift, not TypeError");
    assert(!(drifted instanceof TypeError), "live host execute:true must not TypeError");
    console.log("  ✓ live getAllTools execute:true keeps proxy and reports cacheDrift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 15: JSON-schema representability (TypeBox, DAG, cycles)
// ---------------------------------------------------------------------------
console.log("--- Check 15: JSON Schema Representability ---");
{
  const plain = Type.Object({ a: Type.String(), b: Type.Optional(Type.String()) });
  assert(schemaIsJsonRepresentable(plain), "ordinary Type.Object must be JSON-representable");
  const shared = { type: "string" };
  assert(schemaIsJsonRepresentable({ type: "object", properties: { a: shared, b: shared } }), "shared DAG subobjects must not be treated as cycles");
  const cyclic: { type: string; properties: Record<string, unknown> } = { type: "object", properties: {} };
  cyclic.properties.self = cyclic;
  assert(!schemaIsJsonRepresentable(cyclic), "actual cycles must be rejected");

  const DEPTH = 24;
  const visits = { n: 0 };
  const wrap = (obj: object) =>
    new Proxy(obj, {
      ownKeys(target) {
        visits.n++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        visits.n++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  const diamond = (leaf: object) => {
    let node: object = wrap(leaf);
    for (let i = 0; i < DEPTH; i++) {
      node = wrap({ type: "object", properties: wrap({ a: node, b: node }) });
    }
    return node;
  };
  const unique = 1 + 2 * DEPTH;
  const nearLinear = unique * 8;
  visits.n = 0;
  assert(schemaIsJsonRepresentable(diamond({ type: "string" })), "deep diamond DAG must be representable");
  assert(visits.n <= nearLinear, `deep diamond visits must be near-linear, got ${visits.n}`);
  visits.n = 0;
  const dag = diamond({ type: "string" });
  const cloned = cloneJsonValue(dag);
  assert(visits.n <= nearLinear, `deep diamond clone visits must be near-linear, got ${visits.n}`);
  visits.n = 0;
  assert(schemasEquivalent(cloned, dag), "cloned diamond must equate without expanding");
  assert(visits.n <= nearLinear, `deep diamond equate visits must be near-linear, got ${visits.n}`);
  visits.n = 0;
  assert(!schemaIsJsonRepresentable(diamond({ bad: () => {} })), "deep diamond with function leaf must be rejected");
  assert(visits.n <= nearLinear, `false deep diamond visits must be near-linear, got ${visits.n}`);
  assert(!schemaIsJsonRepresentable(Type.Refine(Type.Object({ q: Type.String() }), () => true)), "refined schemas must not be representable");
  assert(
    !schemaIsJsonRepresentable(Type.Codec(Type.String()).Decode((value) => value).Encode((value) => value)),
    "codec schemas must not be representable",
  );
  assert(schemaIsJsonRepresentable(Type.Unsafe({ type: "object", properties: {} })), "unsafe schemas carry only the inert ~unsafe marker and must round-trip");
  const Transform = (Type as { Transform?: (...args: any[]) => unknown }).Transform;
  if (typeof Transform === "function") {
    assert(!schemaIsJsonRepresentable(Transform(Type.String())), "transform schemas must not be representable");
  }
  assert(!schemaIsJsonRepresentable({ type: "object", properties: { x: new Map() } }), "nested Map must not be representable");
  assert(!schemaIsJsonRepresentable({ type: "object", properties: { x: new Date() } }), "nested Date must not be representable");
  assert(!schemaIsJsonRepresentable({ type: "object", properties: { n: NaN } }), "NaN must not be representable");
  assert(!schemaIsJsonRepresentable({ type: "object", properties: { n: Infinity } }), "Infinity must not be representable");

  const root = join(tmpdir(), `pi-lazy-v050-chk15-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    (globalThis as any).__v050Chk15Object = Type.Object({ q: Type.String() });
    (globalThis as any).__v050Chk15Unsafe = Type.Unsafe({ type: "object", properties: { u: { type: "string" } } });
    (globalThis as any).__v050Chk15Refine = Type.Refine(Type.Object({ q: Type.String() }), () => true);
    fixture(
      root,
      "schema-pkg",
      `
      export default function (pi) {
        pi.registerTool({ name: "plain_tool", parameters: globalThis.__v050Chk15Object, execute() { return { content: [{ type: "text", text: "ok" }] }; } });
        pi.registerTool({ name: "unsafe_tool", parameters: globalThis.__v050Chk15Unsafe, execute() { return { content: [{ type: "text", text: "ok" }] }; } });
        pi.registerTool({ name: "refined_tool", parameters: globalThis.__v050Chk15Refine, execute() { return { content: [{ type: "text", text: "ok" }] }; } });
      }
    `,
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("schema-pkg")]);
    const loaded = await loader.loadPackage("schema-pkg");
    assert(loaded.success, loaded.error ?? "schema-pkg must load");
    const tools = readCache(root).packages["schema-pkg"]?.tools ?? [];
    const plainCached = tools.find((item) => item.name === "plain_tool");
    const unsafeCached = tools.find((item) => item.name === "unsafe_tool");
    const refinedCached = tools.find((item) => item.name === "refined_tool");
    assert(isCachedToolSchema(plainCached?.parameters), "ordinary Type.Object must persist its JSON projection");
    assert((plainCached?.parameters as { properties?: { q?: { type?: string } } }).properties?.q?.type === "string", "cached Type.Object must keep JSON string properties");
    assert(isCachedToolSchema(unsafeCached?.parameters), "Type.Unsafe must persist its JSON projection");
    assert((unsafeCached?.parameters as { properties?: { u?: { type?: string } } }).properties?.u?.type === "string", "cached Type.Unsafe must keep JSON string properties");
    assert(refinedCached?.name === "refined_tool" && refinedCached.parameters === undefined, "refined TypeBox schemas must not persist parameters");
    console.log("  ✓ Type.Object/DAG/unsafe cache; refine/codec/cycle do not");
  } finally {
    delete (globalThis as any).__v050Chk15Object;
    delete (globalThis as any).__v050Chk15Unsafe;
    delete (globalThis as any).__v050Chk15Refine;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 16: Live option mismatch is retry handoff
// ---------------------------------------------------------------------------
console.log("--- Check 16: Live Option Mismatch Takes Retry Handoff ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk16-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "mode_tool",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          executionMode: "sequential",
          execute() {
            globalThis.__v050Chk16Mode = (globalThis.__v050Chk16Mode || 0) + 1;
            return { content: [{ type: "text", text: "mode" }], details: { from: "real" } };
          }
        });
        pi.registerTool({
          name: "sample_tool",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          constrainedSampling: { maxTokens: 2 },
          execute() {
            globalThis.__v050Chk16Sample = (globalThis.__v050Chk16Sample || 0) + 1;
            return { content: [{ type: "text", text: "sample" }], details: { from: "real" } };
          }
        });
      }
    `,
    );
    (globalThis as any).__v050Chk16Mode = 0;
    (globalThis as any).__v050Chk16Sample = 0;
    const modeCache: LazyLoaderCache = {
      version: 1,
      packages: {
        "pi-web-access": {
          tools: [{ name: "mode_tool", parameters: objectSchema, executionMode: "parallel" }],
          commands: [],
        },
      },
    };
    const sampleCache: LazyLoaderCache = {
      version: 1,
      packages: {
        "pi-web-access": {
          tools: [{ name: "sample_tool", parameters: objectSchema, constrainedSampling: { maxTokens: 1 } }],
          commands: [],
        },
      },
    };
    const modePi = fakePi();
    const modeLoader = new LazyLoader(modePi as any, root, [entry("pi-web-access")]);
    registerToolProxies(modePi, modeLoader, [entry("pi-web-access")], modeCache);
    const modeResult = await modePi.tools.get("mode_tool").execute("mode", {});
    assert(modeResult.details.executed === false && modeResult.details.retryTool === "mode_tool", "cached parallel vs live sequential must hand off");
    assert((globalThis as any).__v050Chk16Mode === 0, "executionMode mismatch must not invoke");
    const samplePi = fakePi();
    const sampleLoader = new LazyLoader(samplePi as any, root, [entry("pi-web-access")]);
    registerToolProxies(samplePi, sampleLoader, [entry("pi-web-access")], sampleCache);
    const sampleResult = await samplePi.tools.get("sample_tool").execute("sample", {});
    assert(sampleResult.details.executed === false && sampleResult.details.retryTool === "sample_tool", "constrainedSampling mismatch must hand off");
    assert((globalThis as any).__v050Chk16Sample === 0, "constrainedSampling mismatch must not invoke");
    console.log("  ✓ Cached parallel→sequential and constrainedSampling mismatch hand off");
  } finally {
    delete (globalThis as any).__v050Chk16Mode;
    delete (globalThis as any).__v050Chk16Sample;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 17: promptSnippet / promptGuidelines round-trip through the cache onto proxies
// ---------------------------------------------------------------------------
console.log("--- Check 17: promptSnippet/promptGuidelines Survive Deferral ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk17-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "prompt-pkg",
      `
      export default function (pi) {
        pi.registerTool({
          name: "todo",
          description: "Manage tasks",
          promptSnippet: "Manage a task list",
          promptGuidelines: ["Use todo for 3+ steps.", "  ", 42, "Mark in_progress first."],
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        });
        pi.registerTool({
          name: "bare",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        });
      }
    `,
    );
    const warmPi = fakePi();
    const warmLoader = new LazyLoader(warmPi as any, root, [entry("prompt-pkg")]);
    const loaded = await warmLoader.loadPackage("prompt-pkg");
    assert(loaded.success, loaded.error ?? "prompt-pkg must load");
    const cached = readCache(root).packages["prompt-pkg"]?.tools ?? [];
    const todoCached = cached.find((item) => item.name === "todo");
    const bareCached = cached.find((item) => item.name === "bare");
    assert(todoCached?.promptSnippet === "Manage a task list", "promptSnippet must persist in the cache");
    assert(
      JSON.stringify(todoCached?.promptGuidelines) === JSON.stringify(["Use todo for 3+ steps.", "Mark in_progress first."]),
      "promptGuidelines must persist with blank/non-string entries dropped",
    );
    assert(bareCached?.promptSnippet === undefined && bareCached?.promptGuidelines === undefined, "tools without prompt fields must not gain them");

    const coldPi = fakePi();
    const coldLoader = new LazyLoader(coldPi as any, root, [entry("prompt-pkg")]);
    registerToolProxies(coldPi, coldLoader, [entry("prompt-pkg")], readCache(root));
    const todoProxy = coldPi.tools.get("todo");
    const bareProxy = coldPi.tools.get("bare");
    assert(todoProxy?.promptSnippet === "Manage a task list", "deferred proxy must carry promptSnippet before first use");
    assert(
      JSON.stringify(todoProxy?.promptGuidelines) === JSON.stringify(["Use todo for 3+ steps.", "Mark in_progress first."]),
      "deferred proxy must carry promptGuidelines before first use",
    );
    assert(!("promptSnippet" in bareProxy) && !("promptGuidelines" in bareProxy), "proxy must not add undefined prompt keys");
    console.log("  ✓ promptSnippet/promptGuidelines persist in cache and land on deferred proxies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 18: Deferred-tool prompt guidance for tools Pi did not render
// ---------------------------------------------------------------------------
console.log("--- Check 18: Deferred Tool Prompt Guidance ---");
{
  const guidanceCache: LazyLoaderCache = {
    version: 1,
    packages: {
      "prompt-pkg": {
        tools: [
          { name: "todo", promptSnippet: "Manage a task list", promptGuidelines: ["Use todo for 3+ steps."] },
          { name: "other", promptSnippet: "Other tool", promptGuidelines: ["Other guideline."] },
          { name: "bare" },
        ],
        commands: [],
      },
    },
  };
  const pkg = { ...entry("prompt-pkg"), guidelineTools: ["todo"] };

  const hidden = buildDeferredToolGuidance([pkg], guidanceCache, ["fabric_exec"]);
  assert(hidden.startsWith(DEFERRED_GUIDANCE_HEADER), "guidance must start with the header");
  assert(hidden.includes("- todo: Manage a task list") && hidden.includes("- other: Other tool"), "snippets must be emitted for every hidden proxied tool");
  assert(!hidden.includes("bare"), "tools without a snippet or guidelines must not be listed");
  assert(hidden.includes("- Use todo for 3+ steps."), "guidelines must be emitted for allowlisted tools");
  assert(!hidden.includes("Other guideline."), "guidelines must not be emitted for non-allowlisted tools");

  const native = buildDeferredToolGuidance([pkg], guidanceCache, ["todo", "other", "bare"]);
  assert(native === "", "tools Pi already rendered must produce no guidance");

  const filtered = buildDeferredToolGuidance([{ ...pkg, proxyTools: ["other"] }], guidanceCache, []);
  assert(!filtered.includes("todo") && filtered.includes("- other: Other tool"), "tools outside the proxy allowlist must be skipped");

  assert(buildDeferredToolGuidance([pkg], { version: 1, packages: {} }, []) === "", "empty cache must produce no guidance");

  console.log("  \u2713 Snippets for hidden proxied tools, allowlisted guidelines, nothing for rendered tools");
}

console.log("\n==============================================");
console.log("ALL v0.8.0 CACHE/SCHEMA CHECKS PASSED");
console.log("==============================================");
