import { mkdirSync, rmSync, writeFileSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import type { PackageDefinition } from "../src/package.js";
import { readCache, writeCache } from "../src/cache.js";
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
assert(
  JSON.stringify(crossPackage.definitions.map((d) => [d.packageName, d.proxyName])) === JSON.stringify([["one", "shared:1"], ["two", "shared:2"]]),
  `Cross-package duplicates must get Pi-style name:N proxies, got ${JSON.stringify(crossPackage.definitions)}`
);
assert(crossPackage.diagnostics.length === 0, "Cross-package duplicates are supported, not diagnosed");
const bumped = buildCommandDefinitions([
  { name: "one", source: "npm:one", commands: [{ name: "shared" }, { name: "shared:2" }] },
  { name: "two", source: "npm:two", commands: [{ name: "shared" }] },
]).definitions.map((d) => d.proxyName);
assert(JSON.stringify(bumped) === JSON.stringify(["shared:1", "shared:2", "shared:3"]), `Suffixes must skip taken names, got ${bumped}`);
console.log("  ✓ Cross-package cached command duplicates get name:N proxies like Pi core");

// -----------------------------------------------------------------------------
// CHECK 2: Reserve Before Register & Multi-Command Capture
// -----------------------------------------------------------------------------
console.log("--- Check 2: Reserve Before Register & Multi-Command Capture ---");

interface MockPackageFixtureOptions {
  packageName: string;
  indexJs: string;
  packageJson?: Record<string, any>;
}

function createMockPi() {
  const registeredCommands = new Map<string, any>();
  const registeredTools = new Map<string, any>();
  const sessionStartHandlers: Function[] = [];
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
    on(event: string, handler: Function) {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
    async emitSessionStart(ctx: any = { hasUI: false }) {
      for (const handler of sessionStartHandlers) {
        await handler({ type: "session_start", reason: "startup" }, ctx);
      }
    },
  };
  return { registeredCommands, mockPi };
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

  const { registeredCommands, mockPi } = createMockPi();

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

  // Invoke the real default extension factory from index.ts against mock Pi and temp agent dir with pi-mcp-adapter deferred.
  // Command proxies register at session_start (pi.getCommands() is illegal during extension loading).
  lazyLoaderExtension(fixture.mockPi);
  await fixture.mockPi.emitSessionStart();

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

// -----------------------------------------------------------------------------
// CHECK 6: Post-Bind Collision Semantics (suffixed names, unbound runtime)
// -----------------------------------------------------------------------------
console.log("--- Check 6: Post-Bind Collision Semantics ---");

// 6.1 A pre-existing numeric-suffix duplicate moves the proxy to a free /mcp:N
// (registering /mcp when Pi already resolved /mcp:1 would rename the foreign command).
{
  const suffixFixture = createMockPackageFixture({
    packageName: "pi-mcp-adapter",
    indexJs: `export default function () {}`,
  });
  const suffixPrevDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = suffixFixture.root;
    suffixFixture.mockPi.registerCommand("mcp:1", { description: "pre-existing duplicate", handler() {} });
    lazyLoaderExtension(suffixFixture.mockPi);
    await suffixFixture.mockPi.emitSessionStart();
    assert(!suffixFixture.registeredCommands.has("mcp"), "base-name proxy must not register when Pi already resolved /mcp:1");
    assert(suffixFixture.registeredCommands.has("mcp:2"), "proxy must register as /mcp:2 when /mcp:1 is taken");
    assert(suffixFixture.registeredCommands.has("pi-mcp"), "uncontested proxy must still register");
    console.log("  ✓ Numeric-suffix duplicates move the proxy to a free /mcp:N");
  } finally {
    if (suffixPrevDir !== undefined) process.env.PI_CODING_AGENT_DIR = suffixPrevDir;
    else delete process.env.PI_CODING_AGENT_DIR;
    suffixFixture.cleanup();
  }
}

// 6.2 An unreadable command set (unbound runtime) must fail safe without crashing.
{
  const unboundFixture = createMockPackageFixture({
    packageName: "pi-mcp-adapter",
    indexJs: `export default function () {}`,
  });
  const unboundPrevDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = unboundFixture.root;
    unboundFixture.mockPi.getCommands = () => { throw new Error("not bound"); };
    lazyLoaderExtension(unboundFixture.mockPi);
    const notifications: string[] = [];
    await unboundFixture.mockPi.emitSessionStart({
      hasUI: true,
      ui: { notify(message: string) { notifications.push(message); } },
    });
    assert(!unboundFixture.registeredCommands.has("mcp"), "no proxies may register when the command set is unreadable");
    assert(
      notifications.length === 1 && notifications[0].includes("command proxy registration skipped"),
      `unreadable command set must notify UI exactly once, got: ${JSON.stringify(notifications)}`
    );
    console.log("  ✓ Unreadable command set fails safe without crashing");
  } finally {
    if (unboundPrevDir !== undefined) process.env.PI_CODING_AGENT_DIR = unboundPrevDir;
    else delete process.env.PI_CODING_AGENT_DIR;
    unboundFixture.cleanup();
  }
}

} finally {
  readyFixture.cleanup();
}

