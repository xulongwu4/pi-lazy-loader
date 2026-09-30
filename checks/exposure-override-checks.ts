// Per-package toolExposure overrides: config parsing, the shared policy, and prompt-prefix parity
// across startup proxies, first load, late registrations and /reload in real Pi sessions.
// Run: bun checks/exposure-override-checks.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  collapseSystemMessages, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, hasNonAdditiveToolChanges, hasToolRedefinitions,
} from "@earendil-works/pi-ai";
import lazyLoaderExtension from "../index.js";
import { readCache } from "../src/cache.js";
import { readLazyLoaderConfig } from "../src/config.js";
import { effectiveExposure } from "../src/package.js";

const root = mkdtempSync(join(tmpdir(), "pi-lazy-override-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const strip = (m: any) => JSON.stringify(m, (k, v) => (k === "timestamp" ? undefined : v));
type Mode = "on" | "only";

async function open(agentDir: string, mode: Mode) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const faux = fauxProvider({ provider: "probe", api: "probe-api", models: [{ id: "probe" }] });
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+codemode"], codemode: { mode }, cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      (pi) => { pi.registerProvider(faux.provider); },
      createCodemodeExtension({ mode, models: false }),
      (pi) => { lazyLoaderExtension(pi); },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: agentDir, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(agentDir),
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  await session.setModel(faux.getModel());

  const requests: any[][] = [];
  const reply = (make: () => any) => (ctx: any) => { requests.push(ctx.messages); return make(); };
  const text = (s: string) => reply(() => fauxAssistantMessage(fauxText(s)));
  const say = async (message: string) => { faux.setResponses([text("ok")]); await session.prompt(message); };
  /** One model tool call; returns that call's tool-result text. */
  const call = async (name: string, args: any) => {
    faux.setResponses([reply(() => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })), text("done")]);
    await session.prompt(`call ${name}`);
    const result = session.agent.state.messages.filter((m: any) => m.role === "toolResult").at(-1) as any;
    return result.content.map((c: any) => c.text).join("");
  };
  const code = (source: string) => call("codemode", { code: source });
  return { session, requests, say, call, code };
}

function assertStable(requests: any[][], label: string) {
  assert(requests.length > 1, `${label}: no requests captured`);
  const appendOnly = requests.slice(1).every((next, i) => requests[i].every((m, j) => strip(m) === strip(next[j])));
  const deltas = requests.flatMap((msgs) => msgs.slice(1)
    .filter((m: any) => m.role === "system" && (m.toolsAdded?.length || m.toolsRemoved?.length)));
  const collapsed = new Set(requests.map((msgs) => strip(collapseSystemMessages({ messages: msgs } as any).messages[0]))).size;
  const nativeDeltaOk = !hasToolRedefinitions(requests.at(-1)!) && !hasNonAdditiveToolChanges(requests.at(-1)!);
  assert(appendOnly, `${label}: loading must preserve the existing request prefix`);
  assert.equal(deltas.length, 0, `${label}: loading must not redeclare tools`);
  assert.equal(collapsed, 1, `${label}: collapsed system prefix must remain identical`);
  assert.equal(nativeDeltaOk, true, `${label}: loading must preserve native delta compatibility`);
}

/** Fixture package: "probe" (live exposure under test), "trigger" (codemode, never overridden),
 *  and optionally "late", registered on the first trigger call, i.e. after the load commit. */
function setup(name: string, live: string, toolExposure?: Record<string, string>, withLate = false) {
  const agentDir = join(root, name);
  const fixture = join(agentDir, "fixture");
  const trace = join(agentDir, "trace");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", type: "module", pi: { extensions: ["index.ts"] } }));
  writeFileSync(join(fixture, "index.ts"), `import { appendFileSync } from "node:fs";
export default function(pi) {
  const mark = v => appendFileSync(${JSON.stringify(trace)}, v + "\\n");
  mark("load");
  let late = ${!withLate};
  const tool = (name, exposure, before) => pi.registerTool({ name, label: name, description: name + " tool",
    ...(exposure ? { exposure } : {}),
    parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    async execute(id, p) { before?.(); mark(name); return { content: [{ type: "text", text: name + ":" + p.value }], details: {} }; } });
  tool("probe", ${JSON.stringify(live === "direct" ? undefined : live)});
  tool("trigger", "codemode", () => { if (!late) { late = true; tool("late", "direct"); } });
}`);
  const configure = (overrides?: Record<string, string>) => writeFileSync(join(agentDir, "lazy-loader.json"),
    JSON.stringify({ packages: [overrides ? { source: fixture, toolExposure: overrides } : fixture] }));
  configure(toolExposure);
  const readTrace = () => readFileSync(trace, "utf8");
  const clearTrace = () => writeFileSync(trace, "");
  return { agentDir, configure, readTrace, clearTrace };
}

