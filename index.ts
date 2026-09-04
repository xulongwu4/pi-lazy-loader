import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";

import { LazyLoader, type PackageState } from "./src/loader.js";
import { MANIFEST } from "./src/manifest.js";
import { getUserSettingsPath, pinPackageInSettingsFile } from "./src/settings.js";
import {
  loadCommandConfig,
  formatStartupDescription,
  type MergedCommandDefinition,
} from "./src/command-config.js";

function formatStatus(status: PackageState["status"]): string {
  switch (status) {
    case "loaded":
      return "loaded  ";
    case "loading":
      return "loading ";
    case "failed":
      return "failed  ";
    case "deferred":
    default:
      return "deferred";
  }
}

export function formatPackageList(
  states: PackageState[],
  definitions?: MergedCommandDefinition[],
  loader?: LazyLoader
): string {
  const lines: string[] = ["Lazy-Loadable Packages:"];
  for (const s of states) {
    const costStr = `${s.manifest.cost.toFixed(3)}s`;
    const status = formatStatus(s.status);
    const err = s.error ? ` [ERROR: ${s.error}]` : "";
    const tools = s.newTools.length > 0 ? ` (tools: ${s.newTools.join(", ")})` : "";
    const pkgDefs = definitions?.filter((d) => d.packageName === s.manifest.name) ?? [];
    let cmds = "";
    if (pkgDefs.length > 0) {
      const cmdParts = pkgDefs.map((d) => {
        const cmdStatus = loader
          ? loader.getCommandStatus(s.manifest.name, d.commandName)
          : s.status === "loaded"
            ? "ready"
            : s.status;
        return `/${d.commandName} [${cmdStatus}]`;
      });
      cmds = ` (commands: ${cmdParts.join(", ")})`;
    }
    lines.push(`  [${status}] ${s.manifest.name.padEnd(35)} cost: ${costStr.padStart(6)} | ${s.manifest.capability}${tools}${cmds}${err}`);
  }
  return lines.join("\n");
}

