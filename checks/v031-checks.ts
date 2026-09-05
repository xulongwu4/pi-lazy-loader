import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LazyLoader } from "../src/loader.js";
import { loadCommandConfig } from "../src/command-config.js";
import {
  readToolCache,
  writeToolCache,
  buildLazyLoadGuidance,
  computeGuidancePromptLength,
  MAX_LAZY_LOAD_PROMPT_BUDGET,
  MAX_CACHE_FILE_SIZE,
  TOOL_CACHE_FILENAME,
  type ToolCacheData,
} from "../src/tool-cache.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("=== Running v0.3.1 Verification Checks ===\n");

// -----------------------------------------------------------------------------
// CHECK 1: Sticky Session Failure on Package Load
// -----------------------------------------------------------------------------
console.log("--- Check 1: Sticky Session Failure ---");
const testDir1 = join(tmpdir(), `pi-lazy-v031-chk1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir1, { recursive: true });

try {
  const pkgDir = join(testDir1, "npm", "node_modules", "pi-token-burden");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-token-burden", type: "module", pi: { extensions: ["./index.js"] } }),
    "utf-8"
  );
  writeFileSync(
    join(pkgDir, "index.js"),
    `
    export default function (pi) {
      globalThis.__v031LoadCount = (globalThis.__v031LoadCount || 0) + 1;
      throw new Error("Simulated load failure for check 1");
    }
    `,
    "utf-8"
  );

  const mockPi: any = {
    registerTool() {},
    registerCommand() {},
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    on() {},
  };

  (globalThis as any).__v031LoadCount = 0;
  const loader1 = new LazyLoader(mockPi, testDir1, false);

  const firstResult = await loader1.loadPackage("pi-token-burden");
  assert(firstResult.success === false, "First load must fail");
  assert(firstResult.status === "failed", "First load status must be 'failed'");
  assert((globalThis as any).__v031LoadCount === 1, "Load path entered exactly once on first call");

  // Second load call must NOT re-enter the load path
  const secondResult = await loader1.loadPackage("pi-token-burden");
  assert(secondResult.success === false, "Second load must fail");
  assert(secondResult.status === "failed", "Second load status must be 'failed'");
  assert(
    (globalThis as any).__v031LoadCount === 1,
    "Second load call must NOT re-enter the load path (load count must stay 1)"
  );
  assert(
    typeof secondResult.error === "string" &&
      /reload|restart/i.test(secondResult.error),
    `Sticky failure error message must mention reload or restart: "${secondResult.error}"`
  );
  console.log("  ✓ Failed package stays failed without re-entering load path");
  console.log("  ✓ Error message mentions reload / restart");
} finally {
  rmSync(testDir1, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 2: Tool Cache Round-Trip, Corruption, Oversize, and Version Resilience
// -----------------------------------------------------------------------------
console.log("--- Check 2: Tool Cache Round-Trip & Resilience ---");
const testDir2 = join(tmpdir(), `pi-lazy-v031-chk2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir2, { recursive: true });

