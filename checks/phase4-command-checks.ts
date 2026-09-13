import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CacheDriftError, LazyLoader } from "../src/loader.js";
import { fakePi } from "./fake-pi.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function writeTempCommandPackage(suffix: string, indexJs: string) {
  const root = join(tmpdir(), `pi-lazy-command-${suffix}-${Date.now()}`);
  const packageRoot = join(root, "npm", "node_modules", "pi-token-burden");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-token-burden", type: "module", pi: { extensions: ["./index.js"] } }),
  );
  writeFileSync(join(packageRoot, "index.js"), indexJs);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const { root, cleanup } = writeTempCommandPackage(
  "top",
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

const pi: any = fakePi();
const commands = pi.commands;

try {
  const loader = new LazyLoader(pi, root, [{
    name: "pi-token-burden",
    source: "npm:pi-token-burden",
  }]);
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
  cleanup();
}

{
  const { root: lateRoot, cleanup } = writeTempCommandPackage(
    "late",
    `export default function (pi) {
      pi.on("tool_call", () => {
        const taken = (pi.getCommands?.() ?? []).some((c) => c.name === "token-burden");
        if (!taken) {
          pi.registerCommand("token-burden", {
            description: "late command",
            handler() { return "late-result"; }
          });
        }
      });
    }`,
  );
  const pi: any = fakePi();
  const commands = pi.commands;
  try {
    const loader = new LazyLoader(pi, lateRoot, [{ name: "pi-token-burden", source: "npm:pi-token-burden" }]);
    loader.reserveCommand("pi-token-burden", "token-burden");
    const stub = { description: "stub", handler() { return "stub"; } };
    commands.set("token-burden", stub);
    const loaded = await loader.loadPackage("pi-token-burden");
    assert(loaded.success, loaded.error ?? "late command package must load");
    assert(commands.get("token-burden") === stub, "reserved command must stay staged until post-load register");
    assert(!loader.isCommandCaptured("pi-token-burden", "token-burden"), "late command must not be captured before registerCommand");
    await pi.emit("tool_call");
    assert(commands.get("token-burden") !== stub, "post-loaded reserved command must register with the host");
    assert(loader.isCommandCaptured("pi-token-burden", "token-burden"), "skip-if-registered late register must see hidden proxy and capture");
    const result = await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
    assert(result === "late-result", "post-loaded reserved command must be captured");
    console.log("Phase 4.2 post-load reserved command capture/host registration: PASS");
  } finally {
    cleanup();
  }
}

{
  const { root: failRoot, cleanup } = writeTempCommandPackage(
    "fail",
    `export default function (pi) {
      pi.on("tool_call", () => {
        const taken = (pi.getCommands?.() ?? []).some((c) => c.name === "token-burden");
        if (!taken) {
          pi.registerCommand("token-burden", {
            description: "should not land",
            handler() { return "nope"; }
          });
        }
      });
      throw new Error("factory boom");
    }`,
  );
  const pi: any = fakePi();
  const commands = pi.commands;
  try {
    const loader = new LazyLoader(pi, failRoot, [{ name: "pi-token-burden", source: "npm:pi-token-burden" }]);
    loader.reserveCommand("pi-token-burden", "token-burden");
    const stub = { description: "stub", handler() { return "stub"; } };
    commands.set("token-burden", stub);
    const failed = await loader.loadPackage("pi-token-burden");
    assert(!failed.success && failed.status === "failed", "factory failure must stick");
    let lateErr: unknown;
    try {
      await pi.emit("tool_call");
    } catch (error) {
      lateErr = error;
    }
    assert(!lateErr, "surviving handler after failed load must not throw on an unrelated event");
    assert(commands.get("token-burden") === stub, "post-failure register must not replace the stub");
    assert(!loader.isCommandCaptured("pi-token-burden", "token-burden"), "post-failure register must not capture");
    console.log("Phase 4.2 post-failure reserved command drop: PASS");
  } finally {
    cleanup();
  }
}

{
  const { root: metaRoot, cleanup } = writeTempCommandPackage(
    "meta",
    `export default function (pi) {
      pi.registerCommand("token-burden", { description: "meta only" });
    }`,
  );
  const pi: any = fakePi();
  try {
    const loader = new LazyLoader(pi, metaRoot, [{ name: "pi-token-burden", source: "npm:pi-token-burden" }]);
    loader.reserveCommand("pi-token-burden", "token-burden");
    const loaded = await loader.loadPackage("pi-token-burden");
    assert(loaded.success, loaded.error ?? "metadata-only package must load");
    assert(!loader.isCommandCaptured("pi-token-burden", "token-burden"), "metadata-only registration is not captured as ready");
    assert(loader.getCommandStatus("pi-token-burden", "token-burden") === "missing", "metadata-only registration must not report [ready]");
    let drift: unknown;
    try {
      await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
    } catch (error) {
      drift = error;
    }
    assert(drift instanceof CacheDriftError, "metadata-only invocation must report cache drift");
    console.log("Phase 4.2 metadata-only command is not [ready]: PASS");
  } finally {
    cleanup();
  }
}

{
  const { root: oopsRoot, cleanup } = writeTempCommandPackage(
    "oops",
    `export default function (pi) {
      pi.registerCommand("token-burden", { description: "oops", handler: "oops" });
    }`,
  );
  const pi: any = fakePi();
  try {
    const loader = new LazyLoader(pi, oopsRoot, [{ name: "pi-token-burden", source: "npm:pi-token-burden" }]);
    loader.reserveCommand("pi-token-burden", "token-burden");
    const loaded = await loader.loadPackage("pi-token-burden");
    assert(loaded.success, loaded.error ?? "non-function handler package must load");
    assert(!loader.isCommandCaptured("pi-token-burden", "token-burden"), "handler:'oops' must not count as captured");
    assert(loader.getCommandStatus("pi-token-burden", "token-burden") === "missing", "handler:'oops' must not report [ready]");
    assert(!(loaded.newTools ?? []).includes("token-burden"), "handler:'oops' must not appear as new/published");
    let drift: unknown;
    try {
      await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
    } catch (error) {
      drift = error;
    }
    assert(drift instanceof CacheDriftError, "handler:'oops' public invoke must throw CacheDriftError");
    assert(!(drift instanceof TypeError), "handler:'oops' must not TypeError");
    console.log("Phase 4.2 handler:'oops' is not [ready]: PASS");
  } finally {
    cleanup();
  }
}

{
  const { root: liveRoot, cleanup } = writeTempCommandPackage(
    "oops-live",
    `export default function (pi) {
      pi.registerCommand("token-burden", { description: "oops", handler: "oops" });
    }`,
  );
  const pi: any = fakePi();
  try {
    const loader = new LazyLoader(pi, liveRoot, [{ name: "pi-token-burden", source: "npm:pi-token-burden" }]);
    loader.reserveCommand("pi-token-burden", "token-burden");
    pi.registerCommand("token-burden", {
      description: "lazy",
      async handler(args: string, ctx: any) {
        return await loader.invokeCapturedCommand("pi-token-burden", "token-burden", args, ctx);
      },
    });
    const loaded = await loader.loadPackage("pi-token-burden");
    assert(loaded.success, loaded.error ?? "handler:'oops' package must load");
    assert(loader.getCommandStatus("pi-token-burden", "token-burden") === "missing", "handler:'oops' live host must stay not-ready");
    assert(!(loaded.newTools ?? []).includes("token-burden"), "handler:'oops' must not appear as new/published");
    const live = (pi.getCommands?.() ?? []).find((command: any) => command.name === "token-burden");
    assert(typeof live?.handler === "function", "handler:'oops' must not replace the live host proxy");
    let drift: unknown;
    try {
      await live.handler("", {});
    } catch (error) {
      drift = error;
    }
    assert(drift instanceof CacheDriftError, "live host handler:'oops' must report cache drift");
    assert(!(drift instanceof TypeError), "live host handler:'oops' must not TypeError");
    console.log("Phase 4.2 handler:'oops' live host stays proxy: PASS");
  } finally {
    cleanup();
  }
}

{
  const { root: dupRoot, cleanup } = writeTempCommandPackage(
    "dup-post-load",
    `export default function (pi) {
      pi.registerCommand("token-burden", {
        description: "first",
        handler() { return "first-result"; }
      });
      pi.on("tool_call", () => {
        pi.registerCommand("token-burden", {
          description: "second",
          handler() { return "second-result"; }
        });
      });
    }`,
  );
  const pi: any = fakePi();
  try {
    const loader = new LazyLoader(pi, dupRoot, [{ name: "pi-token-burden", source: "npm:pi-token-burden" }]);
    loader.reserveCommand("pi-token-burden", "token-burden");
    const loaded = await loader.loadPackage("pi-token-burden");
    assert(loaded.success, loaded.error ?? "post-load duplicate package must load");
    assert(loader.isCommandCaptured("pi-token-burden", "token-burden"), "factory registration must be captured after load");
    const first = await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
    assert(first === "first-result", "first captured handler must run before duplicate");
    let dupErr: unknown;
    try {
      await pi.emit("tool_call");
    } catch (error) {
      dupErr = error;
    }
    const message = dupErr instanceof Error ? dupErr.message : String(dupErr ?? "");
    assert(message.includes("Duplicate target registration"), "post-load duplicate must throw Duplicate target registration");
    assert(message.includes("token-burden"), "duplicate error must include command name");
    assert(message.includes("pi-token-burden"), "duplicate error must include package name");
    const still = await loader.invokeCapturedCommand("pi-token-burden", "token-burden", "", {});
    assert(still === "first-result", "first captured handler must remain (no last-write-wins)");
    console.log("Phase 4.2 post-load duplicate reserved registerCommand: PASS");
  } finally {
    cleanup();
  }
}