// -----------------------------------------------------------------------------
// CHECK 4b: Reserved names hidden from getCommands during load
// -----------------------------------------------------------------------------
console.log("--- Check 4b: Hide reserved names from getCommands during load ---");
{
  const skipFactory = `export default function (pi) {
    const maybeRegister = () => {
      const taken = (pi.getCommands?.() ?? []).some((c) => c.name === "deep-research");
      if (!taken) {
        pi.registerCommand("deep-research", {
          description: "Research a question",
          handler() { return "researched"; },
        });
      }
    };
    maybeRegister();
    pi.on("session_start", () => maybeRegister());
  }`;

  const skipFixture = createMockPackageFixture({
    packageName: "skip-if-present",
    indexJs: skipFactory,
  });
  try {
    const loader = new LazyLoader(skipFixture.mockPi, skipFixture.root);
    loader.reserveCommand("skip-if-present", "deep-research", { declaredDescription: "Research" });
    skipFixture.registeredCommands.set("deep-research", {
      description: "proxy",
      handler() { return "proxy"; },
    });
    loader.setSessionStart({ type: "session_start" }, { hasUI: false });

    const loaded = await loader.loadPackage("skip-if-present");
    assert(loaded.success, `load must succeed, got: ${loaded.error}`);
    assert(
      loader.isCommandCaptured("skip-if-present", "deep-research"),
      "target must registerCommand despite getCommands listing the proxy"
    );
    const result = await loader.invokeCapturedCommand("skip-if-present", "deep-research", "", {});
    assert(result === "researched", `captured handler must run, got: ${result}`);
    const cached = readCache(skipFixture.root).packages["skip-if-present"]?.commands.map((c) => c.name) ?? [];
    assert(cached.includes("deep-research"), `cache must keep the reserved command, got: ${cached.join(", ")}`);
    console.log("  ✓ Reserved proxy names are hidden from getCommands so skip-if-registered factories still capture");
    console.log("  ✓ Replayed session_start does not re-register a just-captured reserved command");
  } finally {
    skipFixture.cleanup();
  }
}

