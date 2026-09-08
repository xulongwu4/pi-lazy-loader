import { Type } from "typebox";

import type { PackageDefinition } from "./package.js";
import type { LazyLoader, PackageLoadResult } from "./loader.js";
import { selectCachedRegistrations, type LazyLoaderCache } from "./cache.js";

export function formatProxyGuidance(packageName: string, toolName: string): string {
  return `This deferred proxy loads package "${packageName}" without executing "${toolName}". After loading completes, call "${toolName}" again using its loaded schema.`;
}

export function formatProxyDescription(baseDescription: string, packageName: string, toolName: string): string {
  const cleanBase = baseDescription.trim().replace(/\.+$/, "");
  return `${cleanBase}. ${formatProxyGuidance(packageName, toolName)}`;
}

async function loadForProxy(pi: any, loader: LazyLoader, packageName: string): Promise<PackageLoadResult> {
  const activeBefore = pi.getActiveTools?.() ?? [];
  const fabricActive = activeBefore.includes("fabric_exec");
  try {
    const result = await loader.loadPackage(packageName);
    pi.getAllTools?.(); // Let Fabric observe newly registered tools before active-set restoration.
    return result;
  } finally {
    if (fabricActive) pi.setActiveTools?.(activeBefore);
  }
}

function cacheDrift(packageName: string, toolName: string) {
  return {
    content: [{
      type: "text",
      text: `Package "${packageName}" loaded but did not register cached tool "${toolName}". The lazy-loader cache is stale.`,
    }],
    details: { ok: false, executed: false, package: packageName, tool: toolName, cacheDrift: true },
    isError: true,
  };
}

function loadFailure(packageName: string, toolName: string, error?: string) {
  const errMsg = error ? `: ${error}` : "";
  return {
    content: [{
      type: "text",
      text: `Package "${packageName}" failed to load${errMsg}. Reload the session or restart Pi.`,
    }],
    details: { ok: false, executed: false, package: packageName, tool: toolName, failed: true, error },
    isError: true,
  };
}

/** Register real-name load-and-retry proxies for cached tools of deferred packages. */
export function registerToolProxies(
  pi: any,
  loader: LazyLoader,
  entries: PackageDefinition[],
  cache: LazyLoaderCache
): string[] {
  const diagnostics: string[] = [];
  const occupied = new Set((pi.getAllTools?.() ?? []).map((tool: any) => tool.name));

  for (const entry of entries) {
    if (loader.getPackageState(entry.name)?.status !== "deferred") continue;

    const cachedTools = selectCachedRegistrations(
      cache.packages[entry.name]?.tools ?? [],
      entry.proxyTools
    );
    for (const declaration of cachedTools) {
      if (occupied.has(declaration.name)) {
        const diagnostic = `Tool proxy "${declaration.name}" for "${entry.name}" was skipped because that name is already registered`;
        diagnostics.push(diagnostic);
        console.error(`[pi-lazy-loader] ${diagnostic}`);
        loader.protectTool(entry.name, declaration.name);
        continue;
      }

      loader.reserveTool(entry.name, declaration.name);
      const baseDesc = declaration.description?.trim() || `Tools provided by ${entry.name}`;
      const guidance = formatProxyGuidance(entry.name, declaration.name);
      const description = formatProxyDescription(baseDesc, entry.name, declaration.name);

      pi.registerTool({
        name: declaration.name,
        label: declaration.name,
        description,
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute(_toolCallId: string, _params: any, _signal: AbortSignal, onUpdate: any) {
          const state = loader.getPackageState(entry.name);
          if (state?.status === "failed") {
            return loadFailure(entry.name, declaration.name, state.error);
          }
          if (state?.status === "loaded") {
            if (state.missingTools.includes(declaration.name)) {
              return cacheDrift(entry.name, declaration.name);
            }
            return {
              content: [{ type: "text", text: `Package "${entry.name}" is loaded. Call "${declaration.name}" again using its loaded schema.` }],
              details: { ok: true, loaded: true, executed: false, package: entry.name, retryTool: declaration.name, alreadyLoaded: true },
            };
          }

          onUpdate?.({
            content: [{ type: "text", text: `Loading deferred package ${entry.name}...` }],
            details: {},
          });
          const loaded = await loadForProxy(pi, loader, entry.name);
          if (!loaded.success) {
            return loadFailure(entry.name, declaration.name, loaded.error);
          }
          if (loaded.missingTools?.includes(declaration.name)) {
            return cacheDrift(entry.name, declaration.name);
          }

          return {
            content: [{
              type: "text",
              text: `Loaded package "${entry.name}". Tool "${declaration.name}" was not executed. Call "${declaration.name}" again using its loaded schema.`,
            }],
            details: {
              ok: true,
              loaded: true,
              executed: false,
              package: entry.name,
              retryTool: declaration.name,
              newTools: loaded.newTools,
              alreadyLoaded: loaded.alreadyLoaded,
            },
          };
        },
      });

      occupied.add(declaration.name);
    }
  }

  return diagnostics;
}
