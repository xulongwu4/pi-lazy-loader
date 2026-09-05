import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";

import type { ManifestEntry, ToolProxyDeclaration } from "./manifest.js";
import type { LazyLoader, PackageLoadResult } from "./loader.js";
import {
  computePackageFingerprint,
  sanitizeToolDefinition,
  type CachedTool,
  type ToolCacheData,
} from "./tool-cache.js";
import { resolvePackageEntries, resolvePackageRoot } from "./resolver.js";

export type ToolProxyTier = 1 | 2;

export function selectToolProxyTier(
  declaration: ToolProxyDeclaration,
  cached: CachedTool | undefined,
  cacheFresh: boolean
): ToolProxyTier {
  return declaration.faithful === true &&
    cacheFresh &&
    cached?.hasPrepareArguments === false &&
    typeof cached.label === "string" &&
    typeof cached.description === "string" &&
    cached.parameters !== null &&
    typeof cached.parameters === "object" &&
    !Array.isArray(cached.parameters)
    ? 1
    : 2;
}

function errorResult(message: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, ...details },
    isError: true,
  };
}

async function loadForProxy(pi: any, loader: LazyLoader, packageName: string): Promise<PackageLoadResult> {
  const activeBefore = pi.getActiveTools?.() ?? [];
  const fabricActive = activeBefore.includes("fabric_exec");
  const result = await loader.loadPackage(packageName);
  if (fabricActive) pi.setActiveTools(activeBefore);
  return result;
}

function capturedToolOrError(loader: LazyLoader, packageName: string, toolName: string): any {
  return loader.getCapturedTool(packageName, toolName);
}

function metadataMatches(cached: CachedTool, captured: any): boolean {
  const fresh = sanitizeToolDefinition(captured);
  if (!fresh) return false;
  try {
    return isDeepStrictEqual(cached, JSON.parse(JSON.stringify(fresh)));
  } catch {
    return false;
  }
}

/** Register real-name startup stubs for declared tools of deferred packages. */
export function registerToolProxies(
  pi: any,
  loader: LazyLoader,
  entries: ManifestEntry[],
  cache: ToolCacheData
): string[] {
  const diagnostics: string[] = [];
  const occupied = new Set((pi.getAllTools?.() ?? []).map((tool: any) => tool.name));

  for (const entry of entries) {
    if (!entry.tools?.length || loader.getPackageState(entry.name)?.status !== "deferred") continue;

    const cachedPackage = cache.packages[entry.name];
    let cacheFresh = false;
    if (cachedPackage) {
      try {
        const packageRoot = resolvePackageRoot(entry.source, loader.getAgentDir());
        const entries = resolvePackageEntries(entry, loader.getAgentDir());
        cacheFresh = cachedPackage.fingerprint === computePackageFingerprint(packageRoot, entries);
      } catch {
        cacheFresh = false;
      }
    }
    const cachedByName = new Map(cachedPackage?.tools.map((tool) => [tool.name, tool]) ?? []);

    for (const declaration of entry.tools) {
      if (occupied.has(declaration.name)) {
        const diagnostic = `Tool proxy "${declaration.name}" for "${entry.name}" was skipped because that name is already registered`;
        diagnostics.push(diagnostic);
        console.error(`[pi-lazy-loader] ${diagnostic}`);
        loader.protectTool(entry.name, declaration.name);
        continue;
      }

      loader.reserveTool(entry.name, declaration.name);
      const cached = cachedByName.get(declaration.name);
      const tier = selectToolProxyTier(declaration, cached, cacheFresh);

      if (tier === 1 && cached) {
        const { hasPrepareArguments: _prepareFlag, ...metadata } = cached;
        const stub = {
          ...metadata,
          async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
            onUpdate?.({
              content: [{ type: "text", text: `Loading deferred package ${entry.name}...` }],
              details: {},
            });
            const loaded = await loadForProxy(pi, loader, entry.name);
            if (!loaded.success) {
              return errorResult(`Failed to load package "${entry.name}": ${loaded.error}`, {
                package: entry.name,
                tool: declaration.name,
                error: loaded.error,
              });
            }
            const captured = capturedToolOrError(loader, entry.name, declaration.name);
            if (!captured) {
              return errorResult(
                `Package "${entry.name}" loaded but did not register declared tool "${declaration.name}". The manifest is stale.`,
                { package: entry.name, tool: declaration.name, manifestDrift: true }
              );
            }
            if (!metadataMatches(cached, captured)) {
              return errorResult(
                `Tool "${declaration.name}" changed since its metadata was cached. Retry after restarting Pi.`,
                { package: entry.name, tool: declaration.name, metadataDrift: true }
              );
            }
            if (typeof captured.execute !== "function") {
              return errorResult(`Tool "${declaration.name}" has no execute function.`, {
                package: entry.name,
                tool: declaration.name,
              });
            }
            pi.registerTool(captured);
            return await captured.execute(toolCallId, params, signal, onUpdate, ctx);
          },
        };
        pi.registerTool(stub);
      } else {
        pi.registerTool({
          name: declaration.name,
          label: `Lazy: ${declaration.name}`,
          description: `${entry.capability}. This tool is deferred: its first call loads "${entry.name}" without executing. Retry the same "${declaration.name}" call after loading.`,
          parameters: Type.Object(
            {
              _lazy: Type.Optional(Type.String({ description: "Ignored; the first call only loads the package." })),
            },
            { additionalProperties: true }
          ),
          async execute(_toolCallId: string, _params: any, _signal: AbortSignal, onUpdate: any) {
            onUpdate?.({
              content: [{ type: "text", text: `Loading deferred package ${entry.name}...` }],
              details: {},
            });
            const loaded = await loadForProxy(pi, loader, entry.name);
            if (!loaded.success) {
              return errorResult(`Failed to load package "${entry.name}": ${loaded.error}`, {
                package: entry.name,
                tool: declaration.name,
                error: loaded.error,
              });
            }
            const captured = capturedToolOrError(loader, entry.name, declaration.name);
            if (!captured) {
              return errorResult(
                `Package "${entry.name}" loaded but did not register declared tool "${declaration.name}". The manifest is stale.`,
                { package: entry.name, tool: declaration.name, manifestDrift: true }
              );
            }
            pi.registerTool(captured);
            return {
              content: [{
                type: "text",
                text: `Loaded "${entry.name}". The requested tool was not executed; retry "${declaration.name}" now.`,
              }],
              details: {
                ok: true,
                loaded: true,
                executed: false,
                package: entry.name,
                retryTool: declaration.name,
              },
            };
          },
        });
      }
      occupied.add(declaration.name);
    }
  }

  return diagnostics;
}
