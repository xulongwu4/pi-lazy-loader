import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CACHE_FILENAME = "lazy-loader-cache.json";
export interface CachedRegistration {
  name: string;
  description?: string;
}

export interface CachedPackage {
  tools: CachedRegistration[];
  commands: CachedRegistration[];
}

export interface LazyLoaderCache {
  version: 1;
  packages: Record<string, CachedPackage>;
}

function normalizeRegistrations(value: unknown): CachedRegistration[] {
  if (!Array.isArray(value)) return [];
  const registrations: CachedRegistration[] = [];
  for (const item of value) {
    const name = typeof item === "string" ? item.trim() : typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const description =
      typeof item === "object" && typeof item?.description === "string" && item.description.trim()
        ? item.description.trim()
        : undefined;
    registrations.push({ name, description });
  }
  return registrations;
}

/** Read the unified command/tool cache. Invalid files fail soft as an empty cache. */
export function readCache(agentDir: string): LazyLoaderCache {
  const empty: LazyLoaderCache = { version: 1, packages: {} };
  const cachePath = join(agentDir, CACHE_FILENAME);
  if (!existsSync(cachePath)) return empty;

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (parsed?.version !== 1 || !parsed.packages || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
      return empty;
    }

    const packages: Record<string, CachedPackage> = {};
    for (const [name, value] of Object.entries(parsed.packages) as [string, any][]) {
      if (!Array.isArray(value?.tools) || !Array.isArray(value?.commands)) continue;
      packages[name] = {
        tools: normalizeRegistrations(value?.tools),
        commands: normalizeRegistrations(value?.commands),
      };
    }
    return { version: 1, packages };
  } catch {
    return empty;
  }
}

export function writeCache(agentDir: string, cache: LazyLoaderCache): void {
  try {
    writeFileSync(join(agentDir, CACHE_FILENAME), JSON.stringify(cache, null, 2), "utf-8");
  } catch (error: any) {
    console.warn(`[pi-lazy-loader] Failed to write cache: ${error?.message ?? error}`);
  }
}

/** Replace one package entry with every command and tool observed from that package. */
export function updateCachedPackage(
  agentDir: string,
  packageName: string,
  tools: CachedRegistration[],
  commands: CachedRegistration[]
): void {
  const cache = readCache(agentDir);
  cache.packages[packageName] = {
    tools: normalizeRegistrations(tools),
    commands: normalizeRegistrations(commands),
  };
  writeCache(agentDir, cache);
}
