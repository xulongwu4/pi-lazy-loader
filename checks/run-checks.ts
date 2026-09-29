import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { resolvePackageDefinition, resolvePackageEntries, resolvePackageRoot } from "../src/resolver.js";
import { LazyLoader } from "../src/loader.js";
import { CONFIG_FILENAME, readLazyLoaderConfig, removeLazyPackage } from "../src/config.js";
import { fakePi } from "./fake-pi.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("=== Running Isolated Verification Checks ===\n");

const agentDir = mkdtempSync(join(tmpdir(), "pi-lazy-check-fixtures-"));
try {
  console.log("--- Check 1: File and Directory Entry Resolution ---");
  const fixtures = {
    "fixture-file": ["index.js"],
    "fixture-directory": ["extension"],
    "fixture-multi": Array.from({ length: 6 }, (_, i) => `entry-${i}.js`),
  };
  for (const [name, entries] of Object.entries(fixtures)) {
    const root = join(agentDir, "npm", "node_modules", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module", pi: { extensions: entries } }));
    for (const [i, entry] of entries.entries()) {
      const file = join(root, entry.endsWith(".js") ? entry : join(entry, "index.ts"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `
        import { appendFileSync } from "node:fs";
        export default function(pi) {
          const mark = event => appendFileSync(${JSON.stringify(join(root, "trace"))}, event + "\\n");
          mark("factory");
          pi.on("session_start", () => mark("session_start"));
          pi.on("resources_discover", () => mark("resources_discover"));
          pi.registerTool({
            name: "${name.replaceAll("-", "_")}_${i}", label: "Fixture", description: "Fixture",
            parameters: { type: "object", properties: {} },
            execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
          });
        }
      `);
    }
  }

  const packages = Object.keys(fixtures).map(name => resolvePackageDefinition(`npm:${name}`, agentDir));
  for (const pkg of packages) {
    assert(existsSync(resolvePackageRoot(pkg.source, agentDir)), `Missing package root: ${pkg.name}`);
    const entries = resolvePackageEntries(pkg, agentDir);
    assert(entries.length === fixtures[pkg.name as keyof typeof fixtures].length, `Wrong entry count: ${pkg.name}`);
    assert(entries.every(entry => existsSync(entry) && /\.(ts|js)$/.test(entry)), `Invalid entries: ${pkg.name}`);
    if (pkg.name === "fixture-directory") assert(entries[0].endsWith("extension/index.ts"), "directory must resolve index.ts");
    console.log(`  ✓ ${pkg.name}: ${entries.length} entries`);
  }
  try {
    resolvePackageRoot("npm:non-existent-package-xyz", agentDir);
    assert(false, "Missing package must fail");
  } catch (error: any) {
    assert(error.message.includes("not found"), error.message);
  }
  console.log("Check 1 passed.\n");

  console.log("--- Check 2: Idempotence, Concurrency and Lifecycle Replay ---");
  const pi = fakePi();
  const loader = new LazyLoader(pi as any, agentDir, packages);
  loader.setSessionStart({ type: "session_start", reason: "startup" }, { cwd: agentDir, hasUI: false });
  loader.setResourcesDiscover({ type: "resources_discover", reason: "startup" }, { cwd: agentDir });
  assert(loader.getAllStates().every(state => state.status === "deferred"), "packages must start deferred");
  const results = await Promise.all(Array.from({ length: 5 }, () => loader.loadPackage("fixture-file")));
  assert(results.every(result => result.success && result.status === "loaded"), "concurrent loads must succeed");
  const trace = readFileSync(join(agentDir, "npm/node_modules/fixture-file/trace"), "utf8").trim().split("\n");
  assert(trace.filter(event => event === "factory").length === 1, "concurrent calls must load once");
  assert(trace.filter(event => event === "session_start").length === 1, "session_start must replay once");
  assert(trace.filter(event => event === "resources_discover").length === 1, "resources_discover must replay once");
  assert((await loader.loadPackage("fixture-file")).alreadyLoaded === true, "repeat load must be idempotent");
  const multi = await loader.loadPackage("fixture-multi");
  assert(multi.success && multi.entries?.length === 6, "all six entries must load");
  const directory = await loader.loadPackage("fixture-directory");
  assert(directory.success, `directory entry must load: ${directory.error}`);
  const invalid = await loader.loadPackage("non-existent-pkg-abc");
  assert(!invalid.success && invalid.status === "failed", "unknown package must fail");
  console.log("Check 2 passed.\n");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}

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

// Real Pi SDK + QuickJS integration, with isolated fixtures and no model/provider calls.
console.log("--- Check 4: Native Codemode Integration ---");
await import("./codemode-checks.js");
console.log("Check 4 passed.\n");

console.log("==============================================");
console.log("ALL 4 VERIFICATION CHECKS COMPLETED AND PASSED");
console.log("==============================================");
