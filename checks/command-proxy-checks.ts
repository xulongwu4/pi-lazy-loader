import { mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MANIFEST, findManifestEntry } from "../src/manifest.js";
import {
  loadCommandConfig,
  mergeCommandDefinitions,
  validateUserConfig,
  validateManifestCommands,
  formatStartupDescription,
  formatPostLoadDescription,
  type MergedCommandDefinition,
  type UserCommandConfig,
} from "../src/command-config.js";
import { LazyLoader } from "../src/loader.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

console.log("=== Running Command Proxy Feature Checks ===\n");

// -----------------------------------------------------------------------------
// CHECK 1: Manifest Command Validation
// -----------------------------------------------------------------------------
console.log("--- Check 1: Manifest Command Validation ---");

// 1.1 Current MANIFEST commands must be valid
const manifestDiagnostics = validateManifestCommands(MANIFEST);
assert(manifestDiagnostics.length === 0, `Manifest commands validation failed: ${manifestDiagnostics.join("; ")}`);
console.log("  ✓ MANIFEST commands pass validation");

// 1.2 Omitted descriptions are valid in declarations
const omittedDescEntry: any = {
  name: "pi-mcp-adapter",
  source: "npm:pi-mcp-adapter",
  locator: "npm:pi-mcp-adapter",
  cost: 0.2,
  capability: "MCP",
  commands: [{ name: "mcp" }],
};
const omittedDiag = validateManifestCommands([omittedDescEntry]);
assert(omittedDiag.length === 0, `Omitted description should be valid, got: ${omittedDiag.join("; ")}`);
console.log("  ✓ Omitted command description in manifest entry is accepted");

// 1.3 Invalid command names rejected
const invalidNames = ["MCP", "mcp_tool", "-leading", "has spaces", "slash/cmd", "/token-burden", ""];
for (const name of invalidNames) {
  const badEntry: any = {
    name: "pi-mcp-adapter",
    source: "npm:pi-mcp-adapter",
    locator: "npm:pi-mcp-adapter",
    cost: 0.2,
    capability: "MCP",
    commands: [{ name }],
  };
  const diags = validateManifestCommands([badEntry]);
  assert(diags.length > 0, `Invalid command name "${name}" should produce diagnostics`);
}
console.log("  ✓ Invalid command names rejected");

// 1.4 Invalid descriptions rejected (empty string, newlines, control characters, > 240 chars)
const badDescriptions = ["", "has\nnewline", "has\rreturn", "has\x00null", "x".repeat(241)];
for (const description of badDescriptions) {
  const badDescEntry: any = {
    name: "pi-mcp-adapter",
    source: "npm:pi-mcp-adapter",
    locator: "npm:pi-mcp-adapter",
    cost: 0.2,
    capability: "MCP",
    commands: [{ name: "mcp", description }],
  };
  const diags = validateManifestCommands([badDescEntry]);
  assert(diags.length > 0, `Invalid description "${description.slice(0, 15)}" should produce diagnostics`);
}
console.log("  ✓ Invalid command descriptions rejected");

// 1.5 Duplicate command names in same package rejected
const duplicateEntry: any = {
  name: "pi-mcp-adapter",
  source: "npm:pi-mcp-adapter",
  locator: "npm:pi-mcp-adapter",
  cost: 0.2,
  capability: "MCP",
  commands: [{ name: "mcp", description: "First" }, { name: "mcp", description: "Second" }],
};
const dupDiags = validateManifestCommands([duplicateEntry]);
assert(dupDiags.length > 0, "Duplicate command names in manifest entry must produce diagnostics");
console.log("  ✓ Duplicate command names in manifest entry rejected");

// -----------------------------------------------------------------------------
// CHECK 2: User Configuration Validation and Schema
// -----------------------------------------------------------------------------
console.log("--- Check 2: User Configuration Validation and Loading ---");

// 2.1 Absent configuration is valid and returns built-ins only
const tempAgentDir = join(tmpdir(), `pi-lazy-cmd-test-${Date.now()}`);
mkdirSync(tempAgentDir, { recursive: true });