export default function lazyLoaderExtension(pi: ExtensionAPI) {
  const loader = new LazyLoader(pi);

  // Load merged command proxy configurations and write diagnostics to stderr
  const { definitions, diagnostics } = loadCommandConfig();
  for (const diag of diagnostics) {
    console.error(`[pi-lazy-loader] ${diag}`);
  }

  // Optional test / diagnostic report writer (only active when PI_LAZY_REPORT_PATH is set)
  const reportPath = process.env.PI_LAZY_REPORT_PATH;
  const report: any = reportPath
    ? {
        steps: [],
        toolsBefore: [],
        fabricPresentBefore: false,
        newTools: [],
        fabricPresentAfter: false,
        observedToolCalls: [],
        bootstrapErrors: [],
        sessionStartCaptured: false,
        resourcesDiscoverCaptured: false,
      }
    : null;

  const saveReport = () => {
    if (reportPath && report) {
      try {
        writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
      } catch {}
    }
  };

  // 1. Eagerly capture genuine lifecycle events at startup for late replay
  pi.on("session_start", (event: any, ctx: any) => {
    loader.setSessionStart(event, ctx);
    loader.syncConfiguredEager();
    if (diagnostics.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`pi-lazy-loader: ${diagnostics.join("; ")}`, "warning");
    }
    if (report) {
      report.sessionStartCaptured = true;
      saveReport();
    }
  });

  pi.on("resources_discover", (event: any, ctx: any) => {
    loader.setResourcesDiscover(event, ctx);
    if (report) {
      report.resourcesDiscoverCaptured = true;
      saveReport();
    }
  });

  if (report) {
    pi.on("tool_call", (e: any) => {
      const name = e?.toolName ?? e?.name;
      report.observedToolCalls.push(name);
      saveReport();
    });

    pi.on("tool_result", (e: any) => {
      const contentStr = JSON.stringify(e?.content ?? "");
      const detailsStr = JSON.stringify(e?.details ?? "");
      if (contentStr.includes("Pi Fabric has not bootstrapped") || detailsStr.includes("Pi Fabric has not bootstrapped")) {
        report.bootstrapErrors.push({
          tool: e?.toolName,
          content: e?.content,
        });
        saveReport();
      }
    });
  }

  // 2. Register manifest-driven and user-configured command proxies for deferred packages
  // FR-3: Reserve ALL declared commands for deferred packages before registering any proxy
  const deferredDefinitions: MergedCommandDefinition[] = [];
  const packageDefinitions = new Map<string, MergedCommandDefinition[]>();

  for (const def of definitions) {
    const list = packageDefinitions.get(def.packageName) ?? [];
    list.push(def);
    packageDefinitions.set(def.packageName, list);
  }

  for (const [pkgName, defs] of packageDefinitions.entries()) {
    if (loader.getPackageState(pkgName)?.status === "deferred") {
      for (const def of defs) {
        loader.reserveCommand(def.packageName, def.commandName, {
          declaredDescription: def.description,
          targetLabel: def.targetLabel,
          decorateDescription: true,
        });
        deferredDefinitions.push(def);
      }
    }
  }

  // Register startup stubs
  for (const def of deferredDefinitions) {
    pi.registerCommand(def.commandName, {
      description: formatStartupDescription(def),
      getArgumentCompletions(_prefix: string) {
        return null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const loaded = await loader.loadPackage(def.packageName);
        if (!loaded.success) {
          const message = `Failed to load ${def.packageName}: ${loaded.error}`;
          if (ctx.hasUI) ctx.ui.notify(message, "error");
          else console.error(message);
          return;
        }
        if (report) {
          report.steps.push({ step: "proxy_call", proxy: `/${def.commandName}`, target: def.commandName });
          saveReport();
        }
        try {
          return await loader.invokeCapturedCommand(def.packageName, def.commandName, args, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`${def.commandName} failed: ${message}`, "error");
          else console.error(`${def.commandName} failed: ${message}`);
        }
      },
    });
  }

  // 3. Register slash command: /lazy (list | add <pkg> | pin <pkg>)
  pi.registerCommand("lazy", {
    description: "Manage lazy-loaded extensions: /lazy list, /lazy add <pkg>, /lazy pin <pkg>",
    getArgumentCompletions(prefix: string) {
      const trimmed = prefix.trim();
      const parts = trimmed.split(/\s+/);
      if (parts.length <= 1) {
        const subs = ["list", "add", "pin"];
        const matches = subs.filter((s) => s.startsWith(parts[0] || ""));
        return matches.map((s) => ({ value: s, label: s }));
      }
      if (parts[0] === "add" || parts[0] === "pin") {
        const pkgPrefix = parts[1] || "";
        const matches = MANIFEST.map((m) => m.name).filter((n) => n.toLowerCase().startsWith(pkgPrefix.toLowerCase()));
        return matches.map((name) => ({ value: `${parts[0]} ${name}`, label: name }));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() || "list";

      if (subcommand === "list") {
        const states = loader.getAllStates();
        const text = formatPackageList(states, definitions, loader);
        if (ctx.hasUI) {
          ctx.ui.notify(text, "info");
        }
        console.log(text);
        return;
      }

      if (subcommand === "add") {
        const pkgName = parts[1];
        if (!pkgName) {
          const usage = "Usage: /lazy add <package>";
          if (ctx.hasUI) ctx.ui.notify(usage, "warning");
          console.error(usage);
          return;
        }

        const res = await loader.loadPackage(pkgName);
        if (!res.success) {
          const err = `Failed to load "${pkgName}": ${res.error}`;
          if (ctx.hasUI) ctx.ui.notify(err, "error");
          console.error(err);
          return;
        }

        const msg = res.alreadyLoaded
          ? `Package "${res.package}" is already loaded.`
          : `Loaded "${res.package}" in ${res.loadMs}ms. New tools: ${res.newTools?.length ? res.newTools.join(", ") : "none"}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        console.log(msg);
        return;
      }

      if (subcommand === "pin") {
        const pkgName = parts[1];
        if (!pkgName) {
          const usage = "Usage: /lazy pin <package>";
          if (ctx.hasUI) ctx.ui.notify(usage, "warning");
          console.error(usage);
          return;
        }

        try {
          const settingsPath = getUserSettingsPath();
          const res = pinPackageInSettingsFile(settingsPath, pkgName);
          const msg = `Pinned "${res.package}" to eager startup next time (removed extensions:[] filter in ${settingsPath}).`;
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          console.log(msg);
        } catch (err: any) {
          const errMsg = `Failed to pin "${pkgName}": ${err?.message ?? err}`;
          if (ctx.hasUI) ctx.ui.notify(errMsg, "error");
          console.error(errMsg);
        }
        return;
      }

      const invalid = `Unknown /lazy subcommand "${subcommand}". Usage: /lazy [list | add <package> | pin <package>]`;
      if (ctx.hasUI) ctx.ui.notify(invalid, "error");
      console.error(invalid);
    },
  });

  // 3. Register strict TypeBox tool: lazy_load
  pi.registerTool({
    name: "lazy_load",
    label: "Lazy Load",
    description: "Load a deferred Pi extension: subagent delegation → @tintinweb/pi-subagents; workflows/research → @quintinshaw/pi-dynamic-workflows; web search/fetch → pi-web-access; MCP servers → pi-mcp-adapter.",
    promptSnippet: "Load deferred capabilities: subagents, workflows, web search/fetch, or MCP servers",
    promptGuidelines: [
      "Use lazy_load before claiming a deferred subagent, workflow, web, or MCP capability is unavailable.",
    ],
    parameters: Type.Object(
      {
        package: Type.String({
          description: "Package name or source; use @tintinweb/pi-subagents for delegation, @quintinshaw/pi-dynamic-workflows for workflows/research, pi-web-access for web, or pi-mcp-adapter for MCP.",
        }),
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, _signal, onUpdate) {
      const activeBefore = pi.getActiveTools?.() ?? [];
      const fabricActive = activeBefore.includes("fabric_exec");
      if (report) {
        const toolsBefore = (pi.getAllTools?.() ?? []).map((t: any) => t.name);
        report.toolsBefore = toolsBefore;
        report.fabricPresentBefore = toolsBefore.includes("fabric_exec");
        report.steps.push({
          step: "before_lazy_load",
          fabricPresent: report.fabricPresentBefore,
          toolCount: toolsBefore.length,
          activeTools: pi.getActiveTools?.() ?? [],
        });
        saveReport();
      }

      onUpdate?.({
        content: [{ type: "text", text: `Loading deferred package ${params.package}...` }],
        details: {},
      });
      const result = await loader.loadPackage(params.package);
      // Refresh Fabric's captured catalog, then keep newly registered tools off
      // the native path during this same turn. Non-Fabric sessions retain Pi's
      // normal behavior where dynamic tools become active immediately.
      const toolsAfter = (pi.getAllTools?.() ?? []).map((t: any) => t.name);
      if (fabricActive) pi.setActiveTools(activeBefore);

      if (report) {
        report.fabricPresentAfter = toolsAfter.includes("fabric_exec");
        report.newTools = result.newTools ?? [];
        report.steps.push({
          step: "after_lazy_load",
          package: params.package,
          success: result.success,
          fabricPresent: report.fabricPresentAfter,
          toolCount: toolsAfter.length,
          newTools: report.newTools,
          loadMs: result.loadMs,
          error: result.error,
          activeTools: pi.getActiveTools?.() ?? [],
        });
        saveReport();
      }

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Failed to load package "${params.package}": ${result.error}` }],
          details: {
            success: false,
            package: params.package,
            error: result.error,
          },
          isError: true,
        };
      }

      const msg = result.alreadyLoaded
        ? `Package "${result.package}" is already loaded.`
        : `Successfully loaded package "${result.package}" in ${result.loadMs}ms. New tools: ${
            result.newTools?.length ? result.newTools.join(", ") : "none"
          }.`;

      return {
        content: [{ type: "text", text: msg }],
        details: {
          success: true,
          package: result.package,
          source: result.source,
          loadMs: result.loadMs,
          newTools: result.newTools,
          alreadyLoaded: result.alreadyLoaded,
        },
      };
    },
  });

  return loader;
}
