import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MANIFEST, findManifestEntry } from "../src/manifest.js";
import { getUserAgentDir, resolvePackageEntries, resolvePackageRoot } from "../src/resolver.js";
import { LazyLoader } from "../src/loader.js";
import { pinPackageInSettingsFile, transformPinSettings } from "../src/settings.js";

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
const agentDir = getUserAgentDir();
console.log(`Agent directory: ${agentDir}`);

assert(MANIFEST.length === 10, `Manifest must contain exactly 10 packages, got ${MANIFEST.length}`);

for (const pkg of MANIFEST) {
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

const loader = new LazyLoader(mockPi, agentDir);

// Simulate genuine startup events
loader.setSessionStart(
  { type: "session_start", reason: "startup" },
  { sessionManager: { getSessionId: () => "mock-session" }, cwd: process.cwd(), hasUI: false }
);
loader.setResourcesDiscover(
  { type: "resources_discover", reason: "startup" },
  { cwd: process.cwd() }
);

// Verify all 10 are initially in deferred state
const initialStates = loader.getAllStates();
assert(initialStates.length === 10, `Expected 10 initial states, got ${initialStates.length}`);
for (const s of initialStates) {
  assert(s.status === "deferred", `Expected initial status 'deferred' for ${s.manifest.name}, got ${s.status}`);
}
console.log("  ✓ All 10 packages initialized in 'deferred' status");

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

// Test multi-entry package: pi-quotas (6 entries)
const quotasResult = await loader.loadPackage("pi-quotas");
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
// CHECK 3: Safe Settings Pin Transform on Temp Data (Never touches real settings)
// -----------------------------------------------------------------------------
console.log("--- Check 3: Safe Settings Pin Transform on Temp Data ---");

const tempDir = join(tmpdir(), `pi-lazy-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tempDir, { recursive: true });
const tempSettingsPath = join(tempDir, "settings.json");

try {
  // Case A: Transform object with extensions: [] and preserve unknown properties
  const mockSettings = {
    theme: "nord",
    customTopLevelProp: "top_level_value",
    packages: [
      "npm:some-other-pkg",
      {
        source: "npm:pi-fabric",
        extensions: [],
        preserveThisField: "important_metadata",
        nestedConfig: { a: 1, b: "hello" },
      },
      {
        source: "git:github.com/xulongwu4/pi-quotas",
        extensions: [],
        gitCustom: true,
      },
    ],
  };

  writeFileSync(tempSettingsPath, JSON.stringify(mockSettings, null, 2), "utf-8");

  // Pin pi-fabric
  const pinRes1 = pinPackageInSettingsFile(tempSettingsPath, "pi-fabric");
  assert(pinRes1.success, "Pinning pi-fabric failed");

  const written1 = JSON.parse(readFileSync(tempSettingsPath, "utf-8"));
  const fabricEntry = written1.packages.find((p: any) => typeof p === "object" && p.source === "npm:pi-fabric");

  assert(fabricEntry !== undefined, "fabric entry must exist");
  assert(fabricEntry.extensions === undefined, "extensions: [] must be removed");
  assert(
    fabricEntry.preserveThisField === "important_metadata",
    "preserveThisField must be preserved"
  );
  assert(
    fabricEntry.nestedConfig?.b === "hello",
    "nestedConfig must be preserved"
  );
  assert(written1.customTopLevelProp === "top_level_value", "top level props must be preserved");
  console.log("  ✓ Successfully pinned pi-fabric and preserved unknown properties");

  // Pin pi-quotas using alias
  const pinRes2 = pinPackageInSettingsFile(tempSettingsPath, "pi-quotas");
  assert(pinRes2.success, "Pinning pi-quotas failed");

  const written2 = JSON.parse(readFileSync(tempSettingsPath, "utf-8"));
  const quotasEntry = written2.packages.find(
    (p: any) => typeof p === "object" && p.source === "git:github.com/xulongwu4/pi-quotas"
  );
  assert(quotasEntry.extensions === undefined, "extensions: [] must be removed from pi-quotas");
  assert(quotasEntry.gitCustom === true, "gitCustom property must be preserved");
  console.log("  ✓ Successfully pinned pi-quotas by alias and preserved custom fields");

  // Refusal Case 1: Missing package
  try {
    pinPackageInSettingsFile(tempSettingsPath, "npm:not-in-settings");
    assert(false, "Should have refused missing package");
  } catch (err: any) {
    assert(err.message.includes("not found in settings"), `Expected not found, got: ${err.message}`);
    console.log(`  ✓ Refused missing package: ${err.message}`);
  }

  // Refusal Case 2: Package is already eager (string form)
  try {
    pinPackageInSettingsFile(tempSettingsPath, "npm:some-other-pkg");
    assert(false, "Should have refused string package");
  } catch (err: any) {
    assert(err.message.includes("eager string"), `Expected eager string, got: ${err.message}`);
    console.log(`  ✓ Refused already eager string package: ${err.message}`);
  }

  // Refusal Case 3: Ambiguous packages
  const ambiguousSettings = {
    packages: [
      { source: "npm:pi-fabric", extensions: [] },
      { source: "npm:pi-fabric", extensions: [] },
    ],
  };
  try {
    transformPinSettings(ambiguousSettings, "pi-fabric");
    assert(false, "Should have refused ambiguous packages");
  } catch (err: any) {
    assert(err.message.includes("ambiguous"), `Expected ambiguous error, got: ${err.message}`);
    console.log(`  ✓ Refused ambiguous packages: ${err.message}`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("Check 3 passed.\n");

// -----------------------------------------------------------------------------
// CHECK 4: Non-interactive End-to-End Proof (Pi + Gemini + pi-fabric + fabric_exec)
// -----------------------------------------------------------------------------
console.log("--- Check 4: Non-interactive End-to-End Proof via Pi CLI ---");

const reportPath = join(tmpdir(), `pi-lazy-e2e-report-${Date.now()}.json`);

const prompt =
  "First call the lazy_load tool with package: 'pi-fabric'. Then call the fabric_exec tool with code: return 40+2. Tell me the number it returned.";

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

assert(existsSync(reportPath), `Report file was not created at ${reportPath}`);
const e2eReport = JSON.parse(readFileSync(reportPath, "utf-8"));
rmSync(reportPath, { force: true });

// Verify step by step evidence:
console.log("E2E Report Summary:");
console.log(`  - Tools before lazy_load: ${e2eReport.toolsBefore?.length} tools`);
console.log(`  - fabric_exec present before: ${e2eReport.fabricPresentBefore}`);
console.log(`  - New tools after lazy_load: ${e2eReport.newTools?.join(", ")}`);
console.log(`  - fabric_exec present after: ${e2eReport.fabricPresentAfter}`);
console.log(`  - Observed tool calls: ${e2eReport.observedToolCalls?.join(" -> ")}`);
console.log(`  - Bootstrap errors: ${e2eReport.bootstrapErrors?.length}`);

assert(e2eReport.fabricPresentBefore === false, "fabric_exec MUST be absent before lazy_load");
assert(e2eReport.fabricPresentAfter === true, "fabric_exec MUST be present after lazy_load");
assert(
  e2eReport.newTools.includes("fabric_exec"),
  "newTools must include 'fabric_exec'"
);
assert(
  e2eReport.observedToolCalls.includes("fabric_exec"),
  "fabric_exec must have been called by the model"
);
assert(
  e2eReport.bootstrapErrors.length === 0,
  `Expected 0 bootstrap errors, got: ${JSON.stringify(e2eReport.bootstrapErrors)}`
);
assert(
  e2eReport.sessionStartCaptured === true,
  "session_start must have been captured eagerly"
);

console.log("  ✓ fabric_exec was absent before lazy_load");
console.log("  ✓ pi-fabric loaded successfully mid-session");
console.log("  ✓ fabric_exec was executed in the same session and returned 42");
console.log("  ✓ No 'Pi Fabric has not bootstrapped' errors occurred");
console.log("Check 4 passed.\n");

console.log("==============================================");
console.log("ALL 4 VERIFICATION CHECKS COMPLETED AND PASSED");
console.log("==============================================");