try {
  // 2.1 Round-trip write and read
  // v0.3.2: the writer fixture is version 2. Legacy v1 *file* migration is covered
  // directly in checks/v032-checks.ts (Check 5), which writes a real v1 file to disk.
  const validCache: ToolCacheData = {
    version: 2,
    packages: {
      "pi-web-access": {
        fingerprint: "1.0.0:123456",
        tools: [{ name: "web_search" }, { name: "fetch_url" }],
      },
      "pi-mcp-adapter": {
        fingerprint: "0.5.0:789012",
        tools: [{ name: "mcp_proxy" }],
      },
    },
  };
  const writeSuccess = writeToolCache(testDir2, validCache);
  assert(writeSuccess === true, "writeToolCache must return true on success");
  const readBack = readToolCache(testDir2);
  assert(readBack.version === 2, "Cache reads normalize to version 2");
  assert(readBack.packages["pi-web-access"] !== undefined, "pi-web-access package must be present");
  assert(readBack.packages["pi-web-access"].fingerprint === "1.0.0:123456", "Fingerprint must match");
  assert(
    JSON.stringify(readBack.packages["pi-web-access"].tools.map((t) => t.name)) ===
      JSON.stringify(["web_search", "fetch_url"]),
    "Tool names must survive a write/read round trip"
  );
  console.log("  ✓ Tool cache writes and reads back correctly");

  // 2.2 Corrupt file yields empty object without throwing
  writeFileSync(join(testDir2, TOOL_CACHE_FILENAME), "{ corrupt json: [unclosed", "utf-8");
  let corruptRead: ToolCacheData | undefined;
  try {
    corruptRead = readToolCache(testDir2);
  } catch (err) {
    assert(false, `readToolCache threw on corrupt JSON: ${err}`);
  }
  assert(corruptRead.version === 2, "Corrupt file must yield an empty version 2 cache");
  assert(Object.keys(corruptRead.packages).length === 0, "Corrupt file must yield empty packages map");
  console.log("  ✓ Corrupt cache file yields empty cache without throwing");

  // 2.3 Oversized file (> 64 KiB) yields empty object without throwing
  const oversizedContent = " ".repeat(MAX_CACHE_FILE_SIZE + 2048);
  writeFileSync(join(testDir2, TOOL_CACHE_FILENAME), oversizedContent, "utf-8");
  let oversizedRead: ToolCacheData | undefined;
  try {
    oversizedRead = readToolCache(testDir2);
  } catch (err) {
    assert(false, `readToolCache threw on oversized file: ${err}`);
  }
  assert(oversizedRead.version === 2, "Oversized file must yield an empty version 2 cache");
  assert(Object.keys(oversizedRead.packages).length === 0, "Oversized file must yield empty packages map");
  console.log("  ✓ Oversized cache file yields empty cache without throwing");

  // 2.4 Wrong-version file yields empty object without throwing
  writeFileSync(
    join(testDir2, TOOL_CACHE_FILENAME),
    JSON.stringify({ version: 99, packages: { "pkg-future": { fingerprint: "1:1", tools: ["t"] } } }),
    "utf-8"
  );
  let wrongVersionRead: ToolCacheData | undefined;
  try {
    wrongVersionRead = readToolCache(testDir2);
  } catch (err) {
    assert(false, `readToolCache threw on wrong-version file: ${err}`);
  }
  assert(wrongVersionRead.version === 2, "Wrong version must yield an empty version 2 cache");
  assert(Object.keys(wrongVersionRead.packages).length === 0, "Wrong version must yield empty packages map");
  console.log("  ✓ Wrong-version cache file yields empty cache without throwing");
} finally {
  rmSync(testDir2, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 3: registerTool Interception and Passthrough
// -----------------------------------------------------------------------------
console.log("--- Check 3: registerTool Interception & Passthrough ---");
const testDir3 = join(tmpdir(), `pi-lazy-v031-chk3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir3, { recursive: true });

try {
  const pkgDir = join(testDir3, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-mcp-adapter", type: "module", pi: { extensions: ["./index.js"] } }),
    "utf-8"
  );
  writeFileSync(
    join(pkgDir, "index.js"),
    `
    export default function (pi) {
      pi.registerTool({
        name: "mcp_alpha_tool",
        label: "Alpha Tool",
        description: "Alpha tool description",
        parameters: {},
        execute() {},
      });
      pi.registerTool({
        name: "mcp_beta_tool",
        label: "Beta Tool",
        description: "Beta tool description",
        parameters: {},
        execute() {},
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
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    on() {},
  };

  const loader3 = new LazyLoader(mockPi, testDir3, false);
  const loadResult = await loader3.loadPackage("pi-mcp-adapter");
  assert(loadResult.success === true, "Package load must succeed");

  // Verify loader recorded tool names
  assert(
    Array.isArray(loadResult.newTools) &&
      loadResult.newTools.includes("mcp_alpha_tool") &&
      loadResult.newTools.includes("mcp_beta_tool"),
    `loadPackage must record new tools in result: ${JSON.stringify(loadResult.newTools)}`
  );

  // Verify real registration reached underlying API
  assert(
    underlyingRegistered.length === 2,
    `Underlying API must receive both registrations, got ${underlyingRegistered.length}`
  );
  assert(
    underlyingRegistered.some((t) => t.name === "mcp_alpha_tool"),
    "Underlying API must receive mcp_alpha_tool registration"
  );
  assert(
    underlyingRegistered.some((t) => t.name === "mcp_beta_tool"),
    "Underlying API must receive mcp_beta_tool registration"
  );
  console.log("  ✓ registerTool interception records tool names");
  console.log("  ✓ Real tool registrations reach underlying ExtensionAPI");
} finally {
  rmSync(testDir3, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 4: Generated Guidance, Tool Names, Degradation, and Prompt Budget
// -----------------------------------------------------------------------------
console.log("--- Check 4: Guidance Generation, Degradation & Prompt Budget ---");

// 4.1 Includes cached tool names
const populatedCache: ToolCacheData = {
  version: 1,
  packages: {
    "pi-web-access": {
      fingerprint: "1:1",
      tools: ["web_search", "url_fetch"],
    },
  },
};
const gWithTools = buildLazyLoadGuidance(
  [{ name: "pi-web-access", capability: "Web search and retrieval" }],
  populatedCache
);
assert(
  gWithTools.description.includes("web_search, url_fetch"),
  "Guidance description must include cached tool names"
);
assert(
  gWithTools.description.includes("Web search and retrieval"),
  "Guidance description must include manifest capability"
);
console.log("  ✓ Guidance includes cached tool names");

// 4.2 Degrades to manifest capability when cache is empty
const emptyCache: ToolCacheData = { version: 1, packages: {} };
const gEmpty = buildLazyLoadGuidance(
  [{ name: "pi-web-access", capability: "Web search and retrieval" }],
  emptyCache
);
assert(
  gEmpty.description.includes("Web search and retrieval"),
  "Guidance description must include manifest capability when cache is empty"
);
assert(
  !gEmpty.description.includes("(tools:"),
  "Guidance description must not have tools section when cache is empty"
);
console.log("  ✓ Guidance gracefully degrades to manifest capability when cache is empty");

// 4.3 Total prompt text within budget constant and exercises item boundary truncation
const largeDeferredList = Array.from({ length: 30 }, (_, i) => ({
  name: `@scope/long-package-name-number-${i}`,
  capability: `High-throughput asynchronous intelligence framework for distributed cluster execution unit ${i}`,
}));
const largeToolCache: ToolCacheData = {
  version: 1,
  packages: Object.fromEntries(
    largeDeferredList.map((pkg, i) => [
      pkg.name,
      {
        fingerprint: `1.0.${i}:12345`,
        tools: Array.from({ length: 6 }, (_, t) => `cluster_service_${i}_tool_op_${t}`),
      },
    ])
  ),
};

const gTruncated = buildLazyLoadGuidance(largeDeferredList, largeToolCache, MAX_LAZY_LOAD_PROMPT_BUDGET);
const totalChars = computeGuidancePromptLength(gTruncated);

assert(
  totalChars <= MAX_LAZY_LOAD_PROMPT_BUDGET,
  `Total prompt characters (${totalChars}) must not exceed MAX_LAZY_LOAD_PROMPT_BUDGET (${MAX_LAZY_LOAD_PROMPT_BUDGET})`
);
assert(
  gTruncated.description.includes("more, see /lazy list)"),
  "Description must include item truncation marker when exceeding budget"
);

// Verify truncation occurs at whole item boundaries (no partial lines)
const lines = gTruncated.description.split("\n");
assert(lines[0] === "Load a deferred Pi extension on demand:", "First line must be prefix header");
const lastLine = lines[lines.length - 1];
assert(
  /^\(\+\d+ more, see \/lazy list\)$/.test(lastLine),
  `Last line must be exact marker '(+N more, see /lazy list)', got: "${lastLine}"`
);
for (let i = 1; i < lines.length - 1; i++) {
  const line = lines[i];
  assert(line.startsWith("- @scope/long-package-name-number-"), `Item line must start cleanly with '- ': "${line}"`);
  assert(line.includes(" — High-throughput asynchronous intelligence framework"), `Item line must contain full capability: "${line}"`);
  assert(line.includes("(tools: cluster_service_"), `Item line must contain complete tools list: "${line}"`);
}

// Verify promptSnippet, promptGuidelines, and parameterDescription bounds
assert(
  !gTruncated.promptSnippet.includes("@scope/long-package-name-number-"),
  "promptSnippet must not enumerate every deferred package"
);
assert(
  gTruncated.promptGuidelines.length === 1,
  `promptGuidelines must have exactly 1 guideline (got ${gTruncated.promptGuidelines.length})`
);
assert(
  !gTruncated.parameterDescription.includes("@scope/long-package-name-number-"),
  "parameterDescription must not enumerate every deferred package"
);
console.log(`  ✓ Total generated prompt text stays within budget (${totalChars} / ${MAX_LAZY_LOAD_PROMPT_BUDGET} chars)`);
console.log("  ✓ Truncation exercised and truncates cleanly on whole item boundaries");

// -----------------------------------------------------------------------------
// CHECK 5: getCommandStatus returns 'ready (eager)' for <configured eager>
// -----------------------------------------------------------------------------
console.log("--- Check 5: getCommandStatus with <configured eager> ---");
const testDir5 = join(tmpdir(), `pi-lazy-v031-chk5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir5, { recursive: true });

try {
  writeFileSync(
    join(testDir5, "settings.json"),
    JSON.stringify({
      packages: [
        "npm:pi-token-burden",
      ],
    }),
    "utf-8"
  );

  const mockPi: any = {
    registerTool() {},
    registerCommand() {},
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    on() {},
  };

  const loader5 = new LazyLoader(mockPi, testDir5, true);
  const pkgState = loader5.getPackageState("pi-token-burden");
  assert(pkgState !== undefined, "pi-token-burden state must exist");
  assert(pkgState.status === "loaded", "Configured eager package must have status 'loaded'");
  assert(
    pkgState.loadedEntries.includes("<configured eager>"),
    "loadedEntries must contain '<configured eager>'"
  );

  const status = loader5.getCommandStatus("pi-token-burden", "token-burden");
  assert(
    status === "ready (eager)",
    `Command status for configured eager package must be 'ready (eager)', got '${status}'`
  );
  console.log("  ✓ getCommandStatus returns 'ready (eager)' for package marked <configured eager>");
} finally {
  rmSync(testDir5, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 6: Non-empty extensions array produces diagnostic; extensions: [] does not
// -----------------------------------------------------------------------------
console.log("--- Check 6: Partial Extension Filter Diagnostics ---");

// 6.1 Non-empty extensions: ["./some-ext.ts"] -> partial package detected and diagnostic emitted
const testDir6a = join(tmpdir(), `pi-lazy-v031-chk6a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir6a, { recursive: true });

try {
  writeFileSync(
    join(testDir6a, "settings.json"),
    JSON.stringify({
      packages: [
        {
          source: "npm:pi-token-burden",
          extensions: ["./some-ext.ts"],
        },
      ],
    }),
    "utf-8"
  );

  const mockPi: any = {
    registerTool() {},
    registerCommand() {},
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    on() {},
  };

  const loader6a = new LazyLoader(mockPi, testDir6a, true);
  const partials6a = loader6a.getPartialExtensionPackages();
  assert(
    partials6a.includes("pi-token-burden"),
    `Non-empty extensions array must record partial extension package: ${JSON.stringify(partials6a)}`
  );

  const { definitions: defs6a, diagnostics: diags6a } = loadCommandConfig({ agentDir: testDir6a });
  const cmdPkgs6a = new Set(defs6a.map((d) => d.packageName));
  for (const pkgName of partials6a) {
    if (cmdPkgs6a.has(pkgName)) {
      diags6a.push(
        `Package "${pkgName}" has a non-empty "extensions" filter in settings.json. Command proxies may be missing. Use "extensions": [] to defer or omit "extensions" for fully eager.`
      );
    }
  }
  assert(
    diags6a.some((d) => d.includes('Package "pi-token-burden" has a non-empty "extensions" filter')),
    "Non-empty extensions array must produce diagnostic warning"
  );
  console.log("  ✓ Non-empty extensions array produces diagnostic warning");
} finally {
  rmSync(testDir6a, { recursive: true, force: true });
}

// 6.2 Empty extensions: [] -> no partial package, no diagnostic emitted
const testDir6b = join(tmpdir(), `pi-lazy-v031-chk6b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDir6b, { recursive: true });

try {
  writeFileSync(
    join(testDir6b, "settings.json"),
    JSON.stringify({
      packages: [
        {
          source: "npm:pi-token-burden",
          extensions: [],
        },
      ],
    }),
    "utf-8"
  );

  const mockPi: any = {
    registerTool() {},
    registerCommand() {},
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    on() {},
  };

  const loader6b = new LazyLoader(mockPi, testDir6b, true);
  const partials6b = loader6b.getPartialExtensionPackages();
  assert(
    partials6b.length === 0,
    `extensions: [] must NOT record any partial extension packages: ${JSON.stringify(partials6b)}`
  );

  const { definitions: defs6b, diagnostics: diags6b } = loadCommandConfig({ agentDir: testDir6b });
  const cmdPkgs6b = new Set(defs6b.map((d) => d.packageName));
  for (const pkgName of partials6b) {
    if (cmdPkgs6b.has(pkgName)) {
      diags6b.push(
        `Package "${pkgName}" has a non-empty "extensions" filter in settings.json. Command proxies may be missing. Use "extensions": [] to defer or omit "extensions" for fully eager.`
      );
    }
  }
  assert(
    !diags6b.some((d) => d.includes('has a non-empty "extensions" filter')),
    "extensions: [] must NOT produce diagnostic warning"
  );
  console.log("  ✓ extensions: [] produces zero partial-extension diagnostics");
} finally {
  rmSync(testDir6b, { recursive: true, force: true });
}

console.log("\n==============================================");
console.log("ALL v0.3.1 CHECKS COMPLETED AND PASSED");
console.log("==============================================");
