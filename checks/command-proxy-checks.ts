import { mkdirSync, rmSync, writeFileSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { MANIFEST, findManifestEntry } from "../src/manifest.js";
import {
  loadCommandConfig,
  mergeCommandDefinitions,
  validateUserConfig,
  validateManifestCommands,
  type MergedCommandDefinition,
  type UserCommandConfig,
} from "../src/command-config.js";
import {
  formatStartupDescription,
  formatPostLoadDescription,
} from "../src/command-presentation.js";
import { LazyLoader } from "../src/loader.js";
import lazyLoaderExtension from "../index.js";

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
// CHECK 6: Staged Commit Atomicity on Load Failure
// -----------------------------------------------------------------------------
console.log("--- Check 6: Staged Commit Atomicity on Load Failure ---");

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
  const loader = new LazyLoader(failFixture.mockPi, failFixture.root, false);
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
  const loader = new LazyLoader(dupFixture.mockPi, dupFixture.root, false);
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
  const loader = new LazyLoader(dupMultiFixture.mockPi, dupMultiFixture.root, false);
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
// CHECK 7: Command Readiness in Loader State
// -----------------------------------------------------------------------------
console.log("--- Check 7: Command Readiness in Loader State ---");

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
  const loader = new LazyLoader(readyFixture.mockPi, readyFixture.root, false);
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
// CHECK 8: Packaging Exact Allowlist & Clean Install Smoke
// -----------------------------------------------------------------------------
console.log("--- Check 8: Packaging Exact Allowlist & Clean Install Smoke ---");

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(currentDir, "..");
const pkgJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf-8")
);

// 8.1 package.json files array matches expected patterns
const expectedFilesField = ["index.ts", "manifest.json", "src", "README.md", "lazy-loader.schema.json"];
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
  "manifest.json",
  "package.json",
  "src/command-config.ts",
  "src/command-presentation.ts",
  "src/loader.ts",
  "src/manifest.ts",
  "src/resolver.ts",
  "src/settings.ts",
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
