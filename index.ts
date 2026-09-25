import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

import { LazyLoader, type PackageState } from "./src/loader.js";
import { addVisibleCommandName, getAgentDir } from "./src/pi-host.js";
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
        return `/${d.proxyName} [${cmdStatus}]`;
      });
      cmds = ` (commands: ${cmdParts.join(", ")})`;
    }
    lines.push(`  [${status}] ${s.definition.name.padEnd(35)} ${s.definition.source}${tools}${cmds}${err}`);
  }
  return lines.join("\n");
}

export default function lazyLoaderExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const configured = readLazyLoaderConfig(agentDir);
  const lazyPackages = configured.packages;
  const loader = new LazyLoader(pi, agentDir, lazyPackages);

  let cache = readCache(loader.getAgentDir());
  const cachedPackages = lazyPackages.map((pkg) => ({
    ...pkg,
    commands: selectCachedRegistrations(cache.packages[pkg.name]?.commands ?? [], pkg.proxyCommands),
  }));
  // Shared names go to whichever package was cached first: cache entries are added in the order
  // packages bootstrapped, i.e. the order their commands first registered and claimed names.
  const cacheOrder = Object.keys(cache.packages);
  const commandConfig = buildCommandDefinitions(
    [...cachedPackages].sort((a, b) => cacheOrder.indexOf(a.name) - cacheOrder.indexOf(b.name))
  );
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
    // Before bootstrap: an uncached package's late commands must see (and bump around) the
    // proxies, not register first and be mistaken for a foreign owner of their names.
    registerCommandProxies();

    // A missing cache is bootstrapped once by eagerly loading that deferred package.
    const bootstrapDiagnostics: string[] = [];
    // Late renames during bootstrap join the single startup warning instead of one toast each.
    loader.collectNotices();
    try {
      for (const pkg of lazyPackages) {
        if (Object.hasOwn(cache.packages, pkg.name)) continue;
        const loaded = await loader.loadPackage(pkg.name);
        if (!loaded.success) {
          updateCachedPackage(loader.getAgentDir(), pkg.name, [], []);
          bootstrapDiagnostics.push(`Failed to populate cache for "${pkg.name}": ${loaded.error}`);
        }
      }
    } finally {
      bootstrapDiagnostics.push(...loader.drainNotices());
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
  // cross-extension commands as /name:1, /name:2 (Release Acceptance #12 forbids Pi adding
  // numeric suffixes; lazy packages sharing a name get explicit name:N proxies from
  // buildCommandDefinitions instead), and the pre-bind command set is order-dependent. Reservation is
  // internal-only and safe at load; proxy registration is deferred to session_start,
  // where getCommands() sees every command registered during extension loading, so conflict
  // outcomes do not depend on extension load order. (A command another extension registers
  // after session_start is not seen; Pi then suffixes it against ours on its own.)
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
        proxyName: def.proxyName,
      });
      deferredDefinitions.push(def);
    }
  }

  function registerCommandProxy(def: MergedCommandDefinition): void {
    pi.registerCommand(def.proxyName, {
      description: formatStartupDescription({ ...def, commandName: def.proxyName }),
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
          report.steps.push({ step: "proxy_call", proxy: `/${def.proxyName}`, target: def.commandName });
          saveReport();
        }
        try {
          return await loader.invokeCapturedCommand(def.packageName, def.commandName, args, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`${def.proxyName} failed: ${message}`, "error");
          else console.error(`${def.proxyName} failed: ${message}`);
        }
      },
    });
  }

  // Post-bind proxy registration: runs in session_start where pi.getCommands() is legal.
  // Names already taken (eager commands, built-ins, other extensions) get a free /name:N
  // proxy (N >= 2) instead; the real command later commits under that same name.
  // Called first thing in session_start; diagnostics reach the UI via that handler's notify.
  let commandProxiesRegistered = false;
  function registerCommandProxies(): void {
    if (commandProxiesRegistered) return;
    commandProxiesRegistered = true;
    // Index both resolved names and their numeric-suffix bases: if Pi already resolved
    // a duplicate as /name:1, a new /name proxy would only produce /name:2.
    const visible = new Set<string>();
    try {
      for (const command of pi.getCommands?.() ?? []) addVisibleCommandName(visible, command.name);
    } catch (error: any) {
      const diagnostic = `command proxy registration skipped: ${error?.message ?? error}`;
      diagnostics.push(diagnostic);
      console.error(`[pi-lazy-loader] ${diagnostic}`);
      return;
    }
    // visible also holds the base of every suffixed name, so a taken /cmd:N implies /cmd.
    const taken = new Set(visible);
    for (const def of deferredDefinitions) if (!visible.has(def.commandName)) taken.add(def.proxyName);
    for (const def of deferredDefinitions) {
      if (visible.has(def.commandName)) {
        let suffix = 2;
        while (taken.has(`${def.commandName}:${suffix}`)) suffix++;
        const proxyName = `${def.commandName}:${suffix}`;
        const diagnostic = `Command "/${def.commandName}" from "${def.packageName}" is already registered; registering it as "/${proxyName}"`;
        diagnostics.push(diagnostic);
        console.error(`[pi-lazy-loader] ${diagnostic}`);
        def.proxyName = proxyName; // shared with /lazy list
        loader.reserveCommand(def.packageName, def.commandName, {
          declaredDescription: def.declaredDescription,
          decorateDescription: true,
          proxyName,
        });
      }
      taken.add(def.proxyName);
      registerCommandProxy(def);
    }
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
          const label = removeLazyPackage(loader.getAgentDir(), state.definition.source);
          const msg = `Removed "${state.definition.name}" from ${label}. Reload Pi after ensuring its Pi settings load it eagerly.`;
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

  return loader;
}
