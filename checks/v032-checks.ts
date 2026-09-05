import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LazyLoader } from "../src/loader.js";
import {
  readToolCache,
  writeToolCache,
  updateCachedPackageTools,
  buildLazyLoadGuidance,
  computePackageFingerprint,
  getPiRuntimeVersion,
  sanitizeToolDefinition,
  isJsonLossless,
  TOOL_CACHE_FILENAME,
  MAX_CACHE_FILE_SIZE,
  type ToolCacheData,
  type CachedTool,
} from "../src/tool-cache.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("=== Running v0.3.2 Verification Checks ===\n");

// -----------------------------------------------------------------------------
// CHECK 1: Captured definition with all eight fields round-trips intact
// -----------------------------------------------------------------------------
console.log("--- Check 1: All Eight Fields Round-Trip ---");
const testDir1 = join(tmpdir(), `pi-lazy-v032-chk1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir1, { recursive: true });

try {
  const fullToolDef = {
    name: "alpha_search",
    label: "Alpha Search",
    description: "Search documents via Alpha engine",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    promptSnippet: "Search alpha index",
    promptGuidelines: ["Provide query string", "Handle empty results"],
    executionMode: "sequential",
    prepareArguments: (args: any) => ({ ...args, prepared: true }),
  };

  updateCachedPackageTools(testDir1, "test-pkg-alpha", "1.0.0:1000:0.84.4", [fullToolDef]);

  const cache = readToolCache(testDir1);
  assert(cache.version === 2, "Cache version must be 2");
  assert(cache.packages["test-pkg-alpha"] !== undefined, "test-pkg-alpha must exist in cache");
  assert(cache.packages["test-pkg-alpha"].tools.length === 1, "Exactly one tool must be cached");

  const tool = cache.packages["test-pkg-alpha"].tools[0];
  assert(tool.name === "alpha_search", "tool.name must match");
  assert(tool.label === "Alpha Search", "tool.label must match");
  assert(tool.description === "Search documents via Alpha engine", "tool.description must match");
  assert(
    JSON.stringify(tool.parameters) === JSON.stringify(fullToolDef.parameters),
    "tool.parameters schema must round-trip exactly"
  );
  assert(tool.promptSnippet === "Search alpha index", "tool.promptSnippet must match");
  assert(
    JSON.stringify(tool.promptGuidelines) === JSON.stringify(["Provide query string", "Handle empty results"]),
    "tool.promptGuidelines must match"
  );
  assert(tool.executionMode === "sequential", "tool.executionMode must match");
  assert(tool.hasPrepareArguments === true, "tool.hasPrepareArguments must be true");
  assert(Object.keys(tool).length === 8, `Stored tool must have exactly 8 fields, found ${Object.keys(tool).length}`);

  console.log("  ✓ All eight fields round-trip through write then read intact");
} finally {
  rmSync(testDir1, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 2: Deliberately un-cached fields are ABSENT from stored metadata
// -----------------------------------------------------------------------------
console.log("--- Check 2: Excluded Fields Absence ---");
const testDir2 = join(tmpdir(), `pi-lazy-v032-chk2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir2, { recursive: true });

