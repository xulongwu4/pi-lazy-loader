import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Type } from "typebox";

import { CacheDriftError, LazyLoader } from "../src/loader.js";
import { registerToolProxies } from "../src/tool-proxy.js";
import { readCache, type LazyLoaderCache } from "../src/cache.js";
import { fakePi } from "./fake-pi.js";

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

console.log("=== Running v0.8.0 Late-Registration Checks ===\n");

// ---------------------------------------------------------------------------
// Check 17: Late capture invokes; missingTools stays a load snapshot
// ---------------------------------------------------------------------------
console.log("--- Check 17: Late Capture Invokes; missingTools Is Snapshot ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk17-${Date.now()}`);
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
          execute() {
            return { content: [{ type: "text", text: "search" }], details: { from: "load" } };
          }
        });
        pi.on("tool_call", () => {
          pi.registerTool({
            name: "fetch_content",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            execute() {
              return { content: [{ type: "text", text: "fetch" }], details: { from: "late" } };
            }
          });
        });
      }
    `,
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    const searchProxy = pi.tools.get("web_search");
    const fetchProxy = pi.tools.get("fetch_content");
    const first = await searchProxy.execute("one", {});
    assert(first.details.from === "load", "load-success commit must capture and invoke");
    assert(pi.tools.get("web_search") !== searchProxy, "load-success must replace the host proxy");
    assert(loader.getCapturedTool("pi-web-access", "web_search")?.execute, "load-success must capture execute");

    const loadResult = await loader.loadPackage("pi-web-access");
    const missingSnapshot = loadResult.missingTools;
    assert(missingSnapshot?.includes("fetch_content"), "load result snapshot must list fetch_content");
    const drift = await fetchProxy.execute("missing", {});
    assert(drift.details.cacheDrift === true, "diagnostics must use capturedTools, not missingTools");

    await pi.emit("tool_call");
    assert(pi.tools.get("fetch_content") !== fetchProxy, "late reserved register must replace the host proxy");
    assert(loader.getCapturedTool("pi-web-access", "fetch_content")?.execute, "late reserved register must capture execute");
    assert(missingSnapshot?.includes("fetch_content"), "previously returned missingTools must stay a snapshot");
    assert(loader.getPackageState("pi-web-access")?.missingTools.includes("fetch_content"), "PackageState.missingTools must stay the load snapshot");

    const late = await fetchProxy.execute("late", {});
    assert(late.details.from === "late", "late capture must invoke through the stale proxy");
    const invoked = await loader.invokeCapturedTool("pi-web-access", "fetch_content", "late-direct", {}, AbortSignal.abort(), () => {}, {});
    assert(invoked.details.from === "late", "invokeCapturedTool must see late capture");

    let nested: unknown;
    try {
      await loader.invokeCapturedTool("pi-web-access", "never_tool", "x", {}, AbortSignal.abort(), () => {}, {});
    } catch (error) {
      nested = error;
    }
    assert(nested instanceof CacheDriftError, "missing capture must still throw CacheDriftError");
    console.log("  ✓ Load-success and late commit both capture+replace; missingTools stays a snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 18: Protected collision caches the lazy schema for the next session
// ---------------------------------------------------------------------------
console.log("--- Check 18: Protected Name Keeps Lazy Schema For Next Session ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk18-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    const lazySchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const foreignSchema = { type: "object", properties: { foreign: { type: "boolean" } } };
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "web_search",
          description: "lazy own search",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          execute() { return { content: [{ type: "text", text: "lazy" }] }; }
        });
      }
    `,
    );
    const pi = fakePi();
    const eager = { name: "web_search", description: "Genuine eager search tool", parameters: foreignSchema, execute() {} };
    pi.registerTool(eager);
    const loader = new LazyLoader(pi as any, root, [entry("pi-web-access")]);
    registerToolProxies(pi, loader, [entry("pi-web-access")], webCache);
    assert(pi.tools.get("web_search") === eager, "collision session must keep the protected host tool");
    const loaded = await loader.loadPackage("pi-web-access");
    assert(loaded.success, loaded.error ?? "collision load must succeed");
    assert(pi.tools.get("web_search") === eager, "load must not replace the protected host tool");
    const persisted = readCache(root).packages["pi-web-access"]?.tools.find((item) => item.name === "web_search");
    assert(JSON.stringify(persisted?.parameters) === JSON.stringify(lazySchema), "collision must cache the lazy package schema, not the foreign one");
    assert(persisted?.description === "lazy own search", "collision must cache the lazy description");

    const nextPi = fakePi();
    const nextLoader = new LazyLoader(nextPi as any, root, [entry("pi-web-access")]);
    registerToolProxies(nextPi, nextLoader, [entry("pi-web-access")], readCache(root));
    const proxy = nextPi.tools.get("web_search");
    assert(proxy, "next session without collision must register a lazy proxy");
    assert(JSON.stringify(proxy.parameters) === JSON.stringify(lazySchema), "next-session proxy must use the lazy schema");
    assert(proxy.description.includes("lazy own search"), "next-session proxy must not use the foreign description");
    assert(!JSON.stringify(proxy.parameters).includes("foreign"), "next-session proxy must never carry the foreign schema");
    console.log("  ✓ Collision caches lazy schema; next clean session gets the lazy proxy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 19: Absent constrainedSampling is equivalent to false
// ---------------------------------------------------------------------------
console.log("--- Check 19: Absent constrainedSampling Equals False ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk19-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "sample_tool",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          constrainedSampling: false,
          execute() {
            globalThis.__v050Chk19Sample = (globalThis.__v050Chk19Sample || 0) + 1;
            return { content: [{ type: "text", text: "sample" }], details: { from: "real" } };
          }
        });
        pi.registerTool({
          name: "mode_tool",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          executionMode: false,
          execute() {
            globalThis.__v050Chk19Mode = (globalThis.__v050Chk19Mode || 0) + 1;
            return { content: [{ type: "text", text: "mode" }], details: { from: "real" } };
          }
        });
      }
    `,
    );
    (globalThis as any).__v050Chk19Sample = 0;
    (globalThis as any).__v050Chk19Mode = 0;
    const samplePi = fakePi();
    const sampleLoader = new LazyLoader(samplePi as any, root, [entry("pi-web-access")]);
    registerToolProxies(samplePi, sampleLoader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": { tools: [{ name: "sample_tool", parameters: objectSchema }], commands: [] },
      },
    });
    const sampleResult = await samplePi.tools.get("sample_tool").execute("sample", {});
    assert(sampleResult.details.from === "real", "cached absent constrainedSampling vs live false must invoke");
    assert((globalThis as any).__v050Chk19Sample === 1, "absent vs false constrainedSampling must not hand off");
    const modePi = fakePi();
    const modeLoader = new LazyLoader(modePi as any, root, [entry("pi-web-access")]);
    registerToolProxies(modePi, modeLoader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": { tools: [{ name: "mode_tool", parameters: objectSchema }], commands: [] },
      },
    });
    const modeResult = await modePi.tools.get("mode_tool").execute("mode", {});
    assert(modeResult.details.executed === false && modeResult.details.retryTool === "mode_tool", "executionMode undefined vs false must still hand off");
    assert((globalThis as any).__v050Chk19Mode === 0, "executionMode undefined vs false must not invoke");
    console.log("  ✓ Absent vs false constrainedSampling invokes; executionMode does not over-normalize");
  } finally {
    delete (globalThis as any).__v050Chk19Sample;
    delete (globalThis as any).__v050Chk19Mode;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 20: Live Refine/Codec vs cached plain schema is handoff
// ---------------------------------------------------------------------------
console.log("--- Check 20: Live Semantic Schema Wrapper Takes Retry Handoff ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk20-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    const plain = Type.Object({ q: Type.String() });
    const refine = Type.Refine(Type.Object({ q: Type.String() }), () => true);
    const codec = Type.Codec(Type.Object({ q: Type.String() })).Decode((value) => value).Encode((value) => value);
    assert(JSON.stringify(plain) === JSON.stringify(refine), "refine JSON projection must match plain object");
    assert(JSON.stringify(plain) === JSON.stringify(codec), "codec JSON projection must match plain object");
    (globalThis as any).__v050Chk20Refine = refine;
    (globalThis as any).__v050Chk20Codec = codec;
    fixture(
      root,
      "pi-web-access",
      `
      export default function (pi) {
        pi.registerTool({
          name: "refined_tool",
          parameters: globalThis.__v050Chk20Refine,
          execute() {
            globalThis.__v050Chk20RefineExec = (globalThis.__v050Chk20RefineExec || 0) + 1;
            return { content: [{ type: "text", text: "ran" }], details: { from: "real" } };
          }
        });
        pi.registerTool({
          name: "codec_tool",
          parameters: globalThis.__v050Chk20Codec,
          execute() {
            globalThis.__v050Chk20CodecExec = (globalThis.__v050Chk20CodecExec || 0) + 1;
            return { content: [{ type: "text", text: "ran" }], details: { from: "real" } };
          }
        });
      }
    `,
    );
    (globalThis as any).__v050Chk20RefineExec = 0;
    (globalThis as any).__v050Chk20CodecExec = 0;
    const cachedParameters = JSON.parse(JSON.stringify(plain));
    const refinePi = fakePi();
    const refineLoader = new LazyLoader(refinePi as any, root, [entry("pi-web-access")]);
    registerToolProxies(refinePi, refineLoader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": { tools: [{ name: "refined_tool", parameters: cachedParameters }], commands: [] },
      },
    });
    const refineResult = await refinePi.tools.get("refined_tool").execute("refine", { q: "hi" });
    assert(refineResult.details.executed === false && refineResult.details.retryTool === "refined_tool", "cached plain vs live Refine must hand off");
    assert((globalThis as any).__v050Chk20RefineExec === 0, "live Refine must not execute against cached plain schema");
    const codecPi = fakePi();
    const codecLoader = new LazyLoader(codecPi as any, root, [entry("pi-web-access")]);
    registerToolProxies(codecPi, codecLoader, [entry("pi-web-access")], {
      version: 1,
      packages: {
        "pi-web-access": { tools: [{ name: "codec_tool", parameters: cachedParameters }], commands: [] },
      },
    });
    const codecResult = await codecPi.tools.get("codec_tool").execute("codec", { q: "hi" });
    assert(codecResult.details.executed === false && codecResult.details.retryTool === "codec_tool", "cached plain vs live Codec must hand off");
    assert((globalThis as any).__v050Chk20CodecExec === 0, "live Codec must not execute against cached plain schema");
    console.log("  ✓ Cached plain + live Refine/Codec hand off without execute");
  } finally {
    delete (globalThis as any).__v050Chk20Refine;
    delete (globalThis as any).__v050Chk20Codec;
    delete (globalThis as any).__v050Chk20RefineExec;
    delete (globalThis as any).__v050Chk20CodecExec;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Check 21: Multiple late registrations in one turn write the cache once
// ---------------------------------------------------------------------------
console.log("--- Check 21: Late Registrations Batch One Cache Refresh ---");
{
  const root = join(tmpdir(), `pi-lazy-v050-chk21-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    (globalThis as any).__v050Chk21Snap = () => {
      (globalThis as any).__v050Chk21Snaps.push(
        (readCache(root).packages["batch-pkg"]?.tools ?? []).map((item) => item.name).sort(),
      );
    };
    (globalThis as any).__v050Chk21Snaps = [];
    fixture(
      root,
      "batch-pkg",
      `
      export default function (pi) {
        pi.registerTool({ name: "base_tool", parameters: { type: "object" }, execute() { return { content: [] }; } });
        pi.on("tool_call", () => {
          pi.registerTool({ name: "late_a", parameters: { type: "object" }, execute() { return { content: [] }; } });
          globalThis.__v050Chk21Snap();
          pi.registerTool({ name: "late_b", parameters: { type: "object" }, execute() { return { content: [] }; } });
          globalThis.__v050Chk21Snap();
          pi.registerCommand("late_cmd_a", { handler() { return "a"; } });
          globalThis.__v050Chk21Snap();
          pi.registerCommand("late_cmd_b", { handler() { return "b"; } });
          globalThis.__v050Chk21Snap();
        });
      }
    `,
    );
    const pi = fakePi();
    const loader = new LazyLoader(pi as any, root, [entry("batch-pkg")]);
    const loaded = await loader.loadPackage("batch-pkg");
    assert(loaded.success, loaded.error ?? "batch-pkg must load");
    const before = (readCache(root).packages["batch-pkg"]?.tools ?? []).map((item) => item.name).sort();
    assert(JSON.stringify(before) === JSON.stringify(["base_tool"]), "pre-late cache must only have the factory tool");
    await pi.emit("tool_call");
    const mid = (globalThis as any).__v050Chk21Snaps as string[][];
    assert(mid.length === 4, "handler must snapshot after each late registration");
    for (const snap of mid) {
      assert(JSON.stringify(snap) === JSON.stringify(["base_tool"]), "late registrations in one turn must not write the cache until the microtask");
    }
    const after = readCache(root).packages["batch-pkg"];
    assert(
      JSON.stringify((after?.tools ?? []).map((item) => item.name).sort()) === JSON.stringify(["base_tool", "late_a", "late_b"]),
      "one post-turn refresh must persist every late tool",
    );
    assert(
      JSON.stringify((after?.commands ?? []).map((item) => item.name).sort()) === JSON.stringify(["late_cmd_a", "late_cmd_b"]),
      "one post-turn refresh must persist every late command",
    );
    console.log("  ✓ N late registrations in one turn cause one cache refresh");
  } finally {
    delete (globalThis as any).__v050Chk21Snap;
    delete (globalThis as any).__v050Chk21Snaps;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n==============================================");
console.log("ALL v0.8.0 LATE-REGISTRATION CHECKS PASSED");
console.log("==============================================");