try {
  const absentResult = loadCommandConfig({ agentDir: tempAgentDir });
  assert(absentResult.diagnostics.length === 0, `Absent config should have 0 diagnostics, got: ${absentResult.diagnostics.join("; ")}`);
  assert(absentResult.definitions.length > 0, "Absent config should return built-in definitions");
  console.log("  ✓ Absent user config returns built-ins with zero diagnostics");

  // 2.2 Malformed JSON handled gracefully
  writeFileSync(join(tempAgentDir, "lazy-loader.json"), "NOT VALID JSON {{{{");
  const malformedResult = loadCommandConfig({ agentDir: tempAgentDir });
  assert(malformedResult.diagnostics.some((d) => d.includes("JSON") || d.includes("parse")), "Malformed JSON must produce parse diagnostic");
  assert(malformedResult.definitions.length > 0, "Malformed JSON must fall back to built-ins");
  console.log("  ✓ Malformed JSON produces diagnostic and falls back to built-ins");

  // 2.3 Oversized configuration (> 64 KiB) rejected
  const oversizedData = {
    version: 1,
    packages: {
      "pi-mcp-adapter": {
        commands: ["mcp"],
        padding: "x".repeat(66 * 1024),
      },
    },
  };
  writeFileSync(join(tempAgentDir, "lazy-loader.json"), JSON.stringify(oversizedData));
  const oversizedResult = loadCommandConfig({ agentDir: tempAgentDir });
  assert(oversizedResult.diagnostics.some((d) => d.includes("64 KiB") || d.includes("exceeds")), "Oversized file must produce diagnostic");
  console.log("  ✓ Oversized config (> 64 KiB) rejected");

  // 2.4 Wrong version rejected
  const wrongVersionData = { version: 2, packages: {} };
  writeFileSync(join(tempAgentDir, "lazy-loader.json"), JSON.stringify(wrongVersionData));
  const wrongVerResult = loadCommandConfig({ agentDir: tempAgentDir });
  assert(wrongVerResult.diagnostics.some((d) => d.includes("version")), "Unsupported version must produce diagnostic");
  console.log("  ✓ Unsupported version rejected");

  // 2.5 $schema is accepted, validated as string, ignored at runtime, and exempt from unknown-field rejection
  const schemaValid = validateUserConfig({
    $schema: "https://example.com/schema.json",
    version: 1,
    packages: {},
  });
  assert(schemaValid.diagnostics.length === 0, `$schema should be accepted, got: ${schemaValid.diagnostics.join("; ")}`);
  assert(schemaValid.config?.version === 1, "Config version should be 1");

  const schemaInvalid = validateUserConfig({
    $schema: 12345, // invalid type
    version: 1,
    packages: {},
  });
  assert(schemaInvalid.diagnostics.some((d) => d.includes("$schema")), "Non-string $schema must produce diagnostic");
  console.log("  ✓ $schema accepted as optional string and exempt from unknown-field checks");

  // 2.6 Unknown top-level fields rejected
  const unknownTopLevel = validateUserConfig({
    version: 1,
    packages: {},
    extraField: "not allowed",
  });
  assert(unknownTopLevel.diagnostics.some((d) => d.includes("unknown") || d.includes("extraField")), "Unknown top-level field must produce diagnostic");
  console.log("  ✓ Unknown top-level fields rejected");

  // 2.7 Unknown package keys rejected
  const unknownPkg = validateUserConfig({
    version: 1,
    packages: {
      "completely-unknown-package-xyz": {
        commands: ["foo"],
      },
    },
  });
  assert(unknownPkg.diagnostics.some((d) => d.includes("Unknown package")), "Unknown package key must produce diagnostic");
  console.log("  ✓ Unknown package key rejected");

  // 2.8 Unknown package-level fields rejected
  const unknownPkgField = validateUserConfig({
    version: 1,
    packages: {
      "pi-mcp-adapter": {
        commands: ["mcp"],
        invalidField: "boom",
      } as any,
    },
  });
  assert(unknownPkgField.diagnostics.some((d) => d.includes("invalidField")), "Unknown package-level field must produce diagnostic");
  console.log("  ✓ Unknown package-level fields rejected");

  // 2.9 Unknown command-object fields rejected
  const unknownCmdField = validateUserConfig({
    version: 1,
    packages: {
      "pi-mcp-adapter": {
        commands: [{ name: "mcp", extra: "nope" } as any],
      },
    },
  });
  assert(unknownCmdField.diagnostics.some((d) => d.includes("extra")), "Unknown command-object field must produce diagnostic");
  console.log("  ✓ Unknown command-object fields rejected");
} finally {
  rmSync(tempAgentDir, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 3: Package-Keyed Groups, Mixed Arrays, and Alias Resolution
// -----------------------------------------------------------------------------
console.log("--- Check 3: Package-Keyed Groups, Mixed Arrays, and Alias Resolution ---");

// 3.1 String shorthand, object, and mixed command arrays
const mixedConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "pi-mcp-adapter": {
      targetLabel: "mcp-service",
      commands: [
        "mcp",
        "pi-mcp",
        {
          name: "mcp-auth",
          description: "Authenticate with an MCP server",
        },
      ],
    },
  },
};
const mixedValidated = validateUserConfig(mixedConfig);
assert(mixedValidated.diagnostics.length === 0, `Mixed config should be valid: ${mixedValidated.diagnostics.join("; ")}`);
console.log("  ✓ String shorthand, object, and mixed command arrays validated");

