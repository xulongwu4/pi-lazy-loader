import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import lazyLoaderExtension from "../index.js";
import { readCache, writeCache } from "../src/cache.js";
import { packageFingerprint } from "../src/resolver.js";
import { fakePi } from "./fake-pi.js";

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

  console.log("PASS package fingerprint cache invalidation");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
