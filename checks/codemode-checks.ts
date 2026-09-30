import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import lazyLoaderExtension from "../index.js";
import { CACHE_FILENAME, readCache } from "../src/cache.js";
import { registerToolProxies } from "../src/tool-proxy.js";
import { packageFingerprint } from "../src/resolver.js";
import { fakePi } from "./fake-pi.js";

const root = mkdtempSync(join(tmpdir(), "pi-lazy-codemode-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const parameters = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
const outputSchema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
const namespace = { name: "fixture", description: "Fixture namespace" };
const annotations = { readOnlyHint: true, destructiveHint: false };
const textOf = (result: any) => result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");

async function open(
  agentDir: string, mode: "on" | "only", defaultTools = ["+codemode"],
  toolOptions: Pick<CreateAgentSessionOptions, "noTools" | "tools" | "excludeTools"> = {},
) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.inMemory({
    defaultTools, codemode: { mode }, cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ mode, models: false }), (pi) => { lazyLoaderExtension(pi); }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: agentDir, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(agentDir), ...toolOptions,
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  // Supply the issuing message, but use real QuickJS and Pi nested-tool validation/events. No model calls.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  session.agent.state.messages.push({
    role: "assistant", content: [], api: "openai-responses", provider: "test", model: "test",
    stopReason: "toolUse", usage, timestamp: Date.now(),
  });
  return session;
}

