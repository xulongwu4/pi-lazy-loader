import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CACHE_FILENAME = "lazy-loader-cache.json";

export interface CachedRegistration {
  name: string;
  description?: string;
  /** JSON-schema parameters for a cached tool. Absent on old cache files and on commands. */
  parameters?: unknown;
  executionMode?: unknown;
  constrainedSampling?: unknown;
  hasPrepareArguments?: boolean;
}

/** True when `value` is a JSON-schema object the host can validate against. */
export function isCachedToolSchema(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as { type?: unknown; properties?: unknown };
  if (schema.type !== "object") return false;
  if (schema.properties === undefined) return true;
  return typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties);
}

function forEachJsonField(node: object, visit: (key: string, value: unknown) => void): void {
  for (const key of Reflect.ownKeys(node)) {
    if (typeof key !== "string") continue;
    const desc = Object.getOwnPropertyDescriptor(node, key);
    if (!desc || desc.get || desc.set || !desc.enumerable) continue;
    visit(key, desc.value);
  }
}

/** DAG clone: reuse already-cloned nodes (linear in unique objects). Cycles throw. */
export function cloneJsonValue(value: unknown): unknown {
  const memo = new WeakMap<object, unknown>();
  const stack = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    const hit = memo.get(node);
    if (hit !== undefined) return hit;
    if (stack.has(node)) throw new TypeError("cyclic structure");
    stack.add(node);
    try {
      if (Array.isArray(node)) {
        const copy: unknown[] = [];
        for (let i = 0; i < node.length; i++) copy.push(walk(node[i]));
        memo.set(node, copy);
        return copy;
      }
      const copy: Record<string, unknown> = {};
      forEachJsonField(node, (key, field) => {
        copy[key] = walk(field);
      });
      memo.set(node, copy);
      return copy;
    } finally {
      stack.delete(node);
    }
  };
  return walk(value);
}

export function schemasEquivalent(cached: unknown, live: unknown): boolean {
  const seen = new WeakMap<object, WeakMap<object, boolean>>();
  const walking = new WeakMap<object, WeakSet<object>>();
  const eq = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    const prev = seen.get(a)?.get(b);
    if (prev !== undefined) return prev;
    if (walking.get(a)?.has(b)) return false;
    let walkInner = walking.get(a);
    if (!walkInner) {
      walkInner = new WeakSet();
      walking.set(a, walkInner);
    }
    walkInner.add(b);
    let result = false;
    try {
      if (Array.isArray(a) !== Array.isArray(b)) {
        result = false;
      } else if (Array.isArray(a) && Array.isArray(b)) {
        result = a.length === b.length && a.every((item, i) => eq(item, b[i]));
      } else {
        const aFields: [string, unknown][] = [];
        const bFields: [string, unknown][] = [];
        forEachJsonField(a, (key, field) => aFields.push([key, field]));
        forEachJsonField(b, (key, field) => bFields.push([key, field]));
        result =
          aFields.length === bFields.length &&
          aFields.every(([key, field], i) => key === bFields[i][0] && eq(field, bFields[i][1]));
      }
    } finally {
      walkInner.delete(b);
    }
    let inner = seen.get(a);
    if (!inner) {
      inner = new WeakMap();
      seen.set(a, inner);
    }
    inner.set(b, result);
    return result;
  };
  return eq(cached, live);
}

/**
 * Ordinary TypeBox JSON Schema compositor tags. TypeBox documents these as
 * `~kind` / `~optional` / `~readonly` (see typebox Settings.enumerableKind).
 * JSON.stringify drops them; host validation ignores them. Semantic wrappers
 * (Refine / Codec / Transform / Unsafe) use other `~` keys and stay rejected so
 * cached parameters always round-trip. Fail closed: any unknown `~` key or
 * symbol is non-representable. TypeBox does not export a stable allowlist.
 */
const TYPEBOX_JSON_META = new Set(["~kind", "~optional", "~readonly"]);

/** False for cycles, functions, symbols, non-finite numbers, non-plain objects, and TypeBox refinements/codecs/custom constraints. */
export function schemaIsJsonRepresentable(value: unknown): boolean {
  const stack = new WeakSet<object>();
  const memo = new WeakMap<object, boolean>();
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node !== "object") return false;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (stack.has(node)) return false;
    stack.add(node);
    let ok = false;
    try {
      if (Array.isArray(node)) {
        ok = node.every(walk);
      } else {
        const proto = Object.getPrototypeOf(node);
        if (proto !== Object.prototype && proto !== null) {
          ok = false;
        } else {
          ok = true;
          for (const key of Reflect.ownKeys(node)) {
            if (typeof key === "symbol") {
              ok = false;
              break;
            }
            if (typeof key === "string" && key.startsWith("~") && !TYPEBOX_JSON_META.has(key)) {
              ok = false;
              break;
            }
            const desc = Object.getOwnPropertyDescriptor(node, key);
            if (!desc || desc.get || desc.set) {
              ok = false;
              break;
            }
            if (!desc.enumerable && !(typeof key === "string" && TYPEBOX_JSON_META.has(key))) {
              ok = false;
              break;
            }
            if (!walk(desc.value)) {
              ok = false;
              break;
            }
          }
        }
      }
    } finally {
      stack.delete(node);
    }
    memo.set(node, ok);
    return ok;
  };
  return walk(value);
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
    const raw = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined;
    const rawParameters = raw?.parameters;
    const parameters = isCachedToolSchema(rawParameters) ? rawParameters : undefined;
    const executionMode = raw && "executionMode" in raw ? raw.executionMode : undefined;
    const constrainedSampling = raw && "constrainedSampling" in raw ? raw.constrainedSampling : undefined;
    const hasPrepareArguments = raw?.hasPrepareArguments === true ? true : undefined;
    registrations.push({ name, description, parameters, executionMode, constrainedSampling, hasPrepareArguments });
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