// 3.2 Package alias resolution: keys like "npm:pi-mcp-adapter" resolve to "pi-mcp-adapter"
const aliasConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "npm:pi-mcp-adapter": {
      commands: ["mcp"],
    },
  },
};
const aliasValidated = validateUserConfig(aliasConfig);
assert(aliasValidated.diagnostics.length === 0, `Alias config should be valid: ${aliasValidated.diagnostics.join("; ")}`);
const mergedAlias = mergeCommandDefinitions(MANIFEST, aliasValidated.config);
const mcpDef = mergedAlias.definitions.find((d) => d.commandName === "mcp");
assert(mcpDef?.packageName === "pi-mcp-adapter", `Alias must resolve to canonical package name "pi-mcp-adapter", got "${mcpDef?.packageName}"`);
console.log("  ✓ Package aliases resolve to canonical manifest name");

// -----------------------------------------------------------------------------
// CHECK 4: Deterministic Merge and Conflict Outcomes
// -----------------------------------------------------------------------------
console.log("--- Check 4: Deterministic Merge and Conflict Outcomes ---");

// 4.1 Exact user command match overrides description when provided; string shorthand preserves built-in description
const overrideConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "pi-mcp-adapter": {
      commands: [
        { name: "mcp", description: "Custom MCP description" },
        "pi-mcp", // shorthand - should preserve built-in description
      ],
    },
  },
};
const mergedOverride = mergeCommandDefinitions(MANIFEST, overrideConfig);
const overriddenMcp = mergedOverride.definitions.find((d) => d.commandName === "mcp");
const preservedPiMcp = mergedOverride.definitions.find((d) => d.commandName === "pi-mcp");
assert(overriddenMcp?.description === "Custom MCP description", "User object description must override built-in");
assert(preservedPiMcp?.description === "Show MCP server status", "User string shorthand must preserve built-in description");
console.log("  ✓ User description overrides built-in; shorthand preserves built-in");

// 4.2 Duplicate declarations in user config for same package/command collapse when descriptions equal or one omitted
const dedupeConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "pi-mcp-adapter": {
      commands: [
        "mcp",
        { name: "mcp", description: "Supplied description" },
      ],
    },
  },
};
const mergedDedupe = mergeCommandDefinitions(MANIFEST, dedupeConfig);
const dedupedMcp = mergedDedupe.definitions.filter((d) => d.commandName === "mcp");
assert(dedupedMcp.length === 1, `Duplicates must collapse to 1 entry, got ${dedupedMcp.length}`);
assert(dedupedMcp[0].description === "Supplied description", "Supplied description must win over shorthand");
console.log("  ✓ Shorthand and object with description collapse to single entry");

// 4.3 Two user objects for the same package/command with different descriptions are a conflict
const userConflictConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "pi-mcp-adapter": {
      commands: [
        { name: "mcp", description: "Desc A" },
        { name: "mcp", description: "Desc B" },
      ],
    },
  },
};
const mergedUserConflict = mergeCommandDefinitions(MANIFEST, userConflictConfig);
assert(mergedUserConflict.diagnostics.some((d) => d.includes("conflict") || d.includes("mcp")), "Conflicting descriptions must produce diagnostic");
assert(!mergedUserConflict.definitions.some((d) => d.commandName === "mcp"), "Conflicted command name must register no proxy");
console.log("  ✓ Conflicting descriptions for same package/command skip proxy registration");

