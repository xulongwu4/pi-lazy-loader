// Regression: swapping a cache-safe proxy for the real tool must preserve the request prefix.
// Covers matching exposures and verbatim descriptions in both codemode modes, plus a
// first-call-unsafe prepareArguments proxy whose retry goes through Pi's native pipeline.
// Run: bun checks/exposure-cache-probe.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const root = mkdtempSync(join(tmpdir(), "pi-lazy-prefix-check-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const strip = (m: any) => JSON.stringify(m, (k, v) => (k === "timestamp" ? undefined : v));

async function open(agentDir: string, mode: "on" | "only", extra: ((pi: any) => void)[] = []) {
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
      ...extra,
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: agentDir, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(agentDir),
  });
  await session.bindExtensions({ onError: (e) => console.error("ext error", e) });
  await session.setModel(faux.getModel());
  return { session, faux };
}

function writeFixture(prefix: string, tool: string) {
  const agentDir = mkdtempSync(join(root, prefix));
  const fixture = join(agentDir, "fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", type: "module", pi: { extensions: ["index.ts"] } }));
  writeFileSync(join(fixture, "index.ts"), `export default function(pi) {\n  pi.registerTool(${tool});\n}`);
  writeFileSync(join(agentDir, "lazy-loader.json"), JSON.stringify({ packages: [fixture] }));
  return agentDir;
}