/** Bootstrap the cache in a throwaway session; the next session starts with every package deferred. */
async function bootstrap(fx: ReturnType<typeof setup>, mode: Mode) {
  (await open(fx.agentDir, mode)).session.dispose();
  assert.match(fx.readTrace(), /^load\n/);
  fx.clearTrace();
}

try {
  // Config parsing and the shared policy.
  {
    const dir = join(root, "config");
    const fixture = join(dir, "fixture");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["index.ts"] } }));
    const catalog = (toolExposure: unknown) => {
      writeFileSync(join(dir, "lazy-loader.json"), JSON.stringify({ packages: [{ source: fixture, toolExposure }] }));
      return readLazyLoaderConfig(dir);
    };
    assert.deepEqual(catalog({ probe: "codemode", " late ": "hidden" }).packages[0].toolExposure, { probe: "codemode", late: "hidden" });
    for (const bad of [[], "codemode", null, { probe: "model-only" }, { probe: "typo" }, { "": "direct" }, { "a\nb": "direct" }]) {
      const result = catalog(bad);
      assert.equal(result.packages.length, 0, JSON.stringify(bad));
      assert.match(result.diagnostics.join(";"), /toolExposure/, JSON.stringify(bad));
    }
    const inline = (lazy: unknown) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [{ source: fixture, extensions: [], lazy }] }));
      return readLazyLoaderConfig(dir);
    };
    assert.deepEqual(inline({ toolExposure: { probe: "deferred" } }).packages[0].toolExposure, { probe: "deferred" });
    const invalid = inline({ tools: ["probe"], toolExposure: { probe: "bogus" } });
    assert.equal(invalid.packages.length, 1, "an invalid inline toolExposure must not drop the package");
    assert.equal(invalid.packages[0].toolExposure, undefined);
    assert.deepEqual(invalid.packages[0].proxyTools, ["probe"]);
    assert.match(invalid.diagnostics.join(";"), /lazy\.toolExposure.*ignoring it/);

    const def = { name: "p", source: "p", toolExposure: { probe: "codemode" as const, hide: "hidden" as const } };
    for (const [live, expected] of [[undefined, "codemode"], ["direct", "codemode"], ["deferred", "codemode"], ["codemode", "codemode"],
      ["hidden", "hidden"], ["model-only", "model-only"], ["typo", "typo"]]) {
      assert.equal(effectiveExposure(def, "probe", live), expected, String(live));
    }
    assert.equal(effectiveExposure(def, "hide", undefined), "hidden");
    assert.equal(effectiveExposure(def, "other", "direct"), "direct");
    assert.equal(effectiveExposure(def, "constructor", undefined), undefined, "only own override keys apply");
    assert.equal(effectiveExposure({ name: "p", source: "p" }, "probe", "deferred"), "deferred");
    console.log("PASS toolExposure config parsing and exposure policy");
  }

  // (1) Parity matrix.
  let cases = 0;
  for (const mode of ["on", "only"] as const) {
    for (const target of ["direct", "codemode", "deferred", "hidden"]) {
      for (const live of ["direct", "codemode", "deferred"]) {
        const label = `${mode}/${target}/${live}`;
        const fx = setup(`matrix-${mode}-${target}-${live}`, live, { probe: target });
        await bootstrap(fx, mode);
        assert.equal(readCache(fx.agentDir).packages.fixture.tools.find((t) => t.name === "probe")?.exposure,
          live === "direct" ? undefined : live, `${label}: cache must keep the raw exposure`);
        const s = await open(fx.agentDir, mode);
        try {
          assert.equal(s.session.getToolDefinition("probe")?.exposure, target, `${label}: proxy exposure`);
          await s.say("hi");
          if (target === "hidden") {
            assert.equal(s.session.getCallableToolNames().includes("probe"), false, label);
            assert.doesNotMatch(await s.code("text(await tools.probe({value:1}))"), /probe:1/, `${label}: hidden proxy must not run`);
            assert.equal(fx.readTrace(), "", `${label}: a denied call must not load the package`);
            assert.match(await s.code("text(await tools.trigger({value:7}))"), /trigger:7/, label);
            assert.equal(s.session.getCallableToolNames().includes("probe"), false, `${label}: loaded probe stays hidden`);
            assert.equal(fx.readTrace(), "load\ntrigger\n");
          } else {
            assert.match(await s.code("text(await tools.probe({value:7}))"), /probe:7/, `${label}: first call must execute`);
            assert.equal(fx.readTrace(), "load\nprobe\n");
            if (mode === "on" && target === "direct") {
              assert.match(await s.call("probe", { value: 8 }), /probe:8/, `${label}: direct model call must execute`);
            }
          }
          assert.equal(s.session.getToolDefinition("probe")?.exposure, target, `${label}: live exposure`);
          await s.say("after");
          assertStable(s.requests, label);
        } finally {
          s.session.dispose();
        }
        cases++;
      }
    }
  }
  console.log(`PASS ${cases} override parity cases`);

  // (2) Hidden and model-only are never promoted, before or after load.
  for (const mode of ["on", "only"] as const) {
    for (const live of ["hidden", "model-only"]) {
      const label = `${mode}/${live}`;
      const fx = setup(`promote-${mode}-${live}`, live, { probe: "codemode" });
      await bootstrap(fx, mode);
      const s = await open(fx.agentDir, mode);
      try {
        assert.equal(s.session.getToolDefinition("probe")?.exposure, live, label);
        assert.equal(s.session.getCallableToolNames().includes("probe"), false, label);
        assert.doesNotMatch(await s.code("text(await tools.probe({value:1}))"), /probe:1/, label);
        assert.equal(fx.readTrace(), "", `${label}: a denied call must not load the package`);
        await s.code("text(await tools.trigger({value:2}))");
        assert.equal(fx.readTrace(), "load\ntrigger\n");
        assert.equal(s.session.getToolDefinition("probe")?.exposure, live, `${label}: live registration not promoted`);
        assert.equal(s.session.getCallableToolNames().includes("probe"), false, label);
        assertStable(s.requests, label);
      } finally {
        s.session.dispose();
      }
    }
  }
  console.log("PASS hidden/model-only exposures are never promoted");

  // (3) Removing the override needs no re-bootstrap: the cache holds the raw exposure.
  {
    const fx = setup("removed", "deferred", { probe: "codemode" });
    await bootstrap(fx, "only");
    let s = await open(fx.agentDir, "only");
    assert.equal(s.session.getToolDefinition("probe")?.exposure, "codemode");
    assert.match(await s.code("text(await tools.probe({value:3}))"), /probe:3/);
    s.session.dispose();
    await Promise.resolve(); // let any queued cache refresh settle
    assert.equal(readCache(fx.agentDir).packages.fixture.tools.find((t) => t.name === "probe")?.exposure, "deferred");
    fx.configure(undefined);
    fx.clearTrace();
    s = await open(fx.agentDir, "only");
    try {
      assert.equal(s.session.getToolDefinition("probe")?.exposure, "deferred", "proxy shows the package's own exposure");
      assert.equal(fx.readTrace(), "", "no startup bootstrap after removing the override");
    } finally {
      s.session.dispose();
    }
  }
  console.log("PASS override removal uses the raw cache without bootstrap");

  // (4) Late registrations (after the load commit) get the effective exposure, uncached and cached.
  {
    const fx = setup("late", "direct", { late: "codemode" }, true);
    await bootstrap(fx, "on");
    for (const pass of ["uncached", "cached"]) {
      const s = await open(fx.agentDir, "on");
      try {
        if (pass === "cached") assert.equal(s.session.getToolDefinition("late")?.exposure, "codemode", "late proxy");
        await s.say("hi");
        assert.match(await s.code("text(await tools.trigger({value:4}))"), /trigger:4/);
        assert.equal(s.session.getToolDefinition("late")?.exposure, "codemode", `${pass}: late registration`);
        assert.match(await s.code("text(await tools.late({value:5}))"), /late:5/);
        if (pass === "cached") assertStable(s.requests, "late/cached");
      } finally {
        s.session.dispose();
      }
      await Promise.resolve();
      assert.equal(readCache(fx.agentDir).packages.fixture.tools.find((t) => t.name === "late")?.exposure, "direct", "late cache stays raw");
    }
  }
  console.log("PASS late registrations use the effective exposure");

  // (5) /reload re-reads the policy and keeps parity.
  for (const mode of ["on", "only"] as const) {
    const fx = setup(`reload-${mode}`, "direct", { probe: "codemode" });
    await bootstrap(fx, mode);
    const s = await open(fx.agentDir, mode);
    try {
      await s.say("hi");
      assert.match(await s.code("text(await tools.probe({value:6}))"), /probe:6/);
      await s.session.reload();
      assert.equal(s.session.getToolDefinition("probe")?.exposure, "codemode", `${mode}: proxy after reload`);
      await s.say("after reload");
      assert.match(await s.code("text(await tools.probe({value:7}))"), /probe:7/);
      assert.equal(s.session.getToolDefinition("probe")?.exposure, "codemode", `${mode}: live after reload`);
      await s.say("after");
      assert.equal(fx.readTrace(), "load\nprobe\nload\nprobe\n", `${mode}: package reloads lazily after /reload`);
      assertStable(s.requests, `reload/${mode}`);
    } finally {
      s.session.dispose();
    }
  }
  console.log("PASS /reload keeps override parity");

  // (6) Overridden tools keep their receiver: prototype methods, #private fields, WeakMap(this) state.
  for (const mode of ["on", "only"] as const) {
    const agentDir = join(root, `receiver-${mode}`);
    const fixture = join(agentDir, "fixture");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", type: "module", pi: { extensions: ["index.ts"] } }));
    writeFileSync(join(fixture, "index.ts"), `
const parameters = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
class Klass {
  name = "klass"; label = "klass"; description = "klass tool"; parameters = parameters; prefix = "klass";
  async execute(id, p) { return text(this.prefix + ":" + p.value); }
}
class Priv {
  #secret = "priv";
  name = "priv"; label = "priv"; description = "priv tool"; parameters = parameters;
  // Own (not prototype) method, so this isolates the receiver: a copy has no #secret and throws.
  execute = async function(id, p) { return text(this.#secret + ":" + p.value); };
}
const state = new WeakMap();
const weak = { name: "weak", label: "weak", description: "weak tool", parameters,
  async execute(id, p) { return text(state.get(this) + ":" + p.value); } };
state.set(weak, "weak");
export default function(pi) {
  const tools = { klass: new Klass(), priv: new Priv(), weak };
  globalThis.__lazyReceiverTools = tools;
  for (const tool of Object.values(tools)) pi.registerTool(tool);
}`);
    writeFileSync(join(agentDir, "lazy-loader.json"), JSON.stringify({
      packages: [{ source: fixture, toolExposure: { klass: "codemode", priv: "codemode", weak: "codemode" } }],
    }));
    (await open(agentDir, mode)).session.dispose();
    const s = await open(agentDir, mode);
    try {
      await s.say("hi");
      for (const name of ["klass", "priv", "weak"]) {
        assert.equal(s.session.getToolDefinition(name)?.exposure, "codemode", `${mode}/${name}: proxy exposure`);
        const out = await s.code(`text(await tools.${name}({value:9}))`);
        assert.match(out, new RegExp(`${name}:9`), `${mode}/${name}: first call must execute with the original receiver`);
        assert.equal(s.session.getToolDefinition(name)?.exposure, "codemode", `${mode}/${name}: live exposure`);
        const original = (globalThis as any).__lazyReceiverTools[name];
        assert.equal(Object.hasOwn(original, "exposure"), false, `${mode}/${name}: original tool must not be mutated`);
        assert.equal(readCache(agentDir).packages.fixture.tools.find((t) => t.name === name)?.exposure, undefined,
          `${mode}/${name}: cache must keep the raw exposure`);
      }
      await s.say("after");
      assertStable(s.requests, `receiver/${mode}`);
    } finally {
      s.session.dispose();
    }
  }
  console.log("PASS overridden tools keep prototype methods and their receiver");

  console.log("PASS exposure-override-checks");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
