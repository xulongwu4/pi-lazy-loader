import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";

import { LazyLoader, type PackageLoadResult, type PackageState } from "./src/loader.js";
import { getUserAgentDir } from "./src/resolver.js";
import { readLazyLoaderConfig, removeLazyPackage } from "./src/config.js";
import {
  buildCommandDefinitions,
  type MergedCommandDefinition,
} from "./src/command-config.js";
import { formatStartupDescription } from "./src/command-presentation.js";
import { registerToolProxies } from "./src/tool-proxy.js";
import { readCache, selectCachedRegistrations, updateCachedPackage } from "./src/cache.js";

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
    const status = formatStatus(s.status);
    const err = s.error ? ` [ERROR: ${s.error}]` : "";
    const tools = s.newTools.length > 0 ? ` (tools: ${s.newTools.join(", ")})` : "";
    const pkgDefs = definitions?.filter((d) => d.packageName === s.definition.name) ?? [];
    let cmds = "";
    if (pkgDefs.length > 0) {
      const cmdParts = pkgDefs.map((d) => {
        const cmdStatus = loader
          ? loader.getCommandStatus(s.definition.name, d.commandName)
          : s.status === "loaded"
            ? "ready"
            : s.status;
        return `/${d.commandName} [${cmdStatus}]`;
      });
      cmds = ` (commands: ${cmdParts.join(", ")})`;
    }
    lines.push(`  [${status}] ${s.definition.name.padEnd(35)} ${s.definition.source}${tools}${cmds}${err}`);
  }
  return lines.join("\n");
}