try {
  const toolWithExcludedFields = {
    name: "beta_render",
    label: "Beta Render",
    description: "Render preview",
    parameters: { type: "object" },
    constrainedSampling: true,
    renderShell: () => "shell",
    renderCall: () => "call",
    renderResult: () => "result",
  };

  updateCachedPackageTools(testDir2, "test-pkg-beta", "1.0.0:1000:0.84.4", [toolWithExcludedFields]);

  const cache = readToolCache(testDir2);
  const tool = cache.packages["test-pkg-beta"].tools[0];

  assert(!("constrainedSampling" in tool), "constrainedSampling must be ABSENT from stored cache");
  assert(!("renderShell" in tool), "renderShell must be ABSENT from stored cache");
  assert(!("renderCall" in tool), "renderCall must be ABSENT from stored cache");
  assert(!("renderResult" in tool), "renderResult must be ABSENT from stored cache");

  console.log("  ✓ constrainedSampling, renderShell, renderCall, renderResult are absent from stored cache");
} finally {
  rmSync(testDir2, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 3: prepareArguments stores hasPrepareArguments: true without storing function
// -----------------------------------------------------------------------------
console.log("--- Check 3: prepareArguments Gating Flag ---");
const testDir3 = join(tmpdir(), `pi-lazy-v032-chk3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir3, { recursive: true });

try {
  const toolWithPrep = {
    name: "gamma_prep",
    description: "Tool with prepareArguments",
    parameters: { type: "object" },
    prepareArguments: (args: any) => ({ ...args, prepared: true }),
  };

  const toolWithoutPrep = {
    name: "gamma_plain",
    description: "Tool without prepareArguments",
    parameters: { type: "object" },
  };

  updateCachedPackageTools(testDir3, "test-pkg-gamma", "1.0.0:1000:0.84.4", [toolWithPrep, toolWithoutPrep]);

  const cache = readToolCache(testDir3);
  const tools = cache.packages["test-pkg-gamma"].tools;
  const cachedPrep = tools.find((t) => t.name === "gamma_prep")!;
  const cachedPlain = tools.find((t) => t.name === "gamma_plain")!;

  assert(cachedPrep.hasPrepareArguments === true, "hasPrepareArguments must be true when prepareArguments is present");
  assert(!("prepareArguments" in cachedPrep), "prepareArguments function must NOT be stored in cache");
  // Explicit false means "fully harvested, confirmed no prepare hook". Absence is reserved
  // for name-only entries (legacy or degraded), which v0.4.0 must not treat as confirmed.
  assert(cachedPlain.hasPrepareArguments === false, "fully harvested tool must record hasPrepareArguments: false");
  assert(!("hasPrepareArguments" in sanitizeToolDefinition("legacy_name_only")!), "name-only entry must leave the flag absent");

  console.log("  ✓ hasPrepareArguments: true is stored and prepareArguments function is omitted");
} finally {
  rmSync(testDir3, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 4: Non-round-trippable metadata degrades to name-only entry without throwing
// -----------------------------------------------------------------------------
console.log("--- Check 4: JSON Round-Trip Loss Degradation ---");
const testDir4 = join(tmpdir(), `pi-lazy-v032-chk4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir4, { recursive: true });

try {
  // Circular reference in parameters
  const circularObj: any = { type: "object" };
  circularObj.self = circularObj;

  const toolWithCircular = {
    name: "delta_circular",
    description: "Circular tool",
    parameters: circularObj,
  };

  // NaN in parameters (JSON.stringify converts NaN to null, which alters data on round trip)
  const toolWithNan = {
    name: "delta_nan",
    description: "NaN tool",
    parameters: { val: NaN },
  };

  // BigInt in parameters (JSON.stringify throws on BigInt)
  const toolWithBigInt = {
    name: "delta_bigint",
    description: "BigInt tool",
    parameters: { val: 42n },
  };

  // Must not throw
  updateCachedPackageTools(testDir4, "test-pkg-delta", "1.0.0:1000:0.84.4", [
    toolWithCircular,
    toolWithNan,
    toolWithBigInt,
  ]);

  const cache = readToolCache(testDir4);
  const tools = cache.packages["test-pkg-delta"].tools;

  assert(tools.length === 3, "All three tools must be preserved");

  for (const t of tools) {
    assert(typeof t.name === "string", "Tool must retain name");
    assert(
      Object.keys(t).length === 1,
      `Tool ${t.name} must degrade to name-only entry, got keys: ${Object.keys(t).join(", ")}`
    );
  }

  console.log("  ✓ Tools with non-serializable metadata degrade to name-only without throwing");
} finally {
  rmSync(testDir4, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 5: v1 cache file reads back as name-only entries & guidance still works
// -----------------------------------------------------------------------------
console.log("--- Check 5: v1 Cache Compatibility & Guidance ---");
const testDir5 = join(tmpdir(), `pi-lazy-v032-chk5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir5, { recursive: true });

try {
  // Write a legacy v1 cache file with tools: string[]
  const v1Content = JSON.stringify({
    version: 1,
    packages: {
      "pi-web-access": {
        fingerprint: "1.0.0:123456",
        tools: ["web_search", "url_fetch"],
      },
    },
  });
  writeFileSync(join(testDir5, TOOL_CACHE_FILENAME), v1Content, "utf-8");

  const readBack = readToolCache(testDir5);
  assert(readBack.version === 2, "Upgraded in-memory cache must have version 2");
  assert(readBack.packages["pi-web-access"] !== undefined, "Package must exist");

  const tools = readBack.packages["pi-web-access"].tools;
  assert(tools.length === 2, "Both tools must be read");
  assert(
    tools[0].name === "web_search" && Object.keys(tools[0]).length === 1,
    "v1 string must be mapped to name-only object { name: 'web_search' }"
  );
  assert(
    tools[1].name === "url_fetch" && Object.keys(tools[1]).length === 1,
    "v1 string must be mapped to name-only object { name: 'url_fetch' }"
  );

  const guidance = buildLazyLoadGuidance(
    [{ name: "pi-web-access", capability: "Web search and retrieval" }],
    readBack
  );

  assert(
    guidance.description.includes("(tools: web_search, url_fetch)"),
    `Guidance must include tool names from v1 cache: ${guidance.description}`
  );

  console.log("  ✓ v1 cache file reads back as name-only entries and produces tool guidance");
} finally {
  rmSync(testDir5, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 6: Oversized content degrades to names rather than dropping packages or throwing
// -----------------------------------------------------------------------------
console.log("--- Check 6: Oversize Cache Degradation ---");
const testDir6 = join(tmpdir(), `pi-lazy-v032-chk6-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir6, { recursive: true });

try {
  // Construct a large cache that exceeds MAX_CACHE_FILE_SIZE (64 KiB) when metadata is present
  const packageCount = 35;
  const largePackages: Record<string, any> = {};

  for (let i = 0; i < packageCount; i++) {
    const pkgName = `heavy-package-${i}`;
    largePackages[pkgName] = {
      fingerprint: `1.0.${i}:12345:0.84.4`,
      tools: [
        {
          name: `tool_${i}_alpha`,
          label: `Heavy Tool ${i} Alpha`,
          description: `A very descriptive description for heavy tool ${i} that consumes substantial cache bytes.`.repeat(4),
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 25 }, (_, p) => [
                `param_${p}`,
                {
                  type: "string",
                  description: `Detailed specification of parameter ${p} for tool ${i} in heavy package`,
                },
              ])
            ),
          },
          promptSnippet: `Snippet for tool ${i}`,
          promptGuidelines: [`Guideline A for ${i}`, `Guideline B for ${i}`],
          executionMode: "sequential",
        },
      ],
    };
  }

  const rawJson = JSON.stringify({ version: 2, packages: largePackages }, null, 2);
  const initialBytes = Buffer.byteLength(rawJson, "utf-8");
  assert(
    initialBytes > MAX_CACHE_FILE_SIZE,
    `Initial test cache size (${initialBytes}) must exceed MAX_CACHE_FILE_SIZE (${MAX_CACHE_FILE_SIZE})`
  );

  const writeResult = writeToolCache(testDir6, { version: 2, packages: largePackages });
  assert(writeResult === true, "writeToolCache must succeed via degradation rather than throwing or failing");

  const writtenBytes = statSync(join(testDir6, TOOL_CACHE_FILENAME)).size;
  assert(
    writtenBytes <= MAX_CACHE_FILE_SIZE,
    `Degraded file size (${writtenBytes}) must not exceed MAX_CACHE_FILE_SIZE (${MAX_CACHE_FILE_SIZE})`
  );

  const readBack = readToolCache(testDir6);
  assert(
    Object.keys(readBack.packages).length === packageCount,
    `All ${packageCount} packages must be preserved after degradation, found ${Object.keys(readBack.packages).length}`
  );

  for (let i = 0; i < packageCount; i++) {
    const pkg = readBack.packages[`heavy-package-${i}`];
    assert(pkg !== undefined, `Package heavy-package-${i} must be preserved`);
    assert(pkg.tools.length === 1, "Tool must be preserved");
    assert(pkg.tools[0].name === `tool_${i}_alpha`, "Tool name must match");
    assert(
      Object.keys(pkg.tools[0]).length === 1,
      `Tool metadata must be dropped to name-only, got: ${Object.keys(pkg.tools[0]).join(", ")}`
    );
  }

  console.log("  ✓ Oversized cache degrades metadata to names while preserving all packages");
} finally {
  rmSync(testDir6, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 7: Fingerprint includes Pi ABI: changes when ABI changes, stable when not
// -----------------------------------------------------------------------------
console.log("--- Check 7: Fingerprint Pi ABI Inclusion ---");
const testDir7 = join(tmpdir(), `pi-lazy-v032-chk7-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir7, { recursive: true });

try {
  writeFileSync(join(testDir7, "package.json"), JSON.stringify({ name: "abi-test-pkg", version: "2.1.0" }), "utf-8");
  const entryFile = join(testDir7, "entry.js");
  writeFileSync(entryFile, "export default function() {}", "utf-8");

  const fpA1 = computePackageFingerprint(testDir7, [entryFile], "0.84.4");
  const fpA2 = computePackageFingerprint(testDir7, [entryFile], "0.84.4");
  const fpB = computePackageFingerprint(testDir7, [entryFile], "0.85.0");

  assert(fpA1 === fpA2, "Fingerprint must be stable when Pi ABI version does not change");
  assert(fpA1 !== fpB, "Fingerprint must change when Pi ABI version changes");
  assert(fpA1.endsWith(":0.84.4"), "Fingerprint must include the provided Pi ABI version");
  assert(fpB.endsWith(":0.85.0"), "Fingerprint must include the new Pi ABI version");

  const runtimeVersion = getPiRuntimeVersion();
  assert(runtimeVersion === "0.84.4", `Resolved Pi runtime version in this repo must be 0.84.4, got ${runtimeVersion}`);

  const fpRuntime = computePackageFingerprint(testDir7, [entryFile]);
  assert(
    fpRuntime.endsWith(`:${runtimeVersion}`),
    `Default computePackageFingerprint must resolve runtime version (${runtimeVersion})`
  );

  console.log("  ✓ Fingerprint changes when Pi ABI version changes and remains stable when unchanged");
} finally {
  rmSync(testDir7, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 8: registerTool interception records metadata AND reaches underlying API

// -----------------------------------------------------------------------------
// CHECK 9: Symbol-keyed schemas (TypeBox Kind) must NOT trigger degradation
// -----------------------------------------------------------------------------
console.log("--- Check 9: Symbol Keys Are Not Data Loss ---");
{
  const schema: any = { type: "object", properties: { q: { type: "string" } } };
  schema[Symbol.for("TypeBox.Kind")] = "Object";
  const out = sanitizeToolDefinition({ name: "sym_tool", label: "S", description: "d", parameters: schema })!;
  assert(out !== undefined, "symbol-bearing tool must not be dropped");
  assert(out.parameters !== undefined, "symbol-keyed schema must still cache its parameters");
  assert(out.parameters.properties.q.type === "string", "string-keyed schema content must survive");
  assert(out.hasPrepareArguments === false, "symbol-bearing tool is fully harvested");
  console.log("  \u2713 Symbol-keyed schema metadata is cached, not degraded");
}

// -----------------------------------------------------------------------------
// CHECK 10: Genuine serialization losses still degrade to name-only
// -----------------------------------------------------------------------------
console.log("--- Check 10: Genuine Loss Still Degrades ---");
{
  const cyclic: any = { type: "object" };
  cyclic.self = cyclic;
  const cases: Array<[string, any]> = [
    ["fn", { cb: () => 1 }],
    ["undef", { a: undefined }],
    ["nan", { a: NaN }],
    ["infinity", { a: Infinity }],
    ["date", { a: new Date() }],
    ["map", { a: new Map() }],
    ["bigint", { a: BigInt(1) }],
    ["cycle", cyclic],
  ];
  for (const [tag, params] of cases) {
    const out = sanitizeToolDefinition({ name: `loss_${tag}`, label: "L", parameters: params })!;
    assert(Object.keys(out).length === 1, `${tag}: must degrade to name-only, got ${Object.keys(out).join(",")}`);
    assert(!("hasPrepareArguments" in out), `${tag}: degraded entry must not claim a known prepare flag`);
  }
  console.log("  \u2713 Functions, undefined, NaN, Infinity, Date, Map, BigInt and cycles all degrade to name-only");
}

// -----------------------------------------------------------------------------
// CHECK 11: Invalid and empty names are skipped, never minted as "unknown"
// -----------------------------------------------------------------------------
console.log("--- Check 11: Invalid Names Are Skipped ---");
{
  for (const bad of [null, undefined, 42, {}, { name: "" }, { name: "   " }, "", "  "]) {
    assert(sanitizeToolDefinition(bad as any) === undefined, `invalid input must yield undefined: ${JSON.stringify(bad)}`);
  }
  const dir = join(tmpdir(), `pi-lazy-v032-chk11-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    updateCachedPackageTools(dir, "pkg-bad", "1.0.0:1:0.84.4", [{ name: "good" }, { name: "" }, null, 7]);
    const tools = readToolCache(dir).packages["pkg-bad"].tools;
    assert(tools.length === 1 && tools[0].name === "good", `only valid tools cached, got ${JSON.stringify(tools)}`);
    assert(!tools.some((t) => t.name === "unknown"), 'no tool named "unknown" may be minted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  \u2713 Invalid, missing and empty names are skipped without minting placeholders");
}

// -----------------------------------------------------------------------------
// CHECK 12: Duplicate names are last-registration-wins, matching Pi's registry
// -----------------------------------------------------------------------------
console.log("--- Check 12: Duplicate Names Last-Wins ---");
{
  const dir = join(tmpdir(), `pi-lazy-v032-chk12-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    updateCachedPackageTools(dir, "pkg-dup", "1.0.0:1:0.84.4", [
      { name: "dup", description: "first" },
      { name: "dup", description: "second" },
    ]);
    const tools = readToolCache(dir).packages["pkg-dup"].tools;
    assert(tools.length === 1, "duplicates must collapse to one entry");
    assert(tools[0].description === "second", `last registration must win, got "${tools[0].description}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  \u2713 Duplicate tool names keep the last registration, matching Pi's tools.set()");
}

// -----------------------------------------------------------------------------
// CHECK 13: Sort order is code-point stable, not locale dependent
// -----------------------------------------------------------------------------
console.log("--- Check 13: Code-Point Sort Stability ---");
{
  const dir = join(tmpdir(), `pi-lazy-v032-chk13-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    updateCachedPackageTools(dir, "pkg-sort", "1.0.0:1:0.84.4", [
      { name: "b_tool" }, { name: "A_tool" }, { name: "_under" }, { name: "a_tool" },
    ]);
    const names = readToolCache(dir).packages["pkg-sort"].tools.map((t) => t.name);
    const expected = ["A_tool", "_under", "a_tool", "b_tool"];
    assert(JSON.stringify(names) === JSON.stringify(expected), `code-point order expected ${expected}, got ${names}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  \u2713 Tool order is code-point stable across locales");
}

// -----------------------------------------------------------------------------
// CHECK 14: getPiRuntimeVersion resolves by default (no injected ABI)
// -----------------------------------------------------------------------------
console.log("--- Check 14: Default ABI Resolution ---");
{
  const abi = getPiRuntimeVersion();
  assert(typeof abi === "string" && abi.length > 0, "ABI version must be a non-empty string");
  assert(abi !== "unknown", `Pi runtime version must resolve in this repo, got "${abi}"`);
  const dir = join(tmpdir(), `pi-lazy-v032-chk14-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "9.9.9" }), "utf-8");
    const entry = join(dir, "e.js");
    writeFileSync(entry, "export default 1;", "utf-8");
    assert(computePackageFingerprint(dir, [entry]).endsWith(`:${abi}`), "default fingerprint must end with the resolved ABI");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  \u2713 Pi ABI resolves by default and lands in the fingerprint");
}


// -----------------------------------------------------------------------------
// CHECK 15: A names-only cache still over the cap returns false and preserves the old file
// -----------------------------------------------------------------------------
console.log("--- Check 15: Unshrinkable Cache Preserves Previous File ---");
{
  const dir = join(tmpdir(), `pi-lazy-v032-chk15-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const good: ToolCacheData = {
      version: 2,
      packages: { keeper: { fingerprint: "1.0.0:1:0.84.4", tools: [{ name: "kept_tool" }] } },
    };
    assert(writeToolCache(dir, good) === true, "baseline write must succeed");
    const before = readFileSync(join(dir, TOOL_CACHE_FILENAME), "utf-8");

    // Names alone exceed the cap: nothing can be degraded away.
    const huge: ToolCacheData = { version: 2, packages: {} };
    for (let i = 0; i < 400; i++) {
      huge.packages[`pkg-${i}`] = {
        fingerprint: "1.0.0:1:0.84.4",
        tools: Array.from({ length: 20 }, (_, j) => ({ name: `tool_${i}_${j}_${"x".repeat(40)}` })),
      };
    }
    assert(writeToolCache(dir, huge) === false, "unshrinkable cache must report failure");
    const after = readFileSync(join(dir, TOOL_CACHE_FILENAME), "utf-8");
    assert(after === before, "previous cache file must be left untouched when the write is refused");
    assert(readToolCache(dir).packages.keeper !== undefined, "previous cache must remain readable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  \u2713 Oversized-beyond-degradation write is refused and the prior cache survives");
}


// -----------------------------------------------------------------------------
// CHECK 16: Subtle JSON round-trip losses are detected
// -----------------------------------------------------------------------------
console.log("--- Check 16: Subtle Round-Trip Losses ---");
{
  const sparse: any[] = [1];
  sparse[2] = 3; // hole at index 1, serializes as null
  const withCustomProp: any = [1, 2];
  withCustomProp.extra = "dropped by JSON.stringify";
  const withToJson: any = { type: "object" };
  Object.defineProperty(withToJson, "toJSON", { value: () => ({ type: "mutated" }), enumerable: false });

  const subtle: Array<[string, any]> = [
    ["negative_zero", { a: -0 }],
    ["sparse_array", { a: sparse }],
    ["array_custom_prop", { a: withCustomProp }],
    ["to_json", { a: withToJson }],
  ];
  for (const [tag, params] of subtle) {
    assert(isJsonLossless(params) === false, `${tag}: must be reported as lossy`);
    const out = sanitizeToolDefinition({ name: `subtle_${tag}`, label: "L", parameters: params })!;
    assert(Object.keys(out).length === 1, `${tag}: must degrade to name-only, got ${Object.keys(out).join(",")}`);
  }

  // Positive control: ordinary JSON data, and symbol keys, remain lossless.
  const okSchema: any = { type: "object", properties: { q: { type: "string" } }, list: [1, "a", true, null] };
  okSchema[Symbol.for("TypeBox.Kind")] = "Object";
  assert(isJsonLossless(okSchema) === true, "plain JSON data with symbol keys must remain lossless");
  console.log("  \u2713 -0, sparse arrays, custom array properties and toJSON are all caught");
}

// -----------------------------------------------------------------------------
console.log("--- Check 8: registerTool Interception & Underlying Forwarding ---");
const testDir8 = join(tmpdir(), `pi-lazy-v032-chk8-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir8, { recursive: true });

try {
  const pkgDir = join(testDir8, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-mcp-adapter", version: "1.0.0", type: "module", pi: { extensions: ["./index.js"] } }),
    "utf-8"
  );
  writeFileSync(
    join(pkgDir, "index.js"),
    `
    export default function (pi) {
      pi.registerTool({
        name: "harvested_rich_tool",
        label: "Harvested Rich Tool",
        description: "Captures full tool metadata in v0.3.2",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
        promptSnippet: "Execute harvested rich tool",
        promptGuidelines: ["Always pass input string"],
        executionMode: "parallel",
        prepareArguments: (args) => ({ ...args, prepared: true }),
        execute: async (toolCallId, params) => ({ content: [{ type: "text", text: "done" }] }),
      });
    }
    `,
    "utf-8"
  );

  const underlyingRegistered: any[] = [];
  const mockPi: any = {
    registerTool(tool: any) {
      underlyingRegistered.push(tool);
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    on() {},
  };

  const loader = new LazyLoader(mockPi, testDir8, false);
  const loadResult = await loader.loadPackage("pi-mcp-adapter");

  assert(loadResult.success === true, `loadPackage must succeed: ${loadResult.error}`);
  assert(loadResult.newTools.includes("harvested_rich_tool"), "loadResult.newTools must include tool name");

  // Verify real registration reached underlying API
  assert(underlyingRegistered.length === 1, "Underlying ExtensionAPI must receive registration");
  const underlying = underlyingRegistered[0];
  assert(underlying.name === "harvested_rich_tool", "Underlying tool name must match");
  assert(typeof underlying.execute === "function", "Underlying registration must retain execute function");
  assert(typeof underlying.prepareArguments === "function", "Underlying registration must retain prepareArguments function");

  // Verify cached metadata written to disk
  const cache = readToolCache(testDir8);
  assert(cache.packages["pi-mcp-adapter"] !== undefined, "pi-mcp-adapter must be cached");
  const cachedTool = cache.packages["pi-mcp-adapter"].tools[0];

  assert(cachedTool.name === "harvested_rich_tool", "Cached tool name must match");
  assert(cachedTool.label === "Harvested Rich Tool", "Cached tool label must match");
  assert(cachedTool.description === "Captures full tool metadata in v0.3.2", "Cached tool description must match");
  assert(
    JSON.stringify(cachedTool.parameters) ===
      JSON.stringify({
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      }),
    "Cached tool parameters must match"
  );
  assert(cachedTool.promptSnippet === "Execute harvested rich tool", "Cached promptSnippet must match");
  assert(
    JSON.stringify(cachedTool.promptGuidelines) === JSON.stringify(["Always pass input string"]),
    "Cached promptGuidelines must match"
  );
  assert(cachedTool.executionMode === "parallel", "Cached executionMode must match");
  assert(cachedTool.hasPrepareArguments === true, "Cached hasPrepareArguments must be true");
  assert(!("prepareArguments" in cachedTool), "prepareArguments function must NOT be cached");
  assert(!("execute" in cachedTool), "execute function must NOT be cached");

  console.log("  ✓ registerTool interception captures metadata and passes real tool through");
} finally {
  rmSync(testDir8, { recursive: true, force: true });
}

console.log("\n==============================================");
console.log("ALL v0.3.2 CHECKS COMPLETED AND PASSED");
console.log("==============================================");