import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
        tools: normalizeRegistrations(value.tools),
        commands: normalizeRegistrations(value.commands),
      };
    }
    return { version: 1, packages };
  } catch {
    return empty;
  }
}

export function selectCachedRegistrations(
  cached: CachedRegistration[],
  proxyNames?: string[]
): CachedRegistration[] {
  if (proxyNames === undefined) return cached;
  const cachedByName = new Map(cached.map((registration) => [registration.name, registration]));
  return proxyNames.map((name) => cachedByName.get(name) ?? { name });
}

function writeCacheFile(agentDir: string, cache: LazyLoaderCache): void {
  const cachePath = join(agentDir, CACHE_FILENAME);
  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tempPath, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(tempPath, cachePath);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function withCacheLock<T>(agentDir: string, operation: () => T): T {
  const lockPath = join(agentDir, `${CACHE_FILENAME}.lock`);
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(lockPath);
      try {
        return operation();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // The lock disappeared between checks; retry immediately.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(`Timed out waiting for cache lock at "${lockPath}"`);
}

export function writeCache(agentDir: string, cache: LazyLoaderCache): void {
  try {
    withCacheLock(agentDir, () => writeCacheFile(agentDir, cache));
  } catch (error: any) {
    console.warn(`[pi-lazy-loader] Failed to write cache: ${error?.message ?? error}`);
  }
}

/** Replace one package entry without losing updates from another Pi process. */
export function updateCachedPackage(
  agentDir: string,
  packageName: string,
  tools: CachedRegistration[],
  commands: CachedRegistration[]
): void {
  try {
    withCacheLock(agentDir, () => {
      const cache = readCache(agentDir);
      cache.packages[packageName] = {
        tools: normalizeRegistrations(tools),
        commands: normalizeRegistrations(commands),
      };
      writeCacheFile(agentDir, cache);
    });
  } catch (error: any) {
    console.warn(`[pi-lazy-loader] Failed to update cache: ${error?.message ?? error}`);
  }
}
