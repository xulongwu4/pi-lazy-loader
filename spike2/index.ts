import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Modules WE import are resolved by pi's own loader to pi's running instances.
// Handing these same objects to jiti as virtualModules is exactly what pi does
// internally (loader.js: virtualModules: VIRTUAL_MODULES), and it guarantees the
// lazily-loaded extension shares pi's module instances instead of duplicates.
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, "report.json");
const JITI = "/home/oulongwu/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs";
const FABRIC = "/home/oulongwu/.pi/agent/npm/node_modules/pi-fabric/dist/index.js";

const report: any = { steps: [] };
const save = () => writeFileSync(REPORT, JSON.stringify(report, null, 2));

export default async function spike(pi: any) {
  report.factoryRan = true;
  save();

  // Does session_start fire for an extension loaded via -e at startup?
  pi.on("session_start", () => {
    report.ownSessionStartFired = true;
    save();
  });

  pi.registerTool({
    name: "lazy_load",
    label: "Lazy Load",
    description: "Dynamically load the pi-fabric extension into this running session.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const before = pi.getAllTools().map((t: any) => t.name);
      report.steps.push({ step: "before", fabricPresent: before.includes("fabric_exec"), count: before.length });
      save();

      const t0 = Date.now();
      try {
        const { createJiti } = await import(JITI);
        const jiti = createJiti(import.meta.url, {
          moduleCache: false,
          tryNative: false,
          virtualModules: {
            "@earendil-works/pi-coding-agent": piCodingAgent,
            "@mariozechner/pi-coding-agent": piCodingAgent,
          },
        });
        const factory = await jiti.import(FABRIC, { default: true });
        report.factoryType = typeof factory;
        save();
        if (typeof factory !== "function") throw new Error("default export is not a function");

        // Capture handlers the loaded extension registers, so we can replay
        // lifecycle events it missed by being loaded late.
        const captured: Array<[string, any]> = [];
        const proxy = new Proxy(pi, {
          get(target: any, prop: string) {
            if (prop === "on") {
              return (event: string, handler: any) => {
                captured.push([event, handler]);
                return target.on(event, handler);
              };
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        await factory(proxy); // live ExtensionAPI handle, via capture proxy
        report.capturedEvents = captured.map(([e]) => e);
        save();

        // Replay session_start, which already fired before we were loaded.
        const missed = captured.filter(([e]) => e === "session_start");
        report.replayed = [];
        for (const [, handler] of missed) {
          try {
            await handler({ type: "session_start", sessionId: "spike", cwd: process.cwd() });
            report.replayed.push("ok");
          } catch (err: any) {
            report.replayed.push("threw: " + String(err?.message ?? err).slice(0, 120));
          }
        }
        save();

        const after = pi.getAllTools().map((t: any) => t.name);
        report.loadMs = Date.now() - t0;
        report.newTools = after.filter((n: string) => !before.includes(n));
        report.fabricExecPresentAfter = after.includes("fabric_exec");
        report.loadOk = true;
        save();
        return {
          output: `loaded pi-fabric in ${report.loadMs}ms; new tools: ${report.newTools.join(", ")}`,
        };
      } catch (e: any) {
        report.loadOk = false;
        report.error = String(e?.message ?? e);
        report.stack = String(e?.stack ?? "").split("\n").slice(0, 6).join("\n");
        save();
        return { output: `LOAD FAILED: ${report.error}` };
      }
    },
  });

  // Record which fabric tools actually got invoked by the model afterwards.
  pi.on("tool_call", (e: any) => {
    const name = e?.toolName ?? e?.name;
    if (name && name !== "lazy_load") {
      report.steps.push({ step: "tool_call_observed", name });
      save();
    }
  });
}
