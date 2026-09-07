import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOOL_CACHE_FILENAME = "lazy-loader-tools.json";
export const MAX_CACHE_FILE_SIZE = 64 * 1024; // 64 KiB

export interface CachedTool {
  name: string;
  description?: string;
}

export interface CachedPackageTools {
  tools: CachedTool[];
}

export interface ToolCacheData {
  version: 3;
  packages: Record<string, CachedPackageTools>;
}

/**
 * Read advisory tool cache from disk, migrating older v1 or v2 files to v3.
 * Fails soft and returns an empty v3 cache if reading or parsing fails.
 */
export function readToolCache(agentDir: string): ToolCacheData {
  const empty: ToolCacheData = { version: 3, packages: {} };
  const cachePath = join(agentDir, TOOL_CACHE_FILENAME);
  if (!existsSync(cachePath)) return empty;

  try {
    if (statSync(cachePath).size > MAX_CACHE_FILE_SIZE) return empty;
    const raw = readFileSync(cachePath, "utf-8");
    if (!raw.trim()) return empty;
    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      ![1, 2, 3].includes(parsed.version) ||
      !parsed.packages ||
      typeof parsed.packages !== "object" ||
      Array.isArray(parsed.packages)
    ) {
      return empty;
    }

    const packages: Record<string, CachedPackageTools> = {};
    for (const [pkgName, pkgData] of Object.entries(parsed.packages) as [string, any][]) {
      if (!Array.isArray(pkgData?.tools)) continue;

      const tools: CachedTool[] = [];
      for (const tool of pkgData.tools) {
        const name =
          typeof tool === "string"
            ? tool.trim()
            : typeof tool?.name === "string"
              ? tool.name.trim()
              : "";
        if (!name) continue;
        const description =
          typeof tool === "object" && typeof tool.description === "string" && tool.description.trim()
            ? tool.description.trim()
            : undefined;
        tools.push({ name, description });
      }
      packages[pkgName] = { tools };
    }
    return { version: 3, packages };
  } catch {
    return empty;
  }
}

/** Persist advisory tool cache to disk as v3 format. */
export function writeToolCache(agentDir: string, data: ToolCacheData): void {
  try {
    const cachePath = join(agentDir, TOOL_CACHE_FILENAME);
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized, "utf-8") > MAX_CACHE_FILE_SIZE) {
      console.warn(`[pi-lazy-loader] Tool cache exceeds ${MAX_CACHE_FILE_SIZE} bytes; skipping write.`);
      return;
    }
    writeFileSync(cachePath, serialized, "utf-8");
  } catch (err: any) {
    console.warn(`[pi-lazy-loader] Failed to write tool cache: ${err?.message ?? err}`);
  }
}

/** Update advisory tool cache for a package with its manifest-declared tools. */
export function updateCachedPackageTools(
  agentDir: string,
  packageName: string,
  tools: CachedTool[]
): void {
  const cache = readToolCache(agentDir);
  cache.packages[packageName] = {
    tools: tools.map((tool) => ({
      name: tool.name,
      description:
        typeof tool.description === "string" && tool.description.trim()
          ? tool.description.trim()
          : undefined,
    })),
  };
  writeToolCache(agentDir, cache);
}
