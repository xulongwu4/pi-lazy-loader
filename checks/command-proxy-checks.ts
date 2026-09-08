import { mkdirSync, rmSync, writeFileSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import type { PackageDefinition } from "../src/package.js";
import { writeCache } from "../src/cache.js";
import { buildCommandDefinitions } from "../src/command-config.js";
import { LazyLoader } from "../src/loader.js";
import lazyLoaderExtension from "../index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const commandDiagnostics = (packages: PackageDefinition[]) => buildCommandDefinitions(packages).diagnostics;

const PACKAGES: PackageDefinition[] = [
  {
    name: "pi-mcp-adapter",
    source: "npm:pi-mcp-adapter",
    aliases: ["pi-mcp-adapter", "npm:pi-mcp-adapter"],
    commands: [
      { name: "mcp", description: "Show MCP server status" },
      { name: "pi-mcp", description: "Show MCP server status" },
      { name: "mcp-auth", description: "Authenticate with an MCP server" },
    ],
  },
  {
    name: "pi-token-burden",
    source: "npm:pi-token-burden",
    aliases: ["pi-token-burden", "npm:pi-token-burden"],
    commands: [{ name: "token-burden", description: "Show token-budget usage" }],
  },
];

console.log("=== Running Command Proxy Feature Checks ===\n");

// -----------------------------------------------------------------------------
// CHECK 1: Cached Command Validation
// -----------------------------------------------------------------------------
console.log("--- Check 1: Cached Command Validation ---");

// 1.1 Current PACKAGES commands must be valid
const packageDiagnostics = commandDiagnostics(PACKAGES);
assert(packageDiagnostics.length === 0, `Cached commands validation failed: ${packageDiagnostics.join("; ")}`);
console.log("  ✓ PACKAGES commands pass validation");

// 1.2 Omitted descriptions are valid in declarations
const omittedDescEntry: any = {
  name: "pi-mcp-adapter",
  source: "npm:pi-mcp-adapter",
  locator: "npm:pi-mcp-adapter",
  cost: 0.2,
  capability: "MCP",
  commands: [{ name: "mcp" }],
};
const omittedDiag = commandDiagnostics([omittedDescEntry]);
assert(omittedDiag.length === 0, `Omitted description should be valid, got: ${omittedDiag.join("; ")}`);
console.log("  ✓ Omitted command description in package definition is accepted");

// 1.3 Cached names reflect commands Pi already accepted, including underscores
const cachedNameEntry: any = {
  name: "pi-mcp-adapter",
  source: "npm:pi-mcp-adapter",
  locator: "npm:pi-mcp-adapter",
  cost: 0,
  capability: "MCP",
  commands: [{ name: "mcp__agent-lsp__rename", description: "Cached MCP command" }],
};
assert(commandDiagnostics([cachedNameEntry]).length === 0, "cached underscore command must remain proxyable");
console.log("  ✓ Cached Pi command names are preserved without user-config restrictions");

// 1.4 Only unusable cached names are rejected; descriptions do not suppress commands
for (const name of ["", "bad\nname"]) {
  const invalidEntry = { ...cachedNameEntry, commands: [{ name }] };
  assert(commandDiagnostics([invalidEntry]).length > 0, `Invalid cached command name ${JSON.stringify(name)} must be rejected`);
}
const longDescriptionEntry = { ...cachedNameEntry, commands: [{ name: "mcp", description: "x".repeat(500) }] };
assert(commandDiagnostics([longDescriptionEntry]).length === 0, "cached descriptions must not suppress real commands");
console.log("  ✓ Cached registrations reject unusable names without dropping long descriptions");
// 1.5 Duplicate command names in same package rejected
const duplicateEntry: any = {
  name: "pi-mcp-adapter",
  source: "npm:pi-mcp-adapter",
  locator: "npm:pi-mcp-adapter",
  cost: 0.2,
  capability: "MCP",
  commands: [{ name: "mcp", description: "First" }, { name: "mcp", description: "Second" }],
};
const dupDiags = buildCommandDefinitions([duplicateEntry]).diagnostics;
assert(dupDiags.length > 0, "Duplicate command names in package definition must produce diagnostics");
console.log("  ✓ Duplicate command names in package definition rejected");

const crossPackage = buildCommandDefinitions([
  { name: "one", source: "npm:one", commands: [{ name: "shared" }] },
  { name: "two", source: "npm:two", commands: [{ name: "shared" }] },
]);
assert(!crossPackage.definitions.some((definition) => definition.commandName === "shared"), "Cross-package command conflicts must not register a proxy");
assert(crossPackage.diagnostics.length > 0, "Cross-package command conflicts must produce diagnostics");
console.log("  ✓ Cross-package cached command conflicts are skipped");

// -----------------------------------------------------------------------------
// CHECK 2: Reserve Before Register & Multi-Command Capture
// -----------------------------------------------------------------------------
console.log("--- Check 2: Reserve Before Register & Multi-Command Capture ---");

interface MockPackageFixtureOptions {
  packageName: string;
  indexJs: string;
  packageJson?: Record<string, any>;
}

function createMockPackageFixture(options: MockPackageFixtureOptions) {
  const root = join(tmpdir(), `pi-lazy-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const pkgDir = join(root, "npm", "node_modules", options.packageName);
  mkdirSync(pkgDir, { recursive: true });

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      options.packageJson ?? {
        name: options.packageName,
        type: "module",
        pi: { extensions: ["./index.js"] },
      }
    )
  );

  writeFileSync(join(pkgDir, "index.js"), options.indexJs);
  writeFileSync(
    join(root, "lazy-loader.json"),
    JSON.stringify({ packages: [`npm:${options.packageName}`] })
  );
  const cachedCommands = PACKAGES.find((pkg) => pkg.name === options.packageName)?.commands ?? [];
  writeCache(root, {
    version: 1,
    packages: { [options.packageName]: { tools: [], commands: cachedCommands } },
  });

  const registeredCommands = new Map<string, any>();
  const registeredTools = new Map<string, any>();
  const mockPi: any = {
    registerTool(tool: any) {
      registeredTools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      registeredCommands.set(name, command);
    },
    getCommands() {
      return Array.from(registeredCommands.entries()).map(([name, cmd]) => ({
        name,
        description: cmd.description,
        source: "pi-lazy-loader",
      }));
    },
    getAllTools() {
      return Array.from(registeredTools.values());
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    on() {},
  };

  return {
    root,
    registeredCommands,
    mockPi,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const fixture = createMockPackageFixture({
  packageName: "pi-mcp-adapter",
  indexJs: `export default function (pi) {
    globalThis.__mcpFactoryRunCount = (globalThis.__mcpFactoryRunCount || 0) + 1;
    pi.registerCommand("mcp", {
      description: "real mcp description",
      getArgumentCompletions(prefix) { return [{ value: prefix + "-mcp", label: "mcp" }]; },
      async handler(args, ctx) { return "mcp-result:" + args; },
    });
    pi.registerCommand("pi-mcp", {
      description: "real pi-mcp description",
      async handler(args, ctx) { return "pi-mcp-result:" + args; },
    });
    pi.registerCommand("mcp-auth", {
      description: "real mcp-auth description",
      async handler(args, ctx) { return "mcp-auth-result:" + args; },
    });
    pi.registerCommand("unreserved-cmd", {
      description: "unreserved",
      async handler() { return "unreserved"; },
    });
  }`,
});

const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
  process.env.PI_CODING_AGENT_DIR = fixture.root;

  // Invoke the real default extension factory from index.ts against mock Pi and temp agent dir with pi-mcp-adapter deferred
  lazyLoaderExtension(fixture.mockPi);

  // Retrieve actual registered startup proxies from mockPi
  const startupMcp = fixture.registeredCommands.get("mcp");
  const startupPiMcp = fixture.registeredCommands.get("pi-mcp");
  const startupMcpAuth = fixture.registeredCommands.get("mcp-auth");

  assert(startupMcp !== undefined, "Actual /mcp startup proxy must be registered by index extension factory");
  assert(startupPiMcp !== undefined, "Actual /pi-mcp startup proxy must be registered by index extension factory");
  assert(startupMcpAuth !== undefined, "Actual /mcp-auth startup proxy must be registered by index extension factory");
  assert(typeof startupMcp.getArgumentCompletions === "function", "Startup proxy must provide getArgumentCompletions");

  // 5.1 Pre-load completions return null without importing/loading package
  const preLoadCompletions = startupMcp.getArgumentCompletions("test");
  assert(preLoadCompletions === null, "Pre-load completions on real startup proxy must return null");
  assert((globalThis as any).__mcpFactoryRunCount === undefined, "Pre-load completion must not run factory or import package");
  console.log("  ✓ Pre-load completions on real startup proxy return null without triggering package load");

  // 5.2 Invoking /mcp loads the factory once and captures all three declared commands
  const ctx = { cwd: "/fixture", hasUI: true, ui: { notify() {} } };
  const res1 = await startupMcp.handler("arg1", ctx);
  assert(res1 === "mcp-result:arg1", "Invoking startup proxy for /mcp must execute captured handler and return result");
  assert((globalThis as any).__mcpFactoryRunCount === 1, "Factory must execute exactly once upon first command invocation");

  // All 3 commands replaced in mockPi
  const cmdMcp = fixture.registeredCommands.get("mcp");
  const cmdPiMcp = fixture.registeredCommands.get("pi-mcp");
  const cmdMcpAuth = fixture.registeredCommands.get("mcp-auth");
  const cmdUnreserved = fixture.registeredCommands.get("unreserved-cmd");

  assert(cmdMcp !== startupMcp, "/mcp stub must be replaced after load");
  assert(cmdPiMcp !== startupPiMcp, "/pi-mcp stub must be replaced after load");
  assert(cmdMcpAuth !== startupMcpAuth, "/mcp-auth stub must be replaced after load");
  assert(cmdUnreserved !== undefined, "Non-reserved command must be forwarded immediately");

  // 5.3 Provenance and decoration preserved
  assert(cmdMcp.description.includes("[target: pi-mcp-adapter; via pi-lazy-loader]"), "Committed command must have delegated attribution");
  assert(cmdMcp.description.startsWith("real mcp description"), "Committed command must start with real target description");

  // 5.4 Handler and completion identity preserved by reference
  const res2 = await cmdPiMcp.handler("arg2", ctx);
  assert(res2 === "pi-mcp-result:arg2", "Direct handler for /pi-mcp must execute correctly");

  const res3 = await cmdMcpAuth.handler("arg3", ctx);
  assert(res3 === "mcp-auth-result:arg3", "Direct handler for /mcp-auth must execute correctly");

  // Subsequent invocation through startup stub also works idempotently without re-running factory
  const res2ViaStub = await startupPiMcp.handler("arg2-repeat", ctx);
  assert(res2ViaStub === "pi-mcp-result:arg2-repeat", "Startup stub invocation after load works idempotently");
  assert((globalThis as any).__mcpFactoryRunCount === 1, "Subsequent command call must not re-run package factory");

  // Completions post-load come from target
  const comp = await cmdMcp.getArgumentCompletions("myprefix");
  assert(comp[0].value === "myprefix-mcp", "Post-load completions must be served by real target");

  // No suffixed duplicate commands created
  assert(!fixture.registeredCommands.has("mcp:1"), "No :1 duplicate for /mcp");
  assert(!fixture.registeredCommands.has("pi-mcp:1"), "No :1 duplicate for /pi-mcp");
  assert(!fixture.registeredCommands.has("mcp-auth:1"), "No :1 duplicate for /mcp-auth");

  console.log("  ✓ Multi-command load captures all declared commands in one factory execution");
  console.log("  ✓ Handlers, completions, and delegated provenance verified post-load");
} finally {
  delete (globalThis as any).__mcpFactoryRunCount;
  if (prevAgentDir !== undefined) {
    process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  } else {
    delete process.env.PI_CODING_AGENT_DIR;
  }
  fixture.cleanup();
}

// -----------------------------------------------------------------------------
// CHECK 3: Staged Commit Atomicity on Load Failure
// -----------------------------------------------------------------------------
console.log("--- Check 3: Staged Commit Atomicity on Load Failure ---");

const failFixture = createMockPackageFixture({
  packageName: "pi-token-burden",
  indexJs: `export default function (pi) {
    pi.registerCommand("token-burden", {
      description: "should not be committed",
      handler() {},
    });
    pi.registerCommand("unreserved-during-fail", {
      description: "unreserved forwarded immediately",
      handler() {},
    });
    throw new Error("Simulated factory failure during package load!");
  }`,
});

try {
  const loader = new LazyLoader(failFixture.mockPi, failFixture.root);
  loader.reserveCommand("pi-token-burden", "token-burden", { declaredDescription: "Show token-budget usage", decorateDescription: true });

  const initialStub = {
    description: "Initial startup stub",
    handler() { return "stub"; },
  };
  failFixture.registeredCommands.set("token-burden", initialStub);

  // Attempt to load package - will fail!
  const failResult = await loader.loadPackage("pi-token-burden");
  assert(!failResult.success, "Package load must fail");
  assert(failResult.status === "failed", "Package status must be 'failed'");

  // ATOMICITY ASSERTION: Stub must remain completely intact!
  const currentCommand = failFixture.registeredCommands.get("token-burden");
  assert(currentCommand === initialStub, "Startup stub must remain intact and NOT replaced after failed load");
  assert(currentCommand.description === "Initial startup stub", "Stub description must remain unchanged");

  // Staged registration was NOT committed
  let invokeErr = "";
  try {
    await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
  } catch (err: any) {
    invokeErr = err.message;
  }
  assert(invokeErr.includes("did not register") || invokeErr.includes("failed"), "Invoking uncommitted command must fail cleanly");

  // Non-reserved command was forwarded immediately before the throw
  assert(failFixture.registeredCommands.has("unreserved-during-fail"), "Non-reserved command forwarded immediately as per Amendment 1");

  console.log("  ✓ Staged commit atomicity verified: failed load leaves stub intact and commits nothing");
} finally {
  failFixture.cleanup();
}

// 6.2 Duplicate target registration within one factory aborts package load with actionable error
const dupFixture = createMockPackageFixture({
  packageName: "pi-token-burden",
  indexJs: `export default function (pi) {
    pi.registerCommand("token-burden", {
      description: "first registration",
      handler() {},
    });
    pi.registerCommand("token-burden", {
      description: "second duplicate registration",
      handler() {},
    });
  }`,
});

try {
  const loader = new LazyLoader(dupFixture.mockPi, dupFixture.root);
  loader.reserveCommand("pi-token-burden", "token-burden", { declaredDescription: "Token burden" });

  const initialStub = {
    description: "Initial startup stub",
    handler() { return "stub"; },
  };
  dupFixture.registeredCommands.set("token-burden", initialStub);

  const failResult = await loader.loadPackage("pi-token-burden");
  assert(!failResult.success, "Package load must fail on duplicate registration within one factory");
  assert(failResult.status === "failed", "Package status must be 'failed'");
  assert(
    failResult.error?.includes("Duplicate target registration") &&
    failResult.error?.includes("token-burden") &&
    failResult.error?.includes("pi-token-burden"),
    `Error must be actionable package+command error, got: ${failResult.error}`
  );

  // ATOMICITY: startup stub remains intact
  const currentCommand = dupFixture.registeredCommands.get("token-burden");
  assert(currentCommand === initialStub, "Startup stub must remain intact and NOT replaced");
  assert(currentCommand.description === "Initial startup stub", "Stub description must remain unchanged");

  // ATOMICITY: no staged commands committed
  assert(!loader.isCommandCaptured("pi-token-burden", "token-burden"), "Duplicate command must not be committed to captured state");
  assert(loader.getCommandStatus("pi-token-burden", "token-burden") === "failed", "Command status must be 'failed'");
  console.log("  ✓ Duplicate target registration within one factory aborts load with actionable error and preserves startup stub");
} finally {
  dupFixture.cleanup();
}

// 6.3 Duplicate target registration across extension entries aborts package load with actionable error
const dupMultiFixture = createMockPackageFixture({
  packageName: "pi-token-burden",
  packageJson: {
    name: "pi-token-burden",
    type: "module",
    pi: { extensions: ["./entry1.js", "./entry2.js"] },
  },
  indexJs: "",
});

const pkgDirMulti = join(dupMultiFixture.root, "npm", "node_modules", "pi-token-burden");
writeFileSync(
  join(pkgDirMulti, "entry1.js"),
  `export default function (pi) {
    pi.registerCommand("token-burden", {
      description: "entry1 registration",
      handler() {},
    });
  }`
);
writeFileSync(
  join(pkgDirMulti, "entry2.js"),
  `export default function (pi) {
    pi.registerCommand("token-burden", {
      description: "entry2 duplicate registration",
      handler() {},
    });
  }`
);

try {
  const loader = new LazyLoader(dupMultiFixture.mockPi, dupMultiFixture.root);
  loader.reserveCommand("pi-token-burden", "token-burden", { declaredDescription: "Token burden" });

  const initialStub = {
    description: "Initial startup stub",
    handler() { return "stub"; },
  };
  dupMultiFixture.registeredCommands.set("token-burden", initialStub);

  const failResult = await loader.loadPackage("pi-token-burden");
  assert(!failResult.success, "Package load must fail on cross-entry duplicate registration");
  assert(failResult.status === "failed", "Package status must be 'failed'");
  assert(
    failResult.error?.includes("Duplicate target registration") &&
    failResult.error?.includes("token-burden") &&
    failResult.error?.includes("pi-token-burden"),
    `Error must be actionable package+command error, got: ${failResult.error}`
  );

  // ATOMICITY: startup stub remains intact
  const currentCommand = dupMultiFixture.registeredCommands.get("token-burden");
  assert(currentCommand === initialStub, "Startup stub must remain intact and NOT replaced");
  assert(currentCommand.description === "Initial startup stub", "Stub description must remain unchanged");

  // ATOMICITY: no staged commands committed
  assert(!loader.isCommandCaptured("pi-token-burden", "token-burden"), "Duplicate command must not be committed to captured state");
  assert(loader.getCommandStatus("pi-token-burden", "token-burden") === "failed", "Command status must be 'failed'");
  console.log("  ✓ Duplicate target registration across extension entries aborts load with actionable error and preserves startup stub");
} finally {
  dupMultiFixture.cleanup();
}

// -----------------------------------------------------------------------------
// CHECK 4: Command Readiness in Loader State
// -----------------------------------------------------------------------------
console.log("--- Check 4: Command Readiness in Loader State ---");

const readyFixture = createMockPackageFixture({
  packageName: "pi-mcp-adapter",
  // Factory registers /mcp and /pi-mcp, but NOT /mcp-auth (missing command scenario)
  indexJs: `export default function (pi) {
    pi.registerCommand("mcp", { description: "MCP", handler() {} });
    pi.registerCommand("pi-mcp", { description: "PI-MCP", handler() {} });
    // Note: mcp-auth is omitted intentionally
  }`,
});

try {
  const loader = new LazyLoader(readyFixture.mockPi, readyFixture.root);
  loader.reserveCommand("pi-mcp-adapter", "mcp");
  loader.reserveCommand("pi-mcp-adapter", "pi-mcp");
  loader.reserveCommand("pi-mcp-adapter", "mcp-auth");

  // 7.1 Before load: all commands are "deferred"
  assert(loader.getCommandStatus("pi-mcp-adapter", "mcp") === "deferred", "/mcp must be deferred before load");
  assert(loader.getCommandStatus("pi-mcp-adapter", "pi-mcp") === "deferred", "/pi-mcp must be deferred before load");
  assert(loader.getCommandStatus("pi-mcp-adapter", "mcp-auth") === "deferred", "/mcp-auth must be deferred before load");

  // Load package
  const res = await loader.loadPackage("pi-mcp-adapter");
  assert(res.success, "Package must load successfully");

  // 7.2 After load: registered commands are "ready", omitted command is "missing"
  assert(loader.getCommandStatus("pi-mcp-adapter", "mcp") === "ready", "/mcp must be 'ready'");
  assert(loader.getCommandStatus("pi-mcp-adapter", "pi-mcp") === "ready", "/pi-mcp must be 'ready'");
  assert(loader.getCommandStatus("pi-mcp-adapter", "mcp-auth") === "missing", "/mcp-auth was not registered, must be 'missing'");

  console.log("  ✓ Per-command readiness distinguishes 'deferred', 'ready', and 'missing'");
} finally {
  readyFixture.cleanup();
}

// -----------------------------------------------------------------------------
// CHECK 5: Packaging Exact Allowlist & Clean Install Smoke
// -----------------------------------------------------------------------------
console.log("--- Check 5: Packaging Exact Allowlist & Clean Install Smoke ---");

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(currentDir, "..");
const pkgJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf-8")
);

// 8.1 package.json files array matches expected patterns
const expectedFilesField = ["index.ts", "src", "README.md", "lazy-loader.schema.json"];
assert(Array.isArray(pkgJson.files), "package.json must contain files array");
for (const item of expectedFilesField) {
  assert(pkgJson.files.includes(item), `package.json files must include "${item}"`);
  assert(statSync(join(projectRoot, item)), `Published file/dir "${item}" must exist`);
}

// 8.2 Exact published files allowlist: every file in the packed tarball must match the allowlist exactly
const expectedPackedFiles = [
  "README.md",
  "index.ts",
  "lazy-loader.schema.json",
  "package.json",
  "src/cache.ts",
  "src/command-config.ts",
  "src/config.ts",
  "src/command-presentation.ts",
  "src/loader.ts",
  "src/package-locator.ts",
  "src/package.ts",
  "src/resolver.ts",
  "src/tool-proxy.ts",
].sort();

const packDryRun = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: projectRoot,
  encoding: "utf-8",
});
assert(packDryRun.status === 0, `npm pack --dry-run failed: ${packDryRun.stderr}`);
const packInfo = JSON.parse(packDryRun.stdout);
const actualPackedFiles: string[] = (packInfo[0].files as Array<{ path: string }>)
  .map((f) => f.path)
  .sort();

assert(
  JSON.stringify(actualPackedFiles) === JSON.stringify(expectedPackedFiles),
  `Packed files do not match exact allowlist!\nExpected: ${JSON.stringify(expectedPackedFiles)}\nActual: ${JSON.stringify(actualPackedFiles)}`
);
console.log(`  ✓ Packed files match exact allowlist (${actualPackedFiles.length} files, zero unexpected files)`);

// 8.3 Clean install smoke test: pack into tarball, install in clean consumer, start Pi
const packTempDir = join(tmpdir(), `pi-lazy-pack-smoke-${Date.now()}`);
mkdirSync(packTempDir, { recursive: true });
const consumerTempDir = join(tmpdir(), `pi-lazy-consumer-smoke-${Date.now()}`);
mkdirSync(consumerTempDir, { recursive: true });

try {
  // Pack tarball
  const packProc = spawnSync("npm", ["pack", "--pack-destination", packTempDir], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  assert(packProc.status === 0, `npm pack failed: ${packProc.stderr}`);
  const tgzFile = readdirSync(packTempDir).find((f) => f.endsWith(".tgz"));
  assert(tgzFile !== undefined, "Packed tarball must exist");
  const tgzPath = join(packTempDir, tgzFile);

  // Initialize consumer package and install tarball with bun
  writeFileSync(
    join(consumerTempDir, "package.json"),
    JSON.stringify({ name: "consumer-smoke", type: "module" }, null, 2),
    "utf-8"
  );
  const bunAdd = spawnSync("bun", ["add", tgzPath], {
    cwd: consumerTempDir,
    encoding: "utf-8",
  });
  assert(bunAdd.status === 0, `bun add failed: ${bunAdd.stderr}`);

  const installedDir = join(consumerTempDir, "node_modules", "pi-lazy-loader");
  assert(statSync(installedDir).isDirectory(), "Installed pi-lazy-loader directory must exist");
  assert(statSync(join(installedDir, "index.ts")).isFile(), "Installed index.ts must exist");

  // Verify no duplicate Pi runtime peers were pulled into consumer node_modules
  const consumerModules = readdirSync(join(consumerTempDir, "node_modules"));
  assert(
    !consumerModules.includes("@earendil-works"),
    "Clean installation must not bundle duplicate @earendil-works Pi runtime peers"
  );

  // Start Pi non-interactively from the installed copy to ensure factory initializes cleanly
  const piSmoke = spawnSync(
    "pi",
    ["-ne", "-e", join(installedDir, "index.ts"), "--version"],
    {
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert(piSmoke.status === 0, `Pi startup with installed copy failed: ${piSmoke.stderr}`);
  console.log("  ✓ Clean install smoke test passed: installed tarball cleanly loads in Pi without duplicate peers");
} finally {
  rmSync(packTempDir, { recursive: true, force: true });
  rmSync(consumerTempDir, { recursive: true, force: true });
}

console.log("\n==============================================");
console.log("ALL COMMAND PROXY CHECKS COMPLETED AND PASSED");
console.log("==============================================");