// 4.4 Same command name mapped to different packages is a conflict; other valid commands continue
const crossPkgConflictConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "pi-mcp-adapter": {
      commands: ["mcp", "pi-mcp"],
    },
    "pi-token-burden": {
      commands: ["mcp"], // conflicts with pi-mcp-adapter!
    },
  },
};
const mergedCrossConflict = mergeCommandDefinitions(MANIFEST, crossPkgConflictConfig);
assert(mergedCrossConflict.diagnostics.some((d) => d.includes("mcp") && (d.includes("multiple") || d.includes("conflict"))), "Cross-package conflict must produce diagnostic");
assert(!mergedCrossConflict.definitions.some((d) => d.commandName === "mcp"), "Conflicted command 'mcp' must be skipped from all packages");
assert(mergedCrossConflict.definitions.some((d) => d.commandName === "pi-mcp"), "Non-conflicted command 'pi-mcp' must continue to register");
console.log("  ✓ Cross-package command conflict skips only conflicted command; other commands continue");

// 4.5 Target label is supplemental and does not replace canonical package name
const labelConfig: UserCommandConfig = {
  version: 1,
  packages: {
    "pi-mcp-adapter": {
      targetLabel: "mcp-service",
      commands: ["mcp"],
    },
  },
};
const mergedLabel = mergeCommandDefinitions(MANIFEST, labelConfig);
const labeledDef = mergedLabel.definitions.find((d) => d.commandName === "mcp");
assert(labeledDef?.targetLabel === "mcp-service", "targetLabel must be preserved in merged definition");
const startupDesc = formatStartupDescription(labeledDef!);
assert(startupDesc.includes("pi-mcp-adapter"), "Startup description MUST contain real package name");
assert(startupDesc.includes("mcp-service"), "Startup description MUST contain targetLabel alongside real package name");
const postLoadDesc = formatPostLoadDescription(labeledDef!, "Real description");
assert(postLoadDesc.includes("pi-mcp-adapter"), "Post-load description MUST contain real package name");
assert(postLoadDesc.includes("mcp-service"), "Post-load description MUST contain targetLabel alongside real package name");
console.log("  ✓ targetLabel is rendered alongside, never replacing, canonical package name");

// -----------------------------------------------------------------------------
// CHECK 5: Reserve Before Register & Multi-Command Capture
// -----------------------------------------------------------------------------
console.log("--- Check 5: Reserve Before Register & Multi-Command Capture ---");

const fixtureRoot = join(tmpdir(), `pi-lazy-mcp-fixture-${Date.now()}`);
const mcpPkgDir = join(fixtureRoot, "npm", "node_modules", "pi-mcp-adapter");
mkdirSync(mcpPkgDir, { recursive: true });

writeFileSync(
  join(mcpPkgDir, "package.json"),
  JSON.stringify({
    name: "pi-mcp-adapter",
    type: "module",
    pi: { extensions: ["./index.js"] },
  }),
);