try {
  for (const mode of ["on", "only"] as const) {
    for (const kind of ["direct", "model-only", "codemode", "deferred", "hidden", "inactive", "prepareLoadout", "non-json"]) {
      const agentDir = join(root, mode, kind);
      const fixture = join(agentDir, "fixture");
      mkdirSync(fixture, { recursive: true });
      const trace = join(agentDir, "trace");
      const metadata = {
        exposure: ["inactive", "prepareLoadout", "non-json"].includes(kind) ? "direct" : kind,
        ...(kind === "inactive" ? { defaultActive: false } : {}),
        outputSchema, namespace, annotations,
      };
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", type: "module", pi: { extensions: ["index.ts"] } }));
      writeFileSync(join(fixture, "index.ts"), `
import { appendFileSync } from "node:fs";
export default function(pi) {
  const mark = value => appendFileSync(${JSON.stringify(trace)}, value + "\\n");
  mark("load");
  pi.on("session_start", () => mark("start"));
  pi.registerCommand("probe-command", { description: "Probe command", handler: async args => mark("command:" + args) });
  pi.registerTool({
    name: "probe", label: "Probe", description: "Probe tool",
    parameters: ${JSON.stringify(parameters)}, ...${JSON.stringify(metadata)},
    ${kind === "prepareLoadout" ? "prepareLoadout: () => ({ descriptions: { probe: 'Prepared probe' } })," : ""}
    ${kind === "non-json" ? "outputSchema: { ..."+JSON.stringify(outputSchema)+", '~refine': () => true }," : ""}
    async execute(id, params) {
      mark("execute");
      return { content: [{ type: "text", text: "answer:" + params.value }], details: {},
        structuredContent: { answer: params.value } };
    }
  });
}
`);
      writeFileSync(join(agentDir, "lazy-loader.json"), JSON.stringify({ packages: [fixture] }));
      let session = await open(agentDir, mode);
      session.dispose();
      assert.equal(readFileSync(trace, "utf8"), "load\nstart\n");
      const cache = readCache(agentDir);
      assert.equal(cache.version, 2, "old metadata-incomplete caches must be invalidated");
      writeFileSync(trace, "");
      session = await open(agentDir, mode);
      try {
        const eager = kind === "prepareLoadout" || kind === "non-json";
        assert.equal(readFileSync(trace, "utf8"), eager ? "load\nstart\n" : "", "only unserializable contracts need eager loading");
        const tool = session.getToolDefinition("probe")!;
        if (kind === "prepareLoadout") assert.equal(typeof tool.prepareLoadout, "function");
        for (const [key, value] of Object.entries(metadata)) {
          if (!(kind === "non-json" && key === "outputSchema")) assert.deepEqual((tool as any)[key], value, key);
        }
        const active = kind === "direct" || kind === "model-only" || eager;
        assert.equal(session.getActiveToolNames().includes("probe"), active);
        const callable = !["hidden", "model-only", "inactive"].includes(kind);
        assert.equal(session.getCallableToolNames().includes("probe"), callable);
        const code = session.agent.state.tools.find(tool => tool.name === "codemode")!;
        const run = (source: string) => code.execute("probe-call", { code: source }, new AbortController().signal);
        if (!callable) {
          const denied = await run("await tools.probe({value:42});");
          assert.ok(denied.isError, "non-callable proxy must not execute");
          assert.equal(readFileSync(trace, "utf8"), "", "denied calls must not load the package");
          if (kind === "inactive") {
            session.setActiveToolsByName([...session.getActiveToolNames(), "probe"]);
            const activated = await run("text((await tools.probe({value:45})).answer);");
            assert.match(textOf(activated), /45/);
            assert.equal(readFileSync(trace, "utf8"), "load\nstart\nexecute\n");
          }
        } else {
          const first = await run("const values = await Promise.all([tools.probe({value:42}), tools.probe({value:43})]); text(values.map(v => v.answer));");
          assert.equal(first.isError, undefined, textOf(first));
          assert.match(textOf(first), /42.*43/s, "first calls must return structured objects");
          const again = await run("text((await tools.probe({value:44})).answer);");
          assert.match(textOf(again), /44/);
          assert.equal(readFileSync(trace, "utf8"), "load\nstart\nexecute\nexecute\nexecute\n");
          await session.prompt("/probe-command hello");
          assert.match(readFileSync(trace, "utf8"), /command:hello/);
        }
      } finally {
        session.dispose();
      }
      console.log(`PASS native codemode ${mode}: ${kind}`);
    }
  }

  // Explicit startup selections must also apply to proxies registered during session_start.
  for (const mode of ["on", "only"] as const) {
    for (const defaultTools of [["+codemode", "+probe"], ["codemode", "probe"], ["+probe", "-probe"], ["+probe", "-probe", "+probe"], ["-probe", "probe"]]) {
      // Plain names are seeded first; +/- modifiers are then applied in order by Pi.
      const selected = !defaultTools.includes("-probe") || defaultTools.at(-1) === "+probe";
      const agentDir = join(root, mode, "inactive");
      const session = await open(agentDir, mode, defaultTools);
      try {
        assert.equal(session.getActiveToolNames().includes("probe"), selected, JSON.stringify(defaultTools));
        assert.equal(session.getCallableToolNames().includes("probe"), selected);
      } finally {
        session.dispose();
      }
    }
    for (const kind of ["hidden", "model-only", "inactive"]) {
      const excluded = kind === "inactive" ? ["probe"] : undefined;
      const session = await open(join(root, mode, kind), mode, ["+codemode", "+probe"], { excludeTools: excluded });
      try {
        assert.equal(session.getActiveToolNames().includes("probe"), kind === "model-only");
        assert.equal(session.getCallableToolNames().includes("probe"), false);
      } finally {
        session.dispose();
      }
    }
    const coldDir = join(root, mode, "inactive");
    rmSync(join(coldDir, CACHE_FILENAME));
    const cold = await open(coldDir, mode, ["+codemode", "+probe"]);
    try {
      assert.equal(cold.getActiveToolNames().includes("probe"), true);
      assert.equal(cold.getCallableToolNames().includes("probe"), true);
    } finally {
      cold.dispose();
    }
  }
  console.log("PASS explicit startup selection, cold cache, exposure and host exclusions");

  for (const mode of ["on", "only"] as const) {
    const agentDir = join(root, mode, "inactive");
    const disabled = await open(agentDir, mode, ["+codemode", "+probe"]);
    const enabled = await open(agentDir, mode);
    try {
      disabled.setActiveToolsByName(disabled.getActiveToolNames().filter(name => name !== "probe"));
      enabled.setActiveToolsByName([...enabled.getActiveToolNames(), "probe"]);
      // Separate sessions in one process must not overwrite each other’s reload selections.
      for (let pass = 0; pass < 2; pass++) {
        await Promise.all([disabled.reload(), enabled.reload()]);
        assert.equal(disabled.getActiveToolNames().includes("probe"), false, "reload must not reactivate a disabled tool");
        assert.equal(enabled.getActiveToolNames().includes("probe"), true, "reload must retain explicitly activated tools");
      }
    } finally {
      disabled.dispose();
      enabled.dispose();
    }
  }
  console.log("PASS reload activation retention and session isolation");

  // Pi 0.99.1 CLI --no-tools maps to the SDK string "all", not the unsupported boolean true.
  for (const mode of ["on", "only"] as const) {
    for (const kind of ["direct", "inactive", "hidden", "codemode", "deferred"]) {
      const agentDir = join(root, mode, kind);
      for (const cold of [false, true]) {
        if (cold) rmSync(join(agentDir, CACHE_FILENAME));
        const session = await open(agentDir, mode, ["+codemode", "+probe"], { noTools: "all" });
        try {
          assert.deepEqual(session.getActiveToolNames(), []);
          assert.deepEqual(session.getCallableToolNames(), []);
          await session.reload();
          assert.deepEqual(session.getActiveToolNames(), []);
          assert.deepEqual(session.getCallableToolNames(), []);
        } finally {
          session.dispose();
        }
      }
    }
    const session = await open(join(root, mode, "inactive"), mode, [], { tools: ["codemode", "probe"] });
    try {
      assert.equal(session.getActiveToolNames().includes("probe"), true);
      assert.equal(session.getCallableToolNames().includes("probe"), true);
      assert.equal(session.getAllTools().some(tool => tool.name === "read"), false);
    } finally {
      session.dispose();
    }
  }
  console.log("PASS CLI-equivalent --no-tools and explicit --tools on cold/warm caches and reload");

  // Corrupt policy must invalidate the package, not default a hidden tool to direct exposure.
  const corruptDir = join(root, "only", "hidden");
  const validCache = readCache(corruptDir);
  for (const [field, values] of Object.entries({ exposure: [42, null, true, "", "typo"], defaultActive: ["no", null, 0, {}] })) {
    for (const value of values) {
      const corrupt = structuredClone(validCache);
      (corrupt.packages.fixture.tools[0] as any)[field] = value;
      writeFileSync(join(corruptDir, CACHE_FILENAME), JSON.stringify(corrupt));
      assert.equal(readCache(corruptDir).packages.fixture, undefined, `${field}=${JSON.stringify(value)}`);
      const session = await open(corruptDir, "only", ["+codemode", "+probe"]);
      try {
        assert.equal(session.getToolDefinition("probe")?.exposure, "hidden");
        assert.equal(session.getCallableToolNames().includes("probe"), false);
        assert.equal(readCache(corruptDir).packages.fixture.tools[0].exposure, "hidden");
      } finally {
        session.dispose();
      }
    }
  }
  console.log("PASS corrupt cache policy is rebuilt without exposing hidden tools");

  // A structured tool must reject non-executing paths rather than silently returning text.
  for (const mode of ["on", "only"] as const) {
    const agentDir = join(root, mode, "direct");
    const fixturePath = join(agentDir, "fixture/index.ts");
    const original = readFileSync(fixturePath, "utf8");
    const baseline = readCache(agentDir);
    for (const reason of ["schema-drift", "prepareLoadout", "missing", "failed"]) {
      const stale = structuredClone(baseline);
      if (reason === "schema-drift") stale.packages.fixture.tools[0].outputSchema = { type: "string" };
      const source = reason === "failed" ? 'export default function() { throw new Error("broken fixture"); }'
        : reason === "missing" ? original.replace('name: "probe"', 'name: "replacement"')
        : reason === "prepareLoadout" ? original.replace('name: "probe"', 'prepareLoadout: () => ({}), name: "probe"')
        : original;
      writeFileSync(fixturePath, source);
      // Simulate drift the startup fingerprint cannot see, so the first-call fallback is exercised.
      stale.packages.fixture.fingerprint = packageFingerprint(join(agentDir, "fixture"), agentDir);
      writeFileSync(join(agentDir, CACHE_FILENAME), JSON.stringify(stale));
      writeFileSync(join(agentDir, "trace"), "");
      const session = await open(agentDir, mode);
      try {
        const code = session.agent.state.tools.find(tool => tool.name === "codemode")!;
        const run = () => code.execute("structured-handoff", { code: "text((await tools.probe({value:42})).answer);" }, new AbortController().signal);
        const result = await run();
        assert.equal(result.isError, true, `${reason}: ${textOf(result)}`);
        assert.match(textOf(result), /not executed|cache is stale|failed to load/);
        assert.equal(readFileSync(join(agentDir, "trace"), "utf8").includes("execute"), false);
        if (reason === "schema-drift" || reason === "prepareLoadout") {
          const retry = await run();
          assert.equal(retry.isError, undefined, textOf(retry));
          assert.match(textOf(retry), /42/);
        }
      } finally {
        session.dispose();
        writeFileSync(fixturePath, original);
        writeFileSync(join(agentDir, CACHE_FILENAME), JSON.stringify(baseline));
      }
    }
  }
  console.log("PASS structured-output handoff, newly added prepareLoadout, missing tool and load errors");

  // A stale cache must never invoke a tool whose visibility/output contract changed.
  for (const field of ["exposure", "defaultActive", "outputSchema", "namespace", "annotations"]) {
    const pi = fakePi();
    const registration = { name: "probe", parameters, outputSchema, namespace, annotations, exposure: "direct", defaultActive: true };
    const changed = { exposure: "hidden", defaultActive: false, outputSchema: { type: "string" }, namespace: { name: "changed" }, annotations: { destructiveHint: true } };
    let executions = 0;
    const live = { ...registration, [field]: changed[field as keyof typeof changed], execute: () => { executions++; } };
    const loader = {
      getPackageState: () => ({ status: "deferred" }), reserveTool() {},
      loadPackage: async () => ({ success: true }), getCapturedTool: () => live,
      invokeCapturedTool: () => live.execute(),
    };
    registerToolProxies(pi, loader as any, [{ name: "fixture", source: "fixture" }], {
      version: 2, packages: { fixture: { tools: [registration], commands: [] } },
    });
    const result = await pi.tools.get("probe").execute("drift", { value: 1 });
    assert.equal(executions, 0, field);
    assert.equal(result.details.executed, false, field);
  }

  // Legacy caches lack exposure information: bootstrap again, never publish an unsafe proxy.
  const legacyDir = join(root, "only", "hidden");
  const legacy = readCache(legacyDir);
  writeFileSync(join(legacyDir, CACHE_FILENAME), JSON.stringify({ ...legacy, version: 1 }));
  writeFileSync(join(legacyDir, "trace"), "");
  assert.deepEqual(readCache(legacyDir), { version: 2, packages: {} });
  const migrated = await open(legacyDir, "only");
  try {
    assert.equal(readFileSync(join(legacyDir, "trace"), "utf8"), "load\nstart\n");
    assert.equal(readCache(legacyDir).version, 2);
    assert.equal(migrated.getToolDefinition("probe")?.exposure, "hidden");
    assert.equal(migrated.getCallableToolNames().includes("probe"), false);
  } finally {
    migrated.dispose();
  }
  console.log("PASS metadata drift and legacy cache migration");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