{
  // Two lazy packages registering the same command: two proxies, each loads its own target, names stay put.
  const oneJs = `export default function (pi) {
    pi.registerCommand("cmd", { description: "one", async handler(args) { return "one:" + args; } });
  }`;
  // dup-two uses the skip-if-registered + session_start replay pattern (Check 4b) against its cmd:2 proxy.
  const twoJs = `export default function (pi) {
    const register = () => {
      if ((pi.getCommands?.() ?? []).some((c) => c.name === "cmd")) return;
      pi.registerCommand("cmd", { description: "two", async handler(args) { return "two:" + args; } });
    };
    register();
    pi.on("session_start", register);
  }`;
  const setupDup = async (options: { sessionCtx?: any; oneUncached?: boolean; twoCommands?: string[]; twoCached?: boolean; twoUncached?: boolean; twoJs?: string; preRegistered?: Record<string, any> } = {}) => {
    const fixture = createMockPackageFixture({ packageName: "dup-one", indexJs: oneJs });
    const twoDir = join(fixture.root, "npm", "node_modules", "dup-two");
    mkdirSync(twoDir, { recursive: true });
    writeFileSync(join(twoDir, "package.json"), JSON.stringify({ name: "dup-two", type: "module", pi: { extensions: ["./index.js"] } }));
    writeFileSync(join(twoDir, "index.js"), options.twoJs ?? twoJs);
    writeFileSync(join(fixture.root, "lazy-loader.json"), JSON.stringify({ packages: ["npm:dup-one", "npm:dup-two"] }));
    writeCache(fixture.root, {
      version: 1,
      packages: {
        ...(options.oneUncached ? {} : { "dup-one": { tools: [], commands: [{ name: "cmd" }] } }),
        ...(options.twoUncached ? {} : { "dup-two": { tools: [], commands: (options.twoCommands ?? (options.twoCached === false ? [] : ["cmd"])).map((name) => ({ name })) } }),
      },
    });
    for (const [name, command] of Object.entries(options.preRegistered ?? {})) fixture.registeredCommands.set(name, command);
    process.env.PI_CODING_AGENT_DIR = fixture.root;
    lazyLoaderExtension(fixture.mockPi);
    await fixture.mockPi.emitSessionStart(options.sessionCtx);
    const names = () => JSON.stringify([...fixture.registeredCommands.keys()].filter((n) => n.startsWith("cmd")).sort());
    const run = (name: string, args: string) => fixture.registeredCommands.get(name).handler(args, { hasUI: false });
    return { fixture, names, run };
  };
  const prevDir = process.env.PI_CODING_AGENT_DIR;
  const fixtures: Array<{ cleanup(): void }> = [];
  try {
    {
      const { fixture, names, run } = await setupDup();
      fixtures.push(fixture);
      assert(names() === '["cmd:1","cmd:2"]', `expected two proxies, got ${names()}`);
      const two = await run("cmd:2", "x");
      assert(two === "two:x", `/cmd:2 must load dup-two despite its replayed skip-if-registered guard, got ${two}`);
      assert(names() === '["cmd:1","cmd:2"]', `loading dup-two must not rename commands, got ${names()}`);
      assert(fixture.registeredCommands.get("cmd:2").description.includes("target: dup-two"), "/cmd:2 must be the committed real command");
      assert(fixture.registeredCommands.get("cmd:1").description.includes("/cmd:1 [lazy target: dup-one"), "/cmd:1 must stay a proxy named /cmd:1");
      assert((await run("cmd:1", "y")) === "one:y", "/cmd:1 proxy must load dup-one");
      assert((await run("cmd:1", "z")) === "one:z", "committed /cmd:1 must run dup-one");
      assert((await run("cmd:2", "w")) === "two:w", "committed /cmd:2 must still run dup-two");
      assert(names() === '["cmd:1","cmd:2"]', `loading both must not rename commands, got ${names()}`);
      let listed = "";
      await fixture.registeredCommands.get("lazy").handler("list", { hasUI: true, ui: { notify(text: string) { listed = text; } } });
      assert(listed.includes("/cmd:1 [ready]") && listed.includes("/cmd:2 [ready]"), `/lazy list must show proxy names, got ${listed}`);
      console.log("  ✓ Duplicate lazy commands get /cmd:1 and /cmd:2 proxies that each load their own target without renaming");
    }
    {
      const eager = { description: "eager", handler() { return "eager"; } };
      const { fixture, names, run } = await setupDup({ preRegistered: { cmd: eager } });
      fixtures.push(fixture);
      assert(names() === '["cmd","cmd:2","cmd:3"]' && fixture.registeredCommands.get("cmd") === eager, `eager /cmd must move both proxies to /cmd:2 and /cmd:3, got ${names()}`);
      assert((await run("cmd:2", "x")) === "one:x", "/cmd:2 must load dup-one");
      assert((await run("cmd:3", "y")) === "two:y", "/cmd:3 must load dup-two despite the foreign /cmd and its skip-if-registered guard");
      assert(names() === '["cmd","cmd:2","cmd:3"]' && fixture.registeredCommands.get("cmd") === eager, `loading must keep the eager /cmd, got ${names()}`);
      const foreign = { description: "foreign cmd:1", handler() { return "foreign"; } };
      const second = await setupDup({ preRegistered: { "cmd:1": foreign } });
      fixtures.push(second.fixture);
      // A foreign /cmd:1 means Pi already suffixed a foreign /cmd; proxies take the next free names.
      assert(second.names() === '["cmd:1","cmd:2","cmd:3"]' && second.fixture.registeredCommands.get("cmd:1") === foreign, `foreign /cmd:1 must push proxies to /cmd:2 and /cmd:3, got ${second.names()}`);
      const single = createMockPackageFixture({ packageName: "dup-one", indexJs: oneJs });
      fixtures.push(single);
      writeFileSync(join(single.root, "lazy-loader.json"), JSON.stringify({ packages: ["npm:dup-one"] }));
      writeCache(single.root, { version: 1, packages: { "dup-one": { tools: [], commands: [{ name: "cmd" }] } } });
      single.registeredCommands.set("cmd", eager);
      process.env.PI_CODING_AGENT_DIR = single.root;
      lazyLoaderExtension(single.mockPi);
      const warnings: string[] = [];
      await single.mockPi.emitSessionStart({ hasUI: true, ui: { notify(message: string) { warnings.push(message); } } });
      assert(warnings.some((w) => w.includes('registering it as "/cmd:2"')), `rename must be reported in the startup warning, got ${JSON.stringify(warnings)}`);
      assert(single.registeredCommands.has("cmd:2") && single.registeredCommands.get("cmd") === eager, "single lazy /cmd behind a foreign /cmd must register as /cmd:2");
      assert((await single.registeredCommands.get("cmd:2").handler("z", { hasUI: false })) === "one:z", "/cmd:2 must load its package");
      // A cached literal "cmd:2" (dup-two) is not reused when dup-one's proxy moves off the foreign /cmd.
      const literal = await setupDup({
        preRegistered: { cmd: eager },
        twoCommands: ["cmd:2"],
        twoJs: `export default function (pi) { pi.registerCommand("cmd:2", { description: "two", async handler(args) { return "two:" + args; } }); }`,
      });
      fixtures.push(literal.fixture);
      assert(literal.names() === '["cmd","cmd:2","cmd:3"]', `renamed proxy must skip a cached literal /cmd:2, got ${literal.names()}`);
      assert((await literal.run("cmd:3", "x")) === "one:x", "/cmd:3 must load dup-one");
      assert((await literal.run("cmd:2", "y")) === "two:y", "literal /cmd:2 must load dup-two");
      assert(literal.fixture.registeredCommands.get("cmd") === eager, "foreign /cmd must remain");
      console.log("  ✓ Foreign owners of /cmd or /cmd:N push lazy proxies to free /cmd:N names");
    }
    {
      // Stale cache: dup-two's cmd is unknown, so dup-one alone owns /cmd and dup-two registers unreserved.
      // Unguarded factory that also re-registers on session_start replay: the bumped name must be reused.
      // (A skip-if-registered factory would simply yield /cmd to dup-one.)
      const twiceJs = `export default function (pi) {
    const register = () => pi.registerCommand("cmd", { description: "two", async handler(args) { return "two:" + args; } });
    register();
    pi.on("session_start", register);
  }`;
      const { fixture, names, run } = await setupDup({ twoCached: false, twoJs: twiceJs });
      fixtures.push(fixture);
      assert(names() === '["cmd"]', `only dup-one is proxied, got ${names()}`);
      const proxy = fixture.registeredCommands.get("cmd");
      await fixture.registeredCommands.get("lazy").handler("add dup-two", { hasUI: false });
      assert(fixture.registeredCommands.get("cmd") === proxy, "unreserved dup-two must not clobber dup-one's /cmd proxy");
      // The replayed session_start registers "cmd" again: it must reuse /cmd:2, not bump to /cmd:3.
      assert(names() === '["cmd","cmd:2"]', `unreserved duplicate must be bumped to /cmd:2 once, got ${names()}`);
      assert((await run("cmd:2", "x")) === "two:x", "bumped /cmd:2 must run dup-two");
      assert((await run("cmd", "y")) === "one:y", "/cmd must still load dup-one");
      assert(names() === '["cmd","cmd:2"]', `loading dup-one must not rename commands, got ${names()}`);
      console.log("  ✓ Unreserved late duplicates are bumped to a free /cmd:N instead of clobbering");
    }
    {
      // Eager /cmd moves dup-one's proxy to /cmd:2; stale dup-two must not take the foreign /cmd either.
      const eager = { description: "eager", handler() { return "eager"; } };
      const warnings: string[] = [];
      const sessionCtx = { hasUI: true, ui: { notify(message: string) { warnings.push(message); } } };
      const { fixture, names, run } = await setupDup({ sessionCtx, twoCached: false, twoJs: oneJs.replaceAll("one", "two"), preRegistered: { cmd: eager } });
      fixtures.push(fixture);
      warnings.length = 0;
      await fixture.registeredCommands.get("lazy").handler("add dup-two", { hasUI: false });
      assert(warnings.some((w) => w.includes('"dup-two" is already registered; registering it as "/cmd:3"')), `late rename must reach the UI, got ${JSON.stringify(warnings)}`);
      assert(names() === '["cmd","cmd:2","cmd:3"]' && fixture.registeredCommands.get("cmd") === eager, `foreign /cmd must bump unreserved late commands to a free /cmd:N, got ${names()}`);
      assert((await run("cmd:3", "x")) === "two:x", "bumped /cmd:3 must run dup-two");
      console.log("  ✓ Foreign owners bump unreserved late commands to a free /cmd:N");
    }
    {
      // Uncached dup-two is bootstrapped during session_start; dup-one's proxy must survive it.
      const { fixture, names, run } = await setupDup({ twoUncached: true, twoJs: oneJs.replaceAll("one", "two") });
      fixtures.push(fixture);
      assert(names() === '["cmd","cmd:2"]', `bootstrap must not suppress dup-one's /cmd proxy, got ${names()}`);
      assert((await run("cmd:2", "x")) === "two:x", "bootstrapped dup-two must own /cmd:2");
      assert((await run("cmd", "y")) === "one:y", "/cmd must load dup-one");
      console.log("  ✓ Bootstrapped uncached duplicates bump around startup proxies");
    }
    {
      // Foreign /cmd: dup-one's proxy rename and dup-two's bootstrap rename share one startup warning.
      const warnings: string[] = [];
      const sessionCtx = { hasUI: true, ui: { notify(message: string) { warnings.push(message); } } };
      const eager = { description: "eager", handler() { return "eager"; } };
      const { fixture, names } = await setupDup({ sessionCtx, preRegistered: { cmd: eager }, twoUncached: true, twoJs: oneJs.replaceAll("one", "two") });
      fixtures.push(fixture);
      assert(names() === '["cmd","cmd:2","cmd:3"]', `expected /cmd:2 proxy and /cmd:3 bootstrap rename, got ${names()}`);
      assert(
        warnings.length === 1 &&
          warnings[0].includes('"dup-one" is already registered; registering it as "/cmd:2"') &&
          warnings[0].includes('"dup-two" is already registered; registering it as "/cmd:3"'),
        `bootstrap renames must join the single startup warning, got ${JSON.stringify(warnings)}`
      );
      console.log("  ✓ Bootstrap renames join the single startup warning");
    }
    {
      // Every package keeps its rank between the bootstrap session and the following cached session.
      // Only the first holder changes, /cmd -> /cmd:1: a registered /cmd cannot be renamed mid-session.
      const nextSession = async (root: string, preRegistered: Record<string, any>) => {
        const session = createMockPi();
        for (const [name, command] of Object.entries(preRegistered)) session.registeredCommands.set(name, command);
        process.env.PI_CODING_AGENT_DIR = root;
        lazyLoaderExtension(session.mockPi);
        await session.mockPi.emitSessionStart();
        return session;
      };
      const eager = { description: "eager", handler() { return "eager"; } };
      const scenarios = [
        { options: { twoUncached: true, twoJs: oneJs.replaceAll("one", "two") }, pre: {}, bootstrap: { cmd: "one", "cmd:2": "two" }, cached: { "cmd:1": "one", "cmd:2": "two" } },
        { options: { oneUncached: true }, pre: {}, bootstrap: { cmd: "two", "cmd:2": "one" }, cached: { "cmd:1": "two", "cmd:2": "one" } },
        { options: { twoUncached: true, twoJs: oneJs.replaceAll("one", "two") }, pre: { cmd: eager }, bootstrap: { "cmd:2": "one", "cmd:3": "two" }, cached: { "cmd:2": "one", "cmd:3": "two" } },
      ];
      for (const { options, pre, bootstrap, cached } of scenarios) {
        const first = await setupDup({ ...options, preRegistered: pre });
        fixtures.push(first.fixture);
        const second = await nextSession(first.fixture.root, pre);
        for (const [label, commands, expected] of [["bootstrap", first.fixture.registeredCommands, bootstrap], ["cached", second.registeredCommands, cached]] as const) {
          const names = JSON.stringify([...commands.keys()].filter((n) => n.startsWith("cmd")).sort());
          const want = JSON.stringify([...Object.keys(pre), ...Object.keys(expected)].sort());
          assert(names === want, `${label} session names must be ${want}, got ${names}`);
          for (const [name, owner] of Object.entries(expected)) {
            const out = await commands.get(name).handler("x", { hasUI: false });
            assert(out === `${owner}:x`, `${label} session /${name} must run dup-${owner}, got ${out}`);
          }
        }
      }
      console.log("  ✓ Duplicate ranks are stable between the bootstrap session and later cached sessions");
    }
  } finally {
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevDir;
    for (const fixture of fixtures) fixture.cleanup();
  }
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
  "src/pi-host.ts",
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