function capture(faux: any) {
  const requests: any[][] = [];
  const reply = (make: () => any) => (ctx: any) => { requests.push(ctx.messages); return make(); };
  const text = (s: string) => reply(() => fauxAssistantMessage(fauxText(s)));
  const codemode = (code: string) => {
    faux.setResponses([reply(() => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" })), text("done")]);
  };
  return { requests, text, codemode };
}

function prefixStats(requests: any[][]) {
  return {
    appendOnly: requests.slice(1).every((next, i) => requests[i].every((m, j) => strip(m) === strip(next[j]))),
    deltas: requests.flatMap((msgs) => msgs.slice(1)
      .filter((m: any) => m.role === "system" && (m.toolsAdded?.length || m.toolsRemoved?.length))).length,
    collapsed: new Set(requests.map((msgs) => strip(collapseSystemMessages({ messages: msgs } as any).messages[0]))).size,
    // Same-name redeclaration disables Anthropic tool_addition/tool_removal and OpenAI additive anchoring.
    nativeDeltaOk: !hasToolRedefinitions(requests.at(-1)!) && !hasNonAdditiveToolChanges(requests.at(-1)!),
  };
}

const toolResults = (session: any) => session.agent.state.messages.filter((m: any) => m.role === "toolResult")
  .map((m: any) => m.content.map((c: any) => c.text).join(""));

async function checkPrefixStability(mode: "on" | "only", exposure: string, description: string) {
  const agentDir = writeFixture(`${mode}-${exposure}-`, `{ name: "probe", label: "Probe", description: ${JSON.stringify(description)}, exposure: ${JSON.stringify(exposure)},
    parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    async execute(id, p) { return { content: [{ type: "text", text: "answer:" + p.value }], details: {} }; } }`);

  (await open(agentDir, mode)).session.dispose(); // Bootstrap the cache from the real extension.
  assert.equal(readCache(agentDir).packages.fixture.tools[0].description, description, "cache must preserve descriptions verbatim");

  const { session, faux } = await open(agentDir, mode);
  assert.equal(session.getToolDefinition("probe")?.description, description, "proxy must preserve the real description verbatim");
  const { requests, text, codemode } = capture(faux);
  faux.setResponses([text("ok")]);
  await session.prompt("hi");
  codemode("text(await tools.probe({value:7}))");
  await session.prompt("call probe");
  faux.setResponses([text("ok")]);
  await session.prompt("after");

  const result = toolResults(session).join(" | ");
  const stats = prefixStats(requests);
  session.dispose();
  const scenario = `${mode}/${exposure}/${JSON.stringify(description)}`;
  assert.match(result, /answer:7/, `${scenario}: cache-safe first call must execute`);
  assert(stats.appendOnly, `${scenario}: loading must preserve the existing request prefix`);
  assert.equal(stats.deltas, 0, `${scenario}: loading must not redeclare unchanged tools`);
  assert.equal(stats.collapsed, 1, `${scenario}: collapsed system prefix must remain identical`);
  assert.equal(stats.nativeDeltaOk, true, `${scenario}: loading must preserve native delta compatibility`);
}

// prepareArguments proxies stay first-call-unsafe (load + handoff) yet declare the cached tool verbatim.
async function checkPrepareArguments(mode: "on" | "only", exposure: string) {
  const description = "Prep tool: trims target.";
  const agentDir = writeFixture(`prep-${mode}-${exposure}-`, `{ name: "prep", label: "Prep", description: ${JSON.stringify(description)}, exposure: ${JSON.stringify(exposure)},
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    prepareArguments(args) { return { ...args, target: String(args?.target ?? "").trim() }; },
    async execute(id, p) { globalThis.__prepExec = (globalThis.__prepExec ?? 0) + 1; return { content: [{ type: "text", text: "target:[" + p.target + "]" }], details: {} }; } }`);
  (await open(agentDir, mode)).session.dispose();
  const cached = readCache(agentDir).packages.fixture.tools[0];
  assert.equal(cached.hasPrepareArguments, true, "cache must record prepareArguments");

  const seen: string[] = [];
  const permission = (pi: any) => pi.on("tool_call", (event: any) => {
    if (event.toolName !== "prep") return undefined;
    seen.push(event.input.target);
    return event.input.target === "denied" ? { block: true, reason: "prep target denied" } : undefined;
  });
  (globalThis as any).__prepExec = 0;
  const { session, faux } = await open(agentDir, mode, [permission]);
  const scenario = `prep ${mode}/${exposure}`;
  const proxy = session.getToolDefinition("prep") as any;
  assert.equal(proxy?.description, description, `${scenario}: proxy must keep the cached description verbatim`);
  assert.deepEqual(JSON.parse(JSON.stringify(proxy?.parameters)), cached.parameters, `${scenario}: proxy must declare cached parameters verbatim`);
  const { requests, text, codemode } = capture(faux);
  const call = (target: string) => `try { text(await tools.prep({target:${JSON.stringify(target)}})) } catch (e) { text("rejected:" + e.message) }`;
  faux.setResponses([text("ok")]);
  await session.prompt("hi");
  codemode(call(" x "));
  await session.prompt("load prep");
  assert.equal((globalThis as any).__prepExec, 0, `${scenario}: first call must not execute`);
  assert.equal(typeof (session.getToolDefinition("prep") as any)?.prepareArguments, "function", `${scenario}: first call must load the package`);
  codemode(call(" x "));
  await session.prompt("call prep");
  codemode(call(" denied "));
  await session.prompt("call denied");
  faux.setResponses([text("ok")]);
  await session.prompt("after");

  const [handoff, ran, denied] = toolResults(session);
  const stats = prefixStats(requests);
  session.dispose();
  assert.match(handoff, /was not executed/, `${scenario}: first call must hand off`);
  assert.match(ran, /target:\[x\]/, `${scenario}: retry must execute with prepared args`);
  assert.match(denied, /rejected:.*prep target denied/, `${scenario}: permission must block on prepared args`);
  assert.equal((globalThis as any).__prepExec, 1, `${scenario}: only the allowed retry may execute`);
  assert.deepEqual(seen, [" x ", "x", "denied"], `${scenario}: proxy hook sees raw args; post-load hooks see prepared args`);
  assert(stats.appendOnly, `${scenario}: loading must preserve the existing request prefix`);
  assert.equal(stats.deltas, 0, `${scenario}: loading must not redeclare unchanged tools`);
  assert.equal(stats.collapsed, 1, `${scenario}: collapsed system prefix must remain identical`);
  assert.equal(stats.nativeDeltaOk, true, `${scenario}: loading must preserve native delta compatibility`);
}

const exposures = ["direct", "codemode", "deferred"];
let checked = 0;
try {
  for (const mode of ["on", "only"] as const)
    for (const exposure of exposures)
      for (const description of ["Probe tool", " \nProbe tool...\t ", "", " \n\t "]) {
        await checkPrefixStability(mode, exposure, description);
        checked++;
      }
  console.log(`PASS ${checked} cache-safe proxy prefix-stability cases`);
  for (const mode of ["on", "only"] as const)
    for (const exposure of exposures) await checkPrepareArguments(mode, exposure);
  console.log(`PASS ${exposures.length * 2} prepareArguments proxy prefix-stability cases`);
} finally {
  delete (globalThis as any).__prepExec;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
