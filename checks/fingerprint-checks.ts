import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import lazyLoaderExtension from "../index.js";
import { readCache, writeCache } from "../src/cache.js";
import { packageFingerprint } from "../src/resolver.js";
import { fakePi } from "./fake-pi.js";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  collapseSystemMessages, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, hasNonAdditiveToolChanges, hasToolRedefinitions,
} from "@earendil-works/pi-ai";

const root = mkdtempSync(join(tmpdir(), "pi-lazy-fingerprint-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const pkgDir = join(root, "npm", "node_modules", "fp-pkg");
const trace = join(root, "trace");
const source = "npm:fp-pkg";

const writePackage = (version: string, entry = "index.js") =>
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "fp-pkg", version, type: "module", pi: { extensions: [entry] } }));
// Bun caches an imported module per path within this process, so the broken variant uses its own file.
const writeEntry = (extra = "", broken = false) => writeFileSync(join(pkgDir, broken ? "broken.js" : "index.js"), `
import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(trace)}, "load\\n");
  ${broken ? 'throw new Error("broken entry");' : ""}
  pi.registerTool({ name: "fp_tool", description: "Fingerprint tool", parameters: { type: "object", properties: {} }, execute() {} });
  globalThis.__fpLate = () => pi.registerTool({ name: "fp_late", description: "Late tool", parameters: { type: "object", properties: {} }, execute() {} });
}
${extra}`);

async function startup() {
  writeFileSync(trace, "");
  process.env.PI_CODING_AGENT_DIR = root;
  const pi = fakePi();
  const loader = lazyLoaderExtension(pi as any);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
  return { loader, loads: readFileSync(trace, "utf8").split("\n").filter(Boolean).length };
}
const cached = () => readCache(root).packages["fp-pkg"];

// Real Pi session for the upgrade matrix: records every provider request of a hi / codemode probe / after exchange.
type Mode = "on" | "only";
const strip = (m: any) => JSON.stringify(m, (k, v) => (k === "timestamp" ? undefined : v));
async function openSession(agentDir: string, mode: Mode) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const faux = fauxProvider({ provider: "probe", api: "probe-api", models: [{ id: "probe" }] });
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+codemode"], codemode: { mode }, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }, createCodemodeExtension({ mode, models: false }), (pi) => { lazyLoaderExtension(pi); }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: agentDir, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(agentDir) });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  await session.setModel(faux.getModel());
  return { session, faux };
}

/** Upgrade fixture: each version gets its own entry file (Bun module cache; also an entry list change). */
function writeUpgradeFixture(dir: string, traceFile: string, exposure: string, version: string) {
  const entry = `v${version}.js`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version, type: "module", pi: { extensions: [entry] } }));
  writeFileSync(join(dir, entry), `
import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(traceFile)}, "load\\n");
  pi.registerTool({ name: "probe", label: "Probe", description: "Probe tool", exposure: ${JSON.stringify(exposure)},
    parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    async execute(id, p) { return { content: [{ type: "text", text: "answer:" + p.value }], details: {} }; } });
}
`);
}