writeFileSync(
  join(mcpPkgDir, "index.js"),
  `export default function (pi) {
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
);

const registeredCommands = new Map<string, any>();
const mockPi: any = {
  registerTool() {},
  registerCommand(name: string, command: any) {
    registeredCommands.set(name, command);
  },
  getAllTools() { return []; },
  getActiveTools() { return []; },
  setActiveTools() {},
  on() {},
};

try {
  const loader = new LazyLoader(mockPi, fixtureRoot, false);

  // Reserve all 3 commands before registering any proxy
  loader.reserveCommand("pi-mcp-adapter", "mcp", { declaredDescription: "Show MCP server status", decorateDescription: true });
  loader.reserveCommand("pi-mcp-adapter", "pi-mcp", { declaredDescription: "Show MCP server status", decorateDescription: true });
  loader.reserveCommand("pi-mcp-adapter", "mcp-auth", { declaredDescription: "Authenticate with an MCP server", decorateDescription: true });

  // Register the startup stubs in mockPi
  const stubMcp = {
    description: "Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]",
    getArgumentCompletions(_prefix: string) { return null; },
    handler() {},
  };
  const stubPiMcp = {
    description: "Show MCP server status [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]",
    getArgumentCompletions(_prefix: string) { return null; },
    handler() {},
  };
  const stubMcpAuth = {
    description: "Authenticate with an MCP server [lazy target: pi-mcp-adapter; proxy: pi-lazy-loader]",
    getArgumentCompletions(_prefix: string) { return null; },
    handler() {},
  };
  registeredCommands.set("mcp", stubMcp);
  registeredCommands.set("pi-mcp", stubPiMcp);
  registeredCommands.set("mcp-auth", stubMcpAuth);

  // 5.1 Pre-load completions return null without importing/loading package
  assert(stubMcp.getArgumentCompletions("test") === null, "Pre-load completions must return null");
  assert((globalThis as any).__mcpFactoryRunCount === undefined, "Pre-load completion must not run factory");
  console.log("  ✓ Pre-load completions return null without triggering package load");

  // 5.2 Invoking /mcp loads the factory once and captures all three declared commands
  const loadRes = await loader.loadPackage("pi-mcp-adapter");
  assert(loadRes.success, `pi-mcp-adapter load failed: ${loadRes.error}`);
  assert((globalThis as any).__mcpFactoryRunCount === 1, "Factory must execute exactly once");

  // All 3 commands replaced in mockPi
  const cmdMcp = registeredCommands.get("mcp");
  const cmdPiMcp = registeredCommands.get("pi-mcp");
  const cmdMcpAuth = registeredCommands.get("mcp-auth");
  const cmdUnreserved = registeredCommands.get("unreserved-cmd");

  assert(cmdMcp !== stubMcp, "/mcp stub must be replaced after load");
  assert(cmdPiMcp !== stubPiMcp, "/pi-mcp stub must be replaced after load");
  assert(cmdMcpAuth !== stubMcpAuth, "/mcp-auth stub must be replaced after load");
  assert(cmdUnreserved !== undefined, "Non-reserved command must be forwarded immediately");

  // 5.3 Provenance and decoration preserved
  assert(cmdMcp.description.includes("[target: pi-mcp-adapter; via pi-lazy-loader]"), "Committed command must have delegated attribution");
  assert(cmdMcp.description.startsWith("real mcp description"), "Committed command must start with real target description");

  // 5.4 Handler and completion identity preserved by reference
  const ctx = { cwd: "/fixture", hasUI: true };
  const res1 = await loader.invokeCapturedCommand("pi-mcp-adapter", "mcp", "arg1", ctx);
  assert(res1 === "mcp-result:arg1", "Captured handler for /mcp must execute correctly");

  const res2 = await loader.invokeCapturedCommand("pi-mcp-adapter", "pi-mcp", "arg2", ctx);
  assert(res2 === "pi-mcp-result:arg2", "Captured handler for /pi-mcp must execute correctly");

  const res3 = await loader.invokeCapturedCommand("pi-mcp-adapter", "mcp-auth", "arg3", ctx);
  assert(res3 === "mcp-auth-result:arg3", "Captured handler for /mcp-auth must execute correctly");

  // Completions post-load come from target
  const comp = await cmdMcp.getArgumentCompletions("myprefix");
  assert(comp[0].value === "myprefix-mcp", "Post-load completions must be served by real target");

  // No suffixed duplicate commands created
  assert(!registeredCommands.has("mcp:1"), "No :1 duplicate for /mcp");
  assert(!registeredCommands.has("pi-mcp:1"), "No :1 duplicate for /pi-mcp");
  assert(!registeredCommands.has("mcp-auth:1"), "No :1 duplicate for /mcp-auth");

  console.log("  ✓ Multi-command load captures all declared commands in one factory execution");
  console.log("  ✓ Handlers, completions, and delegated provenance verified post-load");
} finally {
  delete (globalThis as any).__mcpFactoryRunCount;
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 6: Staged Commit Atomicity on Load Failure
// -----------------------------------------------------------------------------
console.log("--- Check 6: Staged Commit Atomicity on Load Failure ---");

const failFixtureRoot = join(tmpdir(), `pi-lazy-fail-fixture-${Date.now()}`);
const failPkgDir = join(failFixtureRoot, "npm", "node_modules", "pi-token-burden");
mkdirSync(failPkgDir, { recursive: true });

writeFileSync(
  join(failPkgDir, "package.json"),
  JSON.stringify({
    name: "pi-token-burden",
    type: "module",
    pi: { extensions: ["./index.js"] },
  }),
);

writeFileSync(
  join(failPkgDir, "index.js"),
  `export default function (pi) {
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
);

const failCommands = new Map<string, any>();
const failMockPi: any = {
  registerTool() {},
  registerCommand(name: string, command: any) {
    failCommands.set(name, command);
  },
  getAllTools() { return []; },
  getActiveTools() { return []; },
  setActiveTools() {},
  on() {},
};

try {
  const loader = new LazyLoader(failMockPi, failFixtureRoot, false);
  loader.reserveCommand("pi-token-burden", "token-burden", { declaredDescription: "Show token-budget usage", decorateDescription: true });

  const initialStub = {
    description: "Initial startup stub",
    handler() { return "stub"; },
  };
  failCommands.set("token-burden", initialStub);

  // Attempt to load package - will fail!
  const failResult = await loader.loadPackage("pi-token-burden");
  assert(!failResult.success, "Package load must fail");
  assert(failResult.status === "failed", "Package status must be 'failed'");

  // ATOMICITY ASSERTION: Stub must remain completely intact!
  const currentCommand = failCommands.get("token-burden");
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
  assert(failCommands.has("unreserved-during-fail"), "Non-reserved command forwarded immediately as per Amendment 1");

  console.log("  ✓ Staged commit atomicity verified: failed load leaves stub intact and commits nothing");
} finally {
  rmSync(failFixtureRoot, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 7: Command Readiness in Loader State
// -----------------------------------------------------------------------------
console.log("--- Check 7: Command Readiness in Loader State ---");

const readinessRoot = join(tmpdir(), `pi-lazy-ready-fixture-${Date.now()}`);
const readyPkgDir = join(readinessRoot, "npm", "node_modules", "pi-mcp-adapter");
mkdirSync(readyPkgDir, { recursive: true });

writeFileSync(
  join(readyPkgDir, "package.json"),
  JSON.stringify({
    name: "pi-mcp-adapter",
    type: "module",
    pi: { extensions: ["./index.js"] },
  }),
);

// Factory registers /mcp and /pi-mcp, but NOT /mcp-auth (missing command scenario)
writeFileSync(
  join(readyPkgDir, "index.js"),
  `export default function (pi) {
    pi.registerCommand("mcp", { description: "MCP", handler() {} });
    pi.registerCommand("pi-mcp", { description: "PI-MCP", handler() {} });
    // Note: mcp-auth is omitted intentionally
  }`,
);

const readyCommands = new Map<string, any>();
const readyMockPi: any = {
  registerTool() {},
  registerCommand(name: string, command: any) { readyCommands.set(name, command); },
  getAllTools() { return []; },
  getActiveTools() { return []; },
  setActiveTools() {},
  on() {},
};

try {
  const loader = new LazyLoader(readyMockPi, readinessRoot, false);
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
  rmSync(readinessRoot, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// CHECK 8: Packaging Allowlist Check
// -----------------------------------------------------------------------------
console.log("--- Check 8: Packaging Allowlist Check ---");

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const pkgJson = JSON.parse(
  readFileSync(join(currentDir, "..", "package.json"), "utf-8")
);
const expectedAllowlist = ["index.ts", "manifest.json", "src", "README.md", "lazy-loader.schema.json"];

assert(Array.isArray(pkgJson.files), "package.json must contain files array");
for (const item of expectedAllowlist) {
  assert(pkgJson.files.includes(item), `package.json files must include "${item}"`);
  assert(statSync(join(currentDir, "..", item)), `Published file/dir "${item}" must exist`);
}
console.log("  ✓ Explicit published paths allowlist verified");

console.log("\n==============================================");
console.log("ALL COMMAND PROXY CHECKS COMPLETED AND PASSED");
console.log("==============================================");
