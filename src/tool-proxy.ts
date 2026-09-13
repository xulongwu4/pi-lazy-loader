import { Type } from "typebox";

import type { PackageDefinition } from "./package.js";
import { isExecutableCapture, type LazyLoader, type PackageLoadResult } from "./loader.js";
import { isCachedToolSchema, schemaIsJsonRepresentable, schemasEquivalent, selectCachedRegistrations, type LazyLoaderCache } from "./cache.js";

export function formatProxyNote(packageName: string, toolName: string): string {
  return `This deferred proxy loads package "${packageName}" on first use and then invokes "${toolName}".`;
}

export function formatProxyGuidance(packageName: string, toolName: string): string {
  return `This deferred proxy loads package "${packageName}" without executing "${toolName}". After loading completes, call "${toolName}" again using its loaded schema.`;
}

export function formatProxyDescription(baseDescription: string, packageName: string, toolName: string, invoke = true): string {
  const cleanBase = baseDescription.trim().replace(/\.+$/, "");
  const note = invoke ? formatProxyNote(packageName, toolName) : formatProxyGuidance(packageName, toolName);
  return `${cleanBase}. ${note}`;
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

function retryHandoff(packageName: string, toolName: string, loaded?: PackageLoadResult) {
  const details: {
    ok: true;
    loaded: true;
    executed: false;
    package: string;
    retryTool: string;
    newTools?: string[];
    alreadyLoaded?: boolean;
  } = { ok: true, loaded: true, executed: false, package: packageName, retryTool: toolName };
  if (loaded) {
    details.newTools = loaded.newTools;
    details.alreadyLoaded = loaded.alreadyLoaded;
  } else {
    details.alreadyLoaded = true;
  }
  return {
    content: [{
      type: "text",
      text: loaded
        ? `Loaded package "${packageName}". Tool "${toolName}" was not executed. Call "${toolName}" again using its loaded schema.`
        : `Package "${packageName}" is loaded. Call "${toolName}" again using its loaded schema.`,
    }],
    details,
  };
}

function invokeMetadataEquivalent(
  cached: { hasPrepareArguments?: boolean; executionMode?: unknown; constrainedSampling?: unknown },
  live: { prepareArguments?: unknown; executionMode?: unknown; constrainedSampling?: unknown },
): boolean {
  if ((typeof live.prepareArguments === "function") !== (cached.hasPrepareArguments === true)) return false;
  if (cached.executionMode !== live.executionMode) return false;
  const sampling = (value: unknown) => (value === undefined || value === false ? false : value);
  return schemasEquivalent(sampling(cached.constrainedSampling), sampling(live.constrainedSampling));
}

function cachedInvokeIsSafe(
  cached: { parameters?: unknown; hasPrepareArguments?: boolean; executionMode?: unknown; constrainedSampling?: unknown },
  live?: { parameters?: unknown; prepareArguments?: unknown; executionMode?: unknown; constrainedSampling?: unknown },
): boolean {
  // true is intentionally first-call-unsafe (proxy cannot run prepareArguments).
  // false and undefined both mean "no prepareArguments" and may invoke.
  if (cached.hasPrepareArguments === true) return false;
  if (!isCachedToolSchema(cached.parameters)) return false;
  if (!live) return true;
  return invokeMetadataEquivalent(cached, live)
    && schemaIsJsonRepresentable(live.parameters)
    && schemasEquivalent(cached.parameters, live.parameters);
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

/** Register real-name load-then-invoke proxies for cached tools of deferred packages. */
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
      const schema = declaration.parameters;
      const canInvoke = cachedInvokeIsSafe(declaration);
      const description = formatProxyDescription(baseDesc, entry.name, declaration.name, canInvoke);

      const proxyTool: any = {
        name: declaration.name,
        label: declaration.name,
        description,
        parameters: canInvoke ? schema : Type.Object({}, { additionalProperties: true }),
        async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
          const state = loader.getPackageState(entry.name);
          if (state?.status === "failed") {
            return loadFailure(entry.name, declaration.name, state.error);
          }
          let loaded: PackageLoadResult | undefined;
          if (state?.status !== "loaded") {
            onUpdate?.({
              content: [{ type: "text", text: `Loading deferred package ${entry.name}...` }],
              details: {},
            });
            loaded = await loadForProxy(pi, loader, entry.name);
            if (!loaded.success) {
              return loadFailure(entry.name, declaration.name, loaded.error);
            }
          }

          const captured = loader.getCapturedTool(entry.name, declaration.name);
          if (!isExecutableCapture("tool", captured)) return cacheDrift(entry.name, declaration.name);

          if (!cachedInvokeIsSafe(declaration, captured)) {
            return retryHandoff(entry.name, declaration.name, loaded);
          }

          return await loader.invokeCapturedTool(entry.name, declaration.name, toolCallId, params, signal, onUpdate, ctx);
        },
      };
      if (declaration.executionMode !== undefined) proxyTool.executionMode = declaration.executionMode;
      if (declaration.constrainedSampling !== undefined) proxyTool.constrainedSampling = declaration.constrainedSampling;
      pi.registerTool(proxyTool);

      occupied.add(declaration.name);
    }
  }

  return diagnostics;
}