async function assertUpgradeSession(agentDir: string, mode: Mode, traceFile: string, exposure: string, bootstraps: boolean, label: string) {
  writeFileSync(traceFile, "");
  const { session, faux } = await openSession(agentDir, mode);
  try {
    assert.equal(readFileSync(traceFile, "utf8").includes("load"), bootstraps, `${label}: startup bootstrap must be ${bootstraps}`);
    assert.equal(session.getToolDefinition("probe")?.exposure, exposure, `${label}: probe exposure`);
    const requests: any[][] = [];
    const reply = (make: () => any) => (ctx: any) => { requests.push(ctx.messages); return make(); };
    const text = (s: string) => reply(() => fauxAssistantMessage(fauxText(s)));
    faux.setResponses([text("ok")]);
    await session.prompt("hi");
    faux.setResponses([reply(() => fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.probe({value:7}))" }), { stopReason: "toolUse" })), text("done")]);
    await session.prompt("call probe");
    faux.setResponses([text("ok")]);
    await session.prompt("after");
    const result = session.agent.state.messages.filter((m: any) => m.role === "toolResult")
      .map((m: any) => m.content.map((c: any) => c.text).join("")).join(" | ");
    assert.match(result, /answer:7/, `${label}: first codemode call must execute`);
    assert(requests.slice(1).every((next, i) => requests[i].every((m, j) => strip(m) === strip(next[j]))), `${label}: transcript must be append-only`);
    const deltas = requests.flatMap((msgs) => msgs.slice(1).filter((m: any) => m.role === "system" && (m.toolsAdded?.length || m.toolsRemoved?.length)));
    assert.equal(deltas.length, 0, `${label}: no tool-change system messages`);
    const collapsed = new Set(requests.map((msgs) => strip(collapseSystemMessages({ messages: msgs } as any).messages[0]))).size;
    assert.equal(collapsed, 1, `${label}: one collapsed prefix variant`);
    const last = requests.at(-1)!;
    assert(!hasToolRedefinitions(last) && !hasNonAdditiveToolChanges(last), `${label}: native delta compatibility`);
  } finally {
    session.dispose();
  }
}
const current = () => packageFingerprint(source, root);

try {
  mkdirSync(pkgDir, { recursive: true });
  writePackage("1.0.0");
  writeEntry();
  writeFileSync(join(root, "lazy-loader.json"), JSON.stringify({ packages: [source] }));

  assert.equal((await startup()).loads, 1, "cold cache must bootstrap");
  assert.equal(cached()?.fingerprint, current(), "bootstrap must store the package fingerprint");
  assert.deepEqual(cached()?.tools.map((tool) => tool.name), ["fp_tool"]);

  // (a) Fresh cache + unchanged package: no startup load.
  assert.equal((await startup()).loads, 0, "unchanged package must not load at startup");
  console.log("  ✓ (a) fresh fingerprint skips startup load");

  // (b) package.json change (version bump): one bootstrap, fingerprint updated, then stable.
  const v1 = cached()!.fingerprint;
  writePackage("1.0.1");
  assert.equal((await startup()).loads, 1, "version bump must bootstrap");
  assert.notEqual(cached()?.fingerprint, v1);
  assert.equal(cached()?.fingerprint, current());
  assert.equal((await startup()).loads, 0, "next startup after version bump must not load");
  console.log("  ✓ (b) package.json change re-bootstraps once");

  // (c) Entry file content/size change: bootstrap.
  writeEntry("// patched");
  assert.equal((await startup()).loads, 1, "entry change must bootstrap");
  assert.equal(cached()?.fingerprint, current());
  assert.equal((await startup()).loads, 0);
  console.log("  ✓ (c) entry file change re-bootstraps once");

  // (d) Legacy entry without fingerprint: one bootstrap, then stable.
  const legacy = readCache(root);
  delete legacy.packages["fp-pkg"].fingerprint;
  writeCache(root, legacy);
  assert.equal(cached()?.fingerprint, undefined);
  assert.equal((await startup()).loads, 1, "legacy entry must bootstrap");
  assert.equal(cached()?.fingerprint, current());
  assert.equal((await startup()).loads, 0);
  console.log("  ✓ (d) legacy entry without fingerprint bootstraps once");

  // (e) Bootstrap failure: fingerprinted empty entry, not retried until the package changes.
  writeEntry("", true);
  writePackage("1.0.1", "broken.js"); // Entry list change.
  const failed = await startup();
  assert.equal(failed.loads, 1, "broken entry must be attempted");
  assert.equal(failed.loader.getPackageState("fp-pkg")?.status, "failed");
  assert.deepEqual(cached(), { tools: [], commands: [], fingerprint: current() });
  assert.equal((await startup()).loads, 0, "unchanged broken package must not be retried every startup");
  writePackage("1.0.1");
  const fixed = await startup();
  assert.equal(fixed.loads, 1, "changed package must be retried");
  assert.equal(fixed.loader.getPackageState("fp-pkg")?.status, "loaded");
  assert.deepEqual(cached()?.tools.map((tool) => tool.name), ["fp_tool"]);
  console.log("  ✓ (e) bootstrap failure is keyed to package identity");

  // (f) A late registration refresh keeps the fingerprint of the load that produced it.
  writePackage("1.0.2");
  const late = await startup();
  assert.equal(late.loads, 1);
  const loadFingerprint = cached()!.fingerprint;
  assert.equal(late.loader.getPackageState("fp-pkg")?.fingerprint, loadFingerprint);
  writePackage("1.0.3"); // Mid-session upgrade: a recomputed fingerprint would differ.
  (globalThis as any).__fpLate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cached()?.tools.map((tool) => tool.name), ["fp_tool", "fp_late"], "late registration must refresh the cache");
  assert.equal(cached()?.fingerprint, loadFingerprint, "late refresh must reuse the load's fingerprint");
  assert.notEqual(cached()?.fingerprint, current());
  assert.equal((await startup()).loads, 1, "mid-session upgrade must bootstrap at the next startup");
  console.log("  ✓ (f) late refresh keeps the load's fingerprint");

  // Entry resolution failure: no identity to key on, so it is retried every startup until it resolves.
  writePackage("1.0.4", "missing.js");
  for (let i = 0; i < 2; i++) {
    assert.equal((await startup()).loader.getPackageState("fp-pkg")?.status, "failed", "unresolvable package must be attempted");
    assert.deepEqual(cached(), { tools: [], commands: [] });
  }
  writePackage("1.0.4");
  assert.equal((await startup()).loads, 1, "resolvable package must bootstrap again");
  console.log("  ✓ entry resolution failure is retried until the package resolves");

  // Upgrade matrix: a package changing its tool exposure must re-bootstrap before the first request,
  // so the first session after the upgrade (and the one after it) keeps a stable prompt prefix.
  const exposures = ["direct", "codemode", "deferred"];
  let scenarios = 0;
  for (const mode of ["on", "only"] as const) for (const before of exposures) for (const after of exposures) {
    if (before === after) continue;
    const label = `${mode} ${before}->${after}`;
    const agentDir = join(root, "upgrade", `${mode}-${before}-${after}`);
    const fixture = join(agentDir, "fixture");
    const traceFile = join(agentDir, "trace");
    mkdirSync(fixture, { recursive: true });
    writeUpgradeFixture(fixture, traceFile, before, "1.0.0");
    writeFileSync(join(agentDir, "lazy-loader.json"), JSON.stringify({ packages: [fixture] }));
    (await openSession(agentDir, mode)).session.dispose(); // Session 1 caches exposure `before`.
    writeUpgradeFixture(fixture, traceFile, after, "1.1.0");
    await assertUpgradeSession(agentDir, mode, traceFile, after, true, `${label} upgrade`);
    await assertUpgradeSession(agentDir, mode, traceFile, after, false, `${label} next`);
    scenarios++;
  }
  assert.equal(scenarios, 12);
  console.log("  ✓ exposure upgrade keeps a stable prompt prefix (12 scenarios x upgrade/next sessions)");

  console.log("PASS package fingerprint cache invalidation");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