export default function lazyLoaderExtension(pi: ExtensionAPI) {
  const agentDir = getUserAgentDir();
  const configured = readLazyLoaderConfig(agentDir);
  const lazyPackages = configured.packages;
  const loader = new LazyLoader(pi, agentDir, lazyPackages);

  let cache = readCache(loader.getAgentDir());
  const cachedPackages = lazyPackages.map((pkg) => ({
    ...pkg,
    commands: selectCachedRegistrations(cache.packages[pkg.name]?.commands ?? [], pkg.proxyCommands),
  }));
  const commandConfig = buildCommandDefinitions(cachedPackages);
  const definitions = commandConfig.definitions;
  const diagnostics = [...configured.diagnostics, ...commandConfig.diagnostics];


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
        if (typeof (pi as any).getCommands === "function") {
          report.registeredCommands = (pi as any).getCommands().map((c: any) => ({
            name: c.name,
            description: c.description,
            source: c.sourceInfo?.source ?? c.source,
          }));
        }
        writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
      } catch {}
    }
  };

  let toolProxiesRegistered = false;

  // 1. Eagerly capture genuine lifecycle events at startup for late replay
  pi.on("session_start", async (event: any, ctx: any) => {
    loader.setSessionStart(event, ctx);

    // A missing cache is bootstrapped once by eagerly loading that deferred package.
    const bootstrapDiagnostics: string[] = [];
    for (const pkg of lazyPackages) {
      if (Object.hasOwn(cache.packages, pkg.name)) continue;
      const loaded = await loader.loadPackage(pkg.name);
      if (!loaded.success) {
        updateCachedPackage(loader.getAgentDir(), pkg.name, [], []);
        bootstrapDiagnostics.push(`Failed to populate cache for "${pkg.name}": ${loaded.error}`);
      }
    }
    for (const diagnostic of bootstrapDiagnostics) console.error(`[pi-lazy-loader] ${diagnostic}`);

    cache = readCache(loader.getAgentDir());
    if (!toolProxiesRegistered) {
      diagnostics.push(...registerToolProxies(pi, loader, lazyPackages, cache));
      toolProxiesRegistered = true;
    }

    const sessionDiagnostics = [...diagnostics, ...bootstrapDiagnostics];
    if (sessionDiagnostics.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`pi-lazy-loader: ${sessionDiagnostics.join("; ")}`, "warning");
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

  // 2. Register cache-driven command proxies for deferred packages
  // FR-3: Reserve ALL declared command names for deferred packages before registering any proxy.
  // NOTE: pi.getCommands() is an action method and MUST NOT be called during extension
  // loading (runtime not initialized yet -> "Extension runtime not initialized" crash).
  // Proxies also must not be registered blindly at load time: Pi resolves duplicate
  // cross-extension commands as /name:1, /name:2 (Release Acceptance #12 forbids numeric
  // suffixes), and the pre-bind command set is order-dependent. Reservation is
  // internal-only and safe at load; proxy registration is deferred to session_start,
  // where getCommands() is legal and sees the complete command set, so conflict
  // outcomes are deterministic regardless of extension load order.
  const deferredDefinitions: MergedCommandDefinition[] = [];
  const packageDefinitions = new Map<string, MergedCommandDefinition[]>();

  for (const def of definitions) {
    const list = packageDefinitions.get(def.packageName) ?? [];
    list.push(def);
    packageDefinitions.set(def.packageName, list);
  }

  for (const [pkgName, defs] of packageDefinitions.entries()) {
    if (loader.getPackageState(pkgName)?.status !== "deferred") continue;
    for (const def of defs) {
      loader.reserveCommand(def.packageName, def.commandName, {
        declaredDescription: def.declaredDescription,
        decorateDescription: true,
      });
      deferredDefinitions.push(def);
    }
  }

  function reportSkippedProxy(packageName: string, commandName: string): string {
    loader.protectCommand(packageName, commandName);
    const diagnostic = `Command proxy "/${commandName}" for "${packageName}" was skipped because that name is already registered`;
    diagnostics.push(diagnostic);
    console.error(`[pi-lazy-loader] ${diagnostic}`);
    return diagnostic;
  }

  function registerCommandProxy(def: MergedCommandDefinition): void {
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

  // Post-bind proxy registration: runs in session_start where pi.getCommands() is legal.
  // Names already taken (eager commands, built-ins, other extensions) register no proxy
  // and are protected so a later package load cannot stage them either.
  let commandProxiesRegistered = false;
  pi.on("session_start", (_event: any, ctx: any) => {
    if (commandProxiesRegistered) return;
    commandProxiesRegistered = true;
    // Index both resolved names and their numeric-suffix bases: if Pi already resolved
    // a duplicate as /name:1, a new /name proxy would only produce /name:2.
    const visible = new Set<string>();
    const markVisible = (name: string) => {
      visible.add(name);
      const base = /^(.*):\d+$/.exec(name)?.[1];
      if (base) visible.add(base);
    };
    try {
      for (const command of pi.getCommands?.() ?? []) markVisible(command.name);
    } catch (error: any) {
      const diagnostic = `command proxy registration skipped: ${error?.message ?? error}`;
      diagnostics.push(diagnostic);
      console.error(`[pi-lazy-loader] ${diagnostic}`);
      if (ctx?.hasUI) ctx.ui.notify(`pi-lazy-loader: ${diagnostic}`, "warning");
      return;
    }
    const fresh: string[] = [];
    for (const def of deferredDefinitions) {
      // Packages eagerly loaded by bootstrap own their real commands; no proxy needed.
      if (loader.getPackageState(def.packageName)?.status === "loaded") continue;
      if (visible.has(def.commandName)) {
        fresh.push(reportSkippedProxy(def.packageName, def.commandName));
        continue;
      }
      visible.add(def.commandName);
      registerCommandProxy(def);
    }
    if (fresh.length > 0 && ctx?.hasUI) {
      ctx.ui.notify(`pi-lazy-loader: ${fresh.join("; ")}`, "warning");
    }
    // Refresh the diagnostic report so it reflects the registered startup proxies.
    saveReport();
  });

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
        const matches = loader.getAllStates().map((state) => state.definition.name).filter((name) => name.toLowerCase().startsWith(pkgPrefix.toLowerCase()));
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
          const state = loader.getPackageState(pkgName);
          if (!state) throw new Error(`Unknown configured package "${pkgName}"`);
          removeLazyPackage(loader.getAgentDir(), state.definition.source);
          const msg = `Removed "${state.definition.name}" from lazy-loader.json. Reload Pi after ensuring its Pi settings load it eagerly.`;
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
    description: "Load a deferred Pi extension package on demand.",
    parameters: Type.Object(
      {
        package: Type.String({
          description: "Package name or source to load",
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

      let result!: PackageLoadResult;
      let toolsAfter: string[] = [];
      try {
        result = await loader.loadPackage(params.package);
        // Let Fabric observe newly registered tools before restoring the native active set.
        toolsAfter = (pi.getAllTools?.() ?? []).map((t: any) => t.name);
      } finally {
        if (fabricActive) pi.setActiveTools?.(activeBefore);
      }

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

      let msg = result.alreadyLoaded
        ? `Package "${result.package}" is already loaded.`
        : `Successfully loaded package "${result.package}" in ${result.loadMs}ms. New tools: ${
            result.newTools?.length ? result.newTools.join(", ") : "none"
          }.`;
      if (result.missingTools?.length) {
        msg += ` Warning: Cached tools not registered: ${result.missingTools.join(", ")}.`;
      }

      return {
        content: [{ type: "text", text: msg }],
        details: {
          success: true,
          package: result.package,
          source: result.source,
          loadMs: result.loadMs,
          newTools: result.newTools,
          missingTools: result.missingTools,
          alreadyLoaded: result.alreadyLoaded,
        },
      };
    },
  });

  return loader;
}
