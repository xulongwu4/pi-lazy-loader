import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lazyLoaderExtension from "../index.js";
import { readLazyLoaderConfig } from "../src/config.js";
import { LazyLoader } from "../src/loader.js";
import { fakePi, writeFreshCache } from "./fake-pi.js";

const root = mkdtempSync(join(tmpdir(), "pi-lazy-tool-call-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousReportPath = process.env.PI_LAZY_REPORT_PATH;
const originalLoad = LazyLoader.prototype.loadPackage;
const originalError = console.error;

try {
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_LAZY_REPORT_PATH;
  const names = ["dependency-a", "dependency-b", "broken", "throwing", "unrelated"];
  for (const name of names) {
    const dir = join(root, "npm", "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name, type: "module", pi: { extensions: ["index.js"] },
    }));
    writeFileSync(join(dir, "index.js"), name === "broken"
      ? 'export default function () { throw new Error("fixture failure"); }'
      : `export default function (pi) {
          pi.on("session_start", async () => {
            await pi.events.emit("starting", ${JSON.stringify(name)});
            pi.events.emit("ready", ${JSON.stringify(name)});
          });
        }`);
  }

  const source = "npm:dependency-a";
  for (const form of ["inline", "key", "file"]) {
    const parse = (loadOnToolCall: unknown) => {
      rmSync(join(root, "settings.json"), { force: true });
      rmSync(join(root, "lazy-loader.json"), { force: true });
      const catalog = { packages: [{ source, loadOnToolCall }] };
      writeFileSync(join(root, form === "file" ? "lazy-loader.json" : "settings.json"), JSON.stringify(
        form === "inline" ? { packages: [{ source, lazy: { loadOnToolCall } }] }
          : form === "key" ? { "lazy-loader": catalog } : catalog,
      ));
      return readLazyLoaderConfig(root);
    };
    const valid = parse([" TaskExecute ", "TaskExecute", "Other"]);
    assert.deepEqual(valid.diagnostics, []);
    assert.deepEqual(valid.packages[0].loadOnToolCall, ["TaskExecute", "Other"]);
    assert.deepEqual(parse([]).packages[0].loadOnToolCall, []);
    for (const invalid of ["TaskExecute", [123], [""], ["bad\nname"]]) {
      const result = parse(invalid);
      assert(result.diagnostics.some((d) => d.includes("loadOnToolCall")), form);
      assert.equal(result.packages.length, form === "inline" ? 1 : 0);
      assert.equal(result.packages[0]?.loadOnToolCall, undefined);
    }
  }
  const schema = JSON.parse(readFileSync(new URL("../lazy-loader.schema.json", import.meta.url), "utf-8"));
  const properties = schema.properties.packages.items.oneOf[1].properties;
  assert.deepEqual(properties.loadOnToolCall, properties.tools);

  const configure = (enabled: boolean) => writeFileSync(join(root, "lazy-loader.json"), JSON.stringify({
    packages: names.map((name) => ({
      source: `npm:${name}`,
      loadOnToolCall: !enabled || name === "unrelated" ? []
        : name === "broken" ? ["Broken"] : name === "throwing" ? ["Throw"] : ["TaskExecute"],
    })),
  }));
  const makePi = () => {
    const pi = fakePi();
    const handlers: Function[] = [];
    const on = pi.on;
    pi.on = (event, handler) => {
      if (event === "tool_call") handlers.push(handler);
      on(event, handler);
    };
    return { pi, handlers };
  };
  configure(false);
  const disabled = makePi();
  lazyLoaderExtension(disabled.pi as any);
  assert.equal(disabled.handlers.length, 0);

  configure(true);
  writeFreshCache(root, {
    version: 2,
    packages: Object.fromEntries(names.map((name) => [name, { commands: [], tools: [] }])),
  });
  const { pi, handlers } = makePi();
  const started = new Set<string>();
  const ready: string[] = [];
  const gate = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  Object.assign(pi, { events: { emit(event: string, name: string) {
    if (event === "starting") {
      started.add(name);
      if (started.size === 2) bothStarted.resolve();
      return gate.promise;
    }
    if (event === "ready") ready.push(name);
  } } });
  const loads: string[] = [];
  LazyLoader.prototype.loadPackage = async function (name) {
    loads.push(name);
    if (name === "throwing") throw new Error("unexpected rejection");
    return originalLoad.call(this, name);
  };
  const errors: string[] = [];
  console.error = (...args) => { errors.push(args.join(" ")); };
  lazyLoaderExtension(pi as any);
  assert.equal(handlers.length, 1);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false, sessionManager: {} });
  assert.equal(loads.length, 0, "fresh cache must keep fixtures deferred");

  const call = (toolName: string) => handlers[0]({ type: "tool_call", toolName, toolCallId: "test", input: {} });
  assert.equal(await call("taskexecute"), undefined, "tool names are case-sensitive");
  assert.equal(await call("Other"), undefined);
  assert.equal(loads.length, 0);

  const first = call("TaskExecute");
  await bothStarted.promise;
  let secondFinished = false;
  const second = call("TaskExecute").then((result: unknown) => {
    secondFinished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(secondFinished, false, "a loading package must still be awaited");
  assert.deepEqual(ready, []);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.deepEqual(ready.sort(), ["dependency-a", "dependency-b"], "session_start replay finishes before the tool");
  assert.deepEqual(loads, ["dependency-a", "dependency-b", "dependency-a", "dependency-b"]);
  await call("TaskExecute");
  assert.equal(loads.length, 4, "loaded packages are skipped");

  assert.equal(await call("Broken"), undefined, "reported load failure must not block");
  assert(errors.some((error) => error.startsWith("[pi-lazy-loader]") && error.includes("fixture failure")));
  await call("Broken");
  assert.equal(loads.filter((name) => name === "broken").length, 1, "failed packages are skipped");
  assert.equal(await call("Throw"), undefined, "unexpected rejection must not escape");
  assert(errors.some((error) => error.startsWith("[pi-lazy-loader]") && error.includes("unexpected rejection")));
  assert(!loads.includes("unrelated"));
  console.log("loadOnToolCall checks passed");
} finally {
  LazyLoader.prototype.loadPackage = originalLoad;
  console.error = originalError;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousReportPath === undefined) delete process.env.PI_LAZY_REPORT_PATH;
  else process.env.PI_LAZY_REPORT_PATH = previousReportPath;
  rmSync(root, { recursive: true, force: true });
}
