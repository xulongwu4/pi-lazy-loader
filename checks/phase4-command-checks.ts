import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LazyLoader } from "../src/loader.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const root = join(tmpdir(), `pi-lazy-command-${Date.now()}`);
const packageRoot = join(root, "npm", "node_modules", "pi-token-burden");
mkdirSync(packageRoot, { recursive: true });
writeFileSync(
  join(packageRoot, "package.json"),
  JSON.stringify({ name: "pi-token-burden", type: "module", pi: { extensions: ["./index.js"] } }),
);
writeFileSync(
  join(packageRoot, "index.js"),
  `export default function (pi) {
    globalThis.__phase4CommandFactoryCount = (globalThis.__phase4CommandFactoryCount || 0) + 1;
    pi.registerCommand("token-burden", {
      description: "fixture command",
      getArgumentCompletions(prefix) { return [{ value: prefix + "-real", label: "real completion" }]; },
      async handler(args, ctx) {
        globalThis.__phase4CommandArgs = [args, ctx];
        globalThis.__phase4CommandHandlerCount = (globalThis.__phase4CommandHandlerCount || 0) + 1;
        if (args === "boom") throw globalThis.__phase4CommandError;
        return "command-result";
      }
    });
  }`,
);

const commands = new Map<string, any>();
const pi: any = {
  registerTool() {},
  registerCommand(name: string, command: any) { commands.set(name, command); },
  getAllTools() { return []; },
  getActiveTools() { return []; },
  setActiveTools() {},
  on() {},
};

try {
  const loader = new LazyLoader(pi, root, false);
  loader.reserveCommand("pi-token-burden", "token-burden");
  const lazyStub = { description: "[lazy] load pi-token-burden then run /token-burden", handler() {} };
  commands.set("token-burden", lazyStub);
  assert(commands.get("token-burden")?.description.startsWith("[lazy]"), "lazy description must be visible before load");

  let earlyError = "";
  try {
    await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
  } catch (error) {
    earlyError = error instanceof Error ? error.message : String(error);
  }
  assert(earlyError.includes("did not register reserved command"), "invocation before load must fail clearly");

  const [loaded, concurrent] = await Promise.all([
    loader.loadPackage("pi-token-burden"),
    loader.loadPackage("pi-token-burden"),
  ]);
  assert(loaded.success, loaded.error ?? "package load failed");
  assert(concurrent.success, concurrent.error ?? "concurrent package load failed");
  assert((globalThis as any).__phase4CommandFactoryCount === 1, "concurrent first calls must execute the factory once");
  const realCommand = commands.get("token-burden");
  assert(realCommand !== lazyStub, "real command must replace the lazy stub after load");
  assert(realCommand?.description === "fixture command", "real command description must replace the lazy description");
  const completions = await realCommand.getArgumentCompletions("arg");
  assert(completions[0].value === "arg-real", "real command completions must replace the stub behavior");
  assert(!commands.has("token-burden:1"), "replacement must not create a suffixed duplicate");

  const ctx = { cwd: "/fixture", hasUI: true };
  const result = await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "--trace", ctx);
  assert(result === "command-result", "captured command result must be returned unchanged");
  const forwarded = (globalThis as any).__phase4CommandArgs;
  assert(forwarded[0] === "--trace", "command arguments must be forwarded unchanged");
  assert(forwarded[1] === ctx, "command context identity must be preserved");

  const repeated = await realCommand.handler("again", ctx);
  assert(repeated === "command-result", "subsequent invocation must use the real registered handler directly");
  assert((globalThis as any).__phase4CommandFactoryCount === 1, "repeated invocation must not reload the factory");
  assert((globalThis as any).__phase4CommandHandlerCount === 2, "captured handler must run once per invocation");

  const targetError = new Error("target command failed");
  (globalThis as any).__phase4CommandError = targetError;
  let caught: unknown;
  try {
    await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "boom", ctx);
  } catch (error) {
    caught = error;
  }
  assert(caught === targetError, "target command errors must propagate unchanged");
  console.log("Phase 4.2 command capture, concurrency, repeat calls, and exact forwarding: PASS");
} finally {
  delete (globalThis as any).__phase4CommandArgs;
  delete (globalThis as any).__phase4CommandFactoryCount;
  delete (globalThis as any).__phase4CommandHandlerCount;
  delete (globalThis as any).__phase4CommandError;
  rmSync(root, { recursive: true, force: true });
}
