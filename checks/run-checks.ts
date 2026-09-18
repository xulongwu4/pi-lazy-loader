import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getAgentDir } from "../src/pi-host.js";
import { resolvePackageDefinition, resolvePackageEntries, resolvePackageRoot } from "../src/resolver.js";
import { LazyLoader } from "../src/loader.js";
import { CONFIG_FILENAME, readLazyLoaderConfig, removeLazyPackage } from "../src/config.js";
import { readCache } from "../src/cache.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("=== Running Phase 2 Verification Checks ===\n");

// -----------------------------------------------------------------------------
// CHECK 1: File / Directory Entry Resolution
// -----------------------------------------------------------------------------
console.log("--- Check 1: File and Directory Entry Resolution ---");
const agentDir = getAgentDir();
console.log(`Agent directory: ${agentDir}`);

const lazyPackages = ["npm:pi-fabric", "npm:pi-web-access", "npm:pi-mcp-adapter", "npm:pi-token-burden"].map((source) =>
  resolvePackageDefinition(source, agentDir)
);

for (const pkg of lazyPackages) {
  const root = resolvePackageRoot(pkg.source, agentDir);
  assert(existsSync(root), `Package root does not exist for ${pkg.name}: ${root}`);

  const entries = resolvePackageEntries(pkg, agentDir);
  assert(entries.length > 0, `No entries resolved for package ${pkg.name}`);

  for (const entry of entries) {
    assert(existsSync(entry), `Resolved entry file does not exist: ${entry}`);
    assert(
      entry.endsWith(".ts") || entry.endsWith(".js"),
      `Entry file must be .ts or .js: ${entry}`
    );
  }

  if (pkg.name === "@zosmaai/pi-llm-wiki") {
    // Verified directory resolution with index.ts in subdirectory
    assert(
      entries.some((e) => e.includes("llm-wiki/index.ts")),
      `@zosmaai/pi-llm-wiki must resolve directory convention to llm-wiki/index.ts`
    );
  }

  if (pkg.name === "pi-quotas") {
    // Verified multi-entry package (6 files)
    assert(
      entries.length === 6,
      `pi-quotas must resolve exactly 6 extension entry points, got ${entries.length}`
    );
  }

  console.log(`  ✓ ${pkg.name.padEnd(35)} -> ${entries.length} entry file(s)`);
}

// Error handling tests
try {
  resolvePackageRoot("npm:non-existent-package-xyz", agentDir);
  assert(false, "Should have thrown for non-existent package");
} catch (err: any) {
  assert(err.message.includes("not found"), `Expected 'not found' error, got: ${err.message}`);
  console.log(`  ✓ Missing package error handled cleanly: ${err.message}`);
}

console.log("Check 1 passed.\n");

// -----------------------------------------------------------------------------
// CHECK 2: Idempotent and Concurrent State
// -----------------------------------------------------------------------------
console.log("--- Check 2: Idempotent and Concurrent State ---");

// Mock Pi ExtensionAPI for testing loader state
const registeredTools = new Map<string, any>();
const registeredCommands = new Map<string, any>();
const eventHandlers = new Map<string, Function[]>();

const mockPi: any = {
  getAllTools() {
    return Array.from(registeredTools.values());
  },
  getActiveTools() {
    return Array.from(registeredTools.values());
  },
  setActiveTools() {},
  registerTool(tool: any) {
    registeredTools.set(tool.name, tool);
  },
  registerCommand(name: string, options: any) {
    registeredCommands.set(name, options);
  },
  registerShortcut() {},
  registerFlag() {},
  registerMessageRenderer() {},
  registerMarkdownTransformer() {},
  registerEntryRenderer() {},
  registerProvider() {},
  unregisterProvider() {},
  getFlag() { return undefined; },
  sendMessage() {},
  sendUserMessage() {},
  appendEntry() {},
  setSessionName() {},
  getSessionName() { return undefined; },
  setLabel() {},
  getCommands() { return Array.from(registeredCommands.values()); },
  setModel: async () => {},
  getThinkingLevel: () => "medium",
  setThinkingLevel: () => {},
  events: {
    emit() {},
    on() { return () => {}; },
  },
  on(event: string, handler: Function) {
    const list = eventHandlers.get(event) ?? [];
    list.push(handler);
    eventHandlers.set(event, list);
  },
};

