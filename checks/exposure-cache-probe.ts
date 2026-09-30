// Regression: swapping a cache-safe proxy for the real tool must preserve the request prefix.
// Covers matching exposures and verbatim descriptions in both codemode modes.
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

async function open(agentDir: string, mode: "on" | "only") {
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
  await session.bindExtensions({ onError: (e) => console.error("ext error", e) });
  await session.setModel(faux.getModel());
  return { session, faux };
}

async function checkPrefixStability(mode: "on" | "only", exposure: string, description: string) {
  const agentDir = mkdtempSync(join(root, `${mode}-${exposure}-`));
  const fixture = join(agentDir, "fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", type: "module", pi: { extensions: ["index.ts"] } }));
  writeFileSync(join(fixture, "index.ts"), `export default function(pi) {
  pi.registerTool({ name: "probe", label: "Probe", description: ${JSON.stringify(description)}, exposure: ${JSON.stringify(exposure)},
    parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    async execute(id, p) { return { content: [{ type: "text", text: "answer:" + p.value }], details: {} }; } });
}`);
  writeFileSync(join(agentDir, "lazy-loader.json"), JSON.stringify({ packages: [fixture] }));

  (await open(agentDir, mode)).session.dispose(); // Bootstrap the cache from the real extension.
  assert.equal(readCache(agentDir).packages.fixture.tools[0].description, description, "cache must preserve descriptions verbatim");

  const { session, faux } = await open(agentDir, mode);
  assert.equal(session.getToolDefinition("probe")?.description, description, "proxy must preserve the real description verbatim");
  const requests: any[][] = [];
  const reply = (make: () => any) => (ctx: any) => { requests.push(ctx.messages); return make(); };
  const text = (s: string) => reply(() => fauxAssistantMessage(fauxText(s)));
  faux.setResponses([text("ok")]);
  await session.prompt("hi");
  faux.setResponses([
    reply(() => fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.probe({value:7}))" }), { stopReason: "toolUse" })),
    text("done"),
  ]);
  await session.prompt("call probe");
  faux.setResponses([text("ok")]);
  await session.prompt("after");

  const result = session.agent.state.messages.filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.content.map((c: any) => c.text).join("")).join(" | ");
  const appendOnly = requests.slice(1).map((next, i) => requests[i].every((m, j) => strip(m) === strip(next[j])));
  const deltas = requests.flatMap((msgs) => msgs.slice(1)
    .filter((m: any) => m.role === "system" && (m.toolsAdded?.length || m.toolsRemoved?.length)));
  const collapsed = new Set(requests.map((msgs) => strip(collapseSystemMessages({ messages: msgs } as any).messages[0]))).size;
  // Same-name redeclaration disables Anthropic tool_addition/tool_removal and OpenAI additive anchoring.
  const nativeDeltaOk = !hasToolRedefinitions(requests.at(-1)!) && !hasNonAdditiveToolChanges(requests.at(-1)!);
  session.dispose();
  const scenario = `${mode}/${exposure}/${JSON.stringify(description)}`;
  assert.match(result, /answer:7/, `${scenario}: cache-safe first call must execute`);
  assert(appendOnly.every(Boolean), `${scenario}: loading must preserve the existing request prefix`);
  assert.equal(deltas.length, 0, `${scenario}: loading must not redeclare unchanged tools`);
  assert.equal(collapsed, 1, `${scenario}: collapsed system prefix must remain identical`);
  assert.equal(nativeDeltaOk, true, `${scenario}: loading must preserve native delta compatibility`);
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
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