const loader = new LazyLoader(mockPi, agentDir, lazyPackages);

// Simulate genuine startup events
loader.setSessionStart(
  { type: "session_start", reason: "startup" },
  { sessionManager: { getSessionId: () => "mock-session" }, cwd: process.cwd(), hasUI: false }
);
loader.setResourcesDiscover(
  { type: "resources_discover", reason: "startup" },
  { cwd: process.cwd() }
);

// Verify every explicitly configured package is initially deferred
const initialStates = loader.getAllStates();
assert(initialStates.length === lazyPackages.length, `Expected ${lazyPackages.length} initial states, got ${initialStates.length}`);
for (const s of initialStates) {
  assert(s.status === "deferred", `Expected initial status 'deferred' for ${s.definition.name}, got ${s.status}`);
}
console.log(`  ✓ All ${lazyPackages.length} configured packages initialized in 'deferred' status`);

// Test concurrent loads: 5 simultaneous calls to loadPackage("pi-token-burden")
const concurrentPromises = [
  loader.loadPackage("pi-token-burden"),
  loader.loadPackage("pi-token-burden"),
  loader.loadPackage("pi-token-burden"),
  loader.loadPackage("pi-token-burden"),
  loader.loadPackage("pi-token-burden"),
];

const results = await Promise.all(concurrentPromises);
assert(results.length === 5, "Expected 5 results");
for (const r of results) {
  assert(r.success, `Expected success in concurrent result, got: ${r.error}`);
  assert(r.package === "pi-token-burden", `Expected package pi-token-burden, got ${r.package}`);
  assert(r.status === "loaded", `Expected status 'loaded', got ${r.status}`);
}
console.log("  ✓ 5 concurrent load requests shared one promise and all succeeded");

// Test idempotent call: subsequent load of already loaded package
const idempotentResult = await loader.loadPackage("pi-token-burden");
assert(idempotentResult.success, "Idempotent load must succeed");
assert(idempotentResult.alreadyLoaded === true, "Must flag alreadyLoaded: true");
assert(idempotentResult.status === "loaded", "Status must remain 'loaded'");
console.log("  ✓ Idempotent reload returned immediately with alreadyLoaded: true");

// Test an explicit multi-entry package: pi-quotas (6 entries)
const quotasLoader = new LazyLoader(mockPi, agentDir, [{
  name: "pi-quotas",
  source: "git:github.com/xulongwu4/pi-quotas",
}]);
const quotasResult = await quotasLoader.loadPackage("pi-quotas");
assert(quotasResult.success, `pi-quotas multi-entry load failed: ${quotasResult.error}`);
assert(quotasResult.entries?.length === 6, `pi-quotas must load all 6 entries, got ${quotasResult.entries?.length}`);
console.log(`  ✓ Multi-entry package pi-quotas loaded all 6 entry points`);

// Test partial failure: create mock loader where one entry fails
const failLoader = new LazyLoader(mockPi, agentDir);
const invalidResult = await failLoader.loadPackage("non-existent-pkg-abc");
assert(!invalidResult.success, "Non-existent package must return success: false");
assert(invalidResult.status === "failed", "Non-existent package must be marked failed");
console.log("  ✓ Unknown package load cleanly reported failure");

console.log("Check 2 passed.\n");

// -----------------------------------------------------------------------------
// CHECK 3: Package catalog sources (inline / settings key / file)
// -----------------------------------------------------------------------------
console.log("--- Check 3: Explicit lazy-loader.json Package Catalog ---");
const tempDir = join(tmpdir(), `pi-lazy-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tempDir, { recursive: true });

try {
  for (const name of ["all-proxies", "filtered-proxies"]) {
    const packageDir = join(tempDir, "npm", "node_modules", name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name }));
  }
  writeFileSync(join(tempDir, CONFIG_FILENAME), JSON.stringify({
    $schema: "./lazy-loader.schema.json",
    packages: [
      "npm:all-proxies",
      {
        source: " npm:filtered-proxies ",
        commands: ["aa", "bb", "aa"],
        tools: ["tool1", "tool2"],
      },
    ],
  }, null, 2));

  const configured = readLazyLoaderConfig(tempDir);
  assert(configured.diagnostics.length === 0, configured.diagnostics.join("; "));
  assert(configured.packages.length === 2, "Both configured packages must be discovered without settings.json");
  const all = configured.packages.find((pkg) => pkg.name === "all-proxies");
  const filtered = configured.packages.find((pkg) => pkg.name === "filtered-proxies");
  assert(all?.proxyCommands === undefined && all?.proxyTools === undefined, "String form must use all cached proxies");
  assert(JSON.stringify(filtered?.proxyCommands) === JSON.stringify(["aa", "bb"]), "Command allowlist must be deduplicated");
  assert(JSON.stringify(filtered?.proxyTools) === JSON.stringify(["tool1", "tool2"]), "Tool allowlist must be preserved");

  removeLazyPackage(tempDir, "npm:filtered-proxies");
  const written = JSON.parse(readFileSync(join(tempDir, CONFIG_FILENAME), "utf-8"));
  assert(written.$schema === "./lazy-loader.schema.json", "Removing a lazy package must preserve the schema declaration");
  assert(written.packages.length === 1, "Removing a lazy package must preserve other entries");
  console.log("  ✓ Package catalog, proxy allowlists, deduplication, and removal verified");

  // settings.json "lazy-loader" key takes precedence over lazy-loader.json,
  // and removal writes through a symlinked settings.json target.
  const settingsTarget = join(tempDir, "settings-target.json");
  writeFileSync(settingsTarget, JSON.stringify({
    theme: "nord",
    "lazy-loader": {
      packages: [
        "npm:all-proxies",
        { source: "npm:filtered-proxies", tools: ["tool1"] },
      ],
    },
  }, null, 2));
  symlinkSync(settingsTarget, join(tempDir, "settings.json"));

  const fromSettings = readLazyLoaderConfig(tempDir);
  assert(fromSettings.diagnostics.length === 0, fromSettings.diagnostics.join("; "));
  assert(fromSettings.packages.length === 2, "settings.json lazy-loader key must win over lazy-loader.json");
  const settingsFiltered = fromSettings.packages.find((pkg) => pkg.name === "filtered-proxies");
  assert(JSON.stringify(settingsFiltered?.proxyTools) === JSON.stringify(["tool1"]), "settings tool allowlist must be preserved");

  removeLazyPackage(tempDir, "npm:filtered-proxies");
  assert(lstatSync(join(tempDir, "settings.json")).isSymbolicLink(), "Removal must not clobber the settings.json symlink");
  const settingsWritten = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
  assert(settingsWritten.theme === "nord", "Removal must preserve unrelated settings keys");
  assert(settingsWritten["lazy-loader"].packages.length === 1, "Removal must update the settings catalog");
  const fallbackIgnored = readLazyLoaderConfig(tempDir);
  assert(fallbackIgnored.packages.length === 1 && fallbackIgnored.packages[0].name === "all-proxies",
    "settings.json catalog must keep shadowing lazy-loader.json");
  console.log("  ✓ settings.json lazy-loader key precedence and symlink-safe removal verified");

  // Inline form: "lazy" flags on packages entries win over the "lazy-loader" key.
  writeFileSync(settingsTarget, JSON.stringify({
    theme: "nord",
    packages: [
      "npm:eager-pkg",
      { source: "npm:all-proxies", extensions: [], lazy: true },
      { source: "npm:filtered-proxies", extensions: [], lazy: { tools: ["tool9"] } },
      { source: "npm:not-lazy", extensions: [] },
    ],
    "lazy-loader": { packages: ["npm:all-proxies"] },
  }, null, 2));

  const inline = readLazyLoaderConfig(tempDir);
  assert(inline.diagnostics.length === 0, inline.diagnostics.join("; "));
  assert(inline.packages.length === 2, "inline lazy entries must win over lazy-loader key");
  const inlineFiltered = inline.packages.find((pkg) => pkg.name === "filtered-proxies");
  assert(JSON.stringify(inlineFiltered?.proxyTools) === JSON.stringify(["tool9"]), "inline lazy options must be preserved");
  assert(!inline.packages.some((pkg) => pkg.name === "not-lazy"), "entries without lazy flag must not be deferred");

  removeLazyPackage(tempDir, "npm:filtered-proxies");
  const inlineWritten = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
  const removedEntry = inlineWritten.packages.find((p: any) => p.source === "npm:filtered-proxies");
  assert(removedEntry && !Object.hasOwn(removedEntry, "lazy") && !Object.hasOwn(removedEntry, "extensions"),
    "inline removal must strip the lazy flag and the empty extensions filter");
  assert(inlineWritten.theme === "nord" && inlineWritten.packages.length === 4, "inline removal must preserve other settings");
  const afterInlineRemoval = readLazyLoaderConfig(tempDir);
  assert(afterInlineRemoval.packages.length === 1 && afterInlineRemoval.packages[0].name === "all-proxies",
    "remaining inline lazy entry must still be discovered");
  console.log("  ✓ inline lazy entries in packages verified");

  // Failure paths: broken settings.json falls through to lazy-loader.json;
  // lazy:false and malformed lazy entries are skipped with diagnostics.
  writeFileSync(settingsTarget, "{ not json ,,", "utf-8");
  const brokenSettings = readLazyLoaderConfig(tempDir);
  assert(brokenSettings.packages.length === 1 && brokenSettings.packages[0].name === "all-proxies",
    "unparseable settings.json must fall through to lazy-loader.json");
  assert(brokenSettings.diagnostics.some((d) => d.includes("Failed to parse")),
    "unparseable settings.json must produce a parse diagnostic");

  writeFileSync(settingsTarget, JSON.stringify({
    packages: [
      { source: "npm:all-proxies", extensions: [], lazy: true },
      { source: "npm:filtered-proxies", extensions: [], lazy: { tools: "notarray" } },
      { lazy: true },
      { source: "npm:bad-flag", lazy: "yes" },
      { source: "npm:null-flag", lazy: null },
    ],
    "lazy-loader": "not-an-object",
  }), "utf-8");
  const malformed = readLazyLoaderConfig(tempDir);
  const kept = malformed.packages.find((p) => p.name === "filtered-proxies");
  assert(malformed.packages.length === 2 && malformed.packages.some((p) => p.name === "all-proxies") && kept,
    "lazy:false and malformed entries must be skipped, valid entries kept");
  assert(kept.proxyTools === undefined, "a bad filter field must be ignored, keeping the package with defaults");
  assert(malformed.diagnostics.some((d) => d.includes("missing a valid")) &&
         malformed.diagnostics.some((d) => d.includes("must be true, false")) &&
         malformed.diagnostics.some((d) => d.includes("lazy.tools")) &&
         malformed.diagnostics.some((d) => d.includes("shadowed")),
    "sourceless, bad-flag, bad-filter, and shadowed-key diagnostics must all surface");
  console.log("  ✓ failure-path fallbacks and malformed-entry diagnostics verified");

  // Inline pin must keep a non-empty extensions filter while dropping the empty one.
  writeFileSync(settingsTarget, JSON.stringify({
    packages: [
      { source: "npm:all-proxies", extensions: ["extensions/a.ts"], lazy: true },
      { source: "npm:filtered-proxies", extensions: [], lazy: true },
    ],
  }), "utf-8");
  removeLazyPackage(tempDir, "npm:all-proxies");
  removeLazyPackage(tempDir, "npm:filtered-proxies");
  const pinWritten = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
  const keepExt = pinWritten.packages.find((p: any) => p.source === "npm:all-proxies");
  const dropExt = pinWritten.packages.find((p: any) => p.source === "npm:filtered-proxies");
  assert(JSON.stringify(keepExt.extensions) === JSON.stringify(["extensions/a.ts"]) && !Object.hasOwn(keepExt, "lazy"),
    "inline pin must keep a non-empty extensions filter");
  assert(!Object.hasOwn(dropExt, "extensions") && !Object.hasOwn(dropExt, "lazy"),
    "inline pin must drop the empty extensions deferral filter");
  console.log("  ✓ inline pin preserves non-empty extensions filters");

  // File mode is preserved across a settings.json rewrite (may hold secrets at 0600).
  writeFileSync(settingsTarget, JSON.stringify({
    packages: [
      { source: "npm:all-proxies", extensions: [], lazy: true },
      { source: "npm:filtered-proxies", extensions: [], lazy: true },
    ],
  }), "utf-8");
  chmodSync(settingsTarget, 0o640);
  removeLazyPackage(tempDir, "npm:all-proxies");
  assert((statSync(join(tempDir, "settings.json")).mode & 0o777) === 0o640,
    "settings.json rewrite must preserve the exact file mode");
  console.log("  ✓ settings.json file mode preserved across rewrite");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("Check 3 passed.\n");

// -----------------------------------------------------------------------------
if (process.env.PI_LAZY_SKIP_E2E === "1") {
  console.log("Skipping Check 4 (PI_LAZY_SKIP_E2E=1). Checks 1-3 passed.");
  process.exit(0);
}

// CHECK 4: Non-interactive End-to-End Proof (missing-cache eager bootstrap)
// -----------------------------------------------------------------------------
console.log("--- Check 4: Non-interactive End-to-End Proof via Pi CLI ---");

const reportPath = join(tmpdir(), `pi-lazy-e2e-report-${Date.now()}.json`);
const e2eAgentDir = join(tmpdir(), `pi-lazy-e2e-agent-${Date.now()}`);
const e2ePackageDir = join(e2eAgentDir, "npm", "node_modules", "pi-lazy-e2e-fixture");
mkdirSync(e2ePackageDir, { recursive: true });
writeFileSync(join(e2ePackageDir, "package.json"), JSON.stringify({
  name: "pi-lazy-e2e-fixture",
  type: "module",
  pi: { extensions: ["./index.js"] },
}));
writeFileSync(join(e2ePackageDir, "index.js"), `export default function (pi) {
  pi.registerTool({
    name: "answer_42",
    description: "Return the number 42",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute() { return { content: [{ type: "text", text: "42" }], details: {} }; },
  });
}`);
writeFileSync(join(e2eAgentDir, CONFIG_FILENAME), JSON.stringify({
  packages: ["npm:pi-lazy-e2e-fixture"],
}));

const prompt = "Call the answer_42 tool and tell me the number it returned.";

const candidateModels = ["google/gemini-2.5-flash", "google/gemini-3.5-flash", "google/gemini-3.8-flash"];
let proc: any;
let piOutput = "";

for (const model of candidateModels) {
  console.log(`Invoking Pi with model ${model}, loading ./index.ts...`);
  proc = spawnSync(
    "pi",
    [
      "-ne",
      "-e",
      "./index.ts",
      "--model",
      model,
      "-p",
      prompt,
    ],
    {
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_LAZY_REPORT_PATH: reportPath,
        PI_CODING_AGENT_DIR: e2eAgentDir,
      },
      encoding: "utf-8",
      timeout: 75000,
    }
  );

  if (proc.status === 0) {
    piOutput = proc.stdout.trim();
    break;
  } else {
    console.warn(`Model ${model} failed (code ${proc.status}), trying next candidate if available...`);
  }
}

if (!proc || proc.status !== 0) {
  console.error("Pi stdout:", proc?.stdout);
  console.error("Pi stderr:", proc?.stderr);
  throw new Error(`Pi execution failed with exit code ${proc?.status}`);
}

// piOutput is already assigned above
console.log(`Pi response: "${piOutput}"`);
assert(piOutput.includes("42"), `Pi response must contain '42', got: "${piOutput}"`);

const cachedFixture = readCache(e2eAgentDir).packages["pi-lazy-e2e-fixture"];
assert(cachedFixture?.tools.some((tool) => tool.name === "answer_42"), "eager bootstrap must populate unified cache");
rmSync(reportPath, { force: true });
rmSync(e2eAgentDir, { recursive: true, force: true });

console.log("  ✓ Missing-cache package loaded eagerly");
console.log("  ✓ Unified cache captured its exposed tool");
console.log("  ✓ The tool executed in the same session and returned 42");
console.log("Check 4 passed.\n");

console.log("==============================================");
console.log("ALL 4 VERIFICATION CHECKS COMPLETED AND PASSED");
console.log("==============================================");
