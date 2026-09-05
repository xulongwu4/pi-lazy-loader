import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const TOOL_CACHE_FILENAME = "lazy-loader-tools.json";
export const MAX_CACHE_FILE_SIZE = 64 * 1024; // 64 KiB
export const MAX_LAZY_LOAD_PROMPT_BUDGET = 1200;
export const MAX_TOOLS_PER_PACKAGE = 6;

export interface CachedTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: any;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: "sequential" | "parallel" | string;
  hasPrepareArguments?: boolean;
}

export interface CachedPackageTools {
  fingerprint: string;
  tools: CachedTool[];
}

export interface ToolCacheData {
  version: 2;
  packages: Record<string, CachedPackageTools>;
}

export interface LazyLoadGuidance {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameterDescription: string;
}

/**
 * Structural comparison of a value against its JSON round trip.
 *
 * Walks **own enumerable string keys only** — symbol-keyed properties are library
 * bookkeeping (`@sinclair/typebox` attaches `Symbol.for("TypeBox.Kind")` to every schema)
 * that a stub never needs, so their loss is not data loss. Numbers compare with
 * `Object.is`, so `-0` collapsing to `0` is caught. Array key ownership is compared, so
 * holes filled with `null` and discarded custom array properties are caught. Non-plain
 * prototypes are rejected outright, since `Map`/`Set` serialize to `{}` and would
 * otherwise compare equal to their own empty round trip.
 */
function matchesJsonRoundTrip(original: any, parsed: any): boolean {
  if (typeof original === "number" || typeof parsed === "number") {
    return Object.is(original, parsed);
  }
  if (original === null || parsed === null) return original === parsed;
  if (typeof original !== "object" || typeof parsed !== "object") return original === parsed;
  if (Array.isArray(original) !== Array.isArray(parsed)) return false;

  if (!Array.isArray(original)) {
    const proto = Object.getPrototypeOf(original);
    if (proto !== Object.prototype && proto !== null) return false;
  } else if (original.length !== parsed.length) {
    return false;
  }

  const originalKeys = Object.keys(original);
  const parsedKeys = Object.keys(parsed);
  if (originalKeys.length !== parsedKeys.length) return false;
  for (const key of originalKeys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return false;
    if (!matchesJsonRoundTrip(original[key], parsed[key])) return false;
  }
  return true;
}

/**
 * True when `value` survives an actual JSON round trip without losing anything we need.
 * Cycles and bigints make `JSON.stringify` throw and are reported as lossy.
 */
export function isJsonLossless(value: any): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(JSON.stringify(value));
  } catch {
    return false;
  }
  return matchesJsonRoundTrip(value, parsed);
}

/**
 * Extract the cacheable metadata fields from a captured tool definition.
 *
 * Returns `undefined` for anything without a usable name, so callers skip it rather than
 * minting a placeholder tool. A returned entry carrying only `name` means "name-only":
 * legacy, degraded, or unserializable. A fully harvested entry always carries an explicit
 * `hasPrepareArguments`, so v0.4.0 can tell "confirmed no prepare hook" from "unknown".
 *
 * Never stores `constrainedSampling`, `renderShell`, `renderCall`, or `renderResult`.
 */
export function sanitizeToolDefinition(tool: any): CachedTool | undefined {
  if (typeof tool === "string") {
    const name = tool.trim();
    return name.length > 0 ? { name } : undefined;
  }
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
    return undefined;
  }
  const name = tool.name.trim();
  if (name.length === 0) return undefined;

  const entry: CachedTool = { name };

  if (typeof tool.label === "string") entry.label = tool.label;
  if (typeof tool.description === "string") entry.description = tool.description;
  if (tool.parameters !== undefined) entry.parameters = tool.parameters;
  if (typeof tool.promptSnippet === "string") entry.promptSnippet = tool.promptSnippet;
  if (Array.isArray(tool.promptGuidelines)) {
    entry.promptGuidelines = tool.promptGuidelines.filter((g: any) => typeof g === "string");
  }
  if (typeof tool.executionMode === "string") entry.executionMode = tool.executionMode;

  // Name-only input stays name-only: absence of the flag means "metadata unknown".
  if (Object.keys(entry).length === 1 && tool.hasPrepareArguments === undefined) {
    return entry;
  }

  entry.hasPrepareArguments =
    typeof tool.prepareArguments === "function" || tool.hasPrepareArguments === true;

  if (!isJsonLossless(entry)) {
    return { name };
  }
  return entry;
}

/**
 * Resolve Pi's version by walking upward from the running CLI entrypoint.
 * Managed git extensions cannot resolve Pi through their own peer-dependency tree,
 * but `process.argv[1]` still lives inside Pi's installed package.
 */
export function getPiRuntimeVersionFromEntrypoint(entrypoint = process.argv[1]): string | undefined {
  if (!entrypoint) return undefined;
  let dir = dirname(entrypoint);
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (
        pkg?.name === "@earendil-works/pi-coding-agent" &&
        typeof pkg.version === "string"
      ) {
        return pkg.version;
      }
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve runtime Pi ABI version. Peer resolution works in a source checkout; walking
 * from the CLI entrypoint covers Pi-managed git installs. Fails soft to "unknown".
 */
export function getPiRuntimeVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@earendil-works/pi-coding-agent/package.json");
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {}
  return getPiRuntimeVersionFromEntrypoint() ?? "unknown";
}

/**
 * Compute fingerprint for a package: <pkg version>:<max entry mtimeMs>:<pi ABI version>
 */
export function computePackageFingerprint(
  packageRoot: string,
  entryPaths: string[],
  piAbiVersion?: string
): string {
  let version = "unknown";
  try {
    const pkgJsonPath = join(packageRoot, "package.json");
    if (existsSync(pkgJsonPath)) {
      const data = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (typeof data.version === "string") {
        version = data.version;
      }
    }
  } catch {}

  let maxMtime = 0;
  for (const entry of entryPaths) {
    try {
      if (existsSync(entry)) {
        const st = statSync(entry);
        if (st.mtimeMs > maxMtime) {
          maxMtime = st.mtimeMs;
        }
      }
    } catch {}
  }

  const piAbi = piAbiVersion ?? getPiRuntimeVersion();
  return `${version}:${Math.floor(maxMtime)}:${piAbi}`;
}

/**
 * Read tool cache from ${agentDir}/lazy-loader-tools.json.
 * Follows command-config conventions: 64 KiB read cap, unknown/invalid fails soft (never throws).
 * Transparently upgrades v1 cache files to v2 format with name-only entries.
 */
export function readToolCache(agentDir: string): ToolCacheData {
  const filePath = join(agentDir, TOOL_CACHE_FILENAME);
  const empty: ToolCacheData = { version: 2, packages: {} };

  if (!existsSync(filePath)) {
    return empty;
  }

  try {
    const st = statSync(filePath);
    if (st.size > MAX_CACHE_FILE_SIZE) {
      return empty;
    }

    const content = readFileSync(filePath, "utf-8");
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return empty;
    }

    if (!parsed || typeof parsed !== "object") {
      return empty;
    }

    if (parsed.version !== 1 && parsed.version !== 2) {
      return empty;
    }

    if (!parsed.packages || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
      return empty;
    }

    const packages: Record<string, CachedPackageTools> = {};
    for (const [pkgName, pkgVal] of Object.entries(parsed.packages)) {
      if (!pkgVal || typeof pkgVal !== "object" || Array.isArray(pkgVal)) {
        continue;
      }
      const p = pkgVal as any;
      if (typeof p.fingerprint !== "string" || !Array.isArray(p.tools)) {
        continue;
      }

      // A v1 file is normalized, never discarded: each string becomes a name-only entry.
      const tools: CachedTool[] = [];
      for (const t of p.tools) {
        const sanitized = sanitizeToolDefinition(t);
        if (sanitized) tools.push(sanitized);
      }

      packages[pkgName] = {
        fingerprint: p.fingerprint,
        tools,
      };
    }

    return {
      version: 2,
      packages,
    };
  } catch {
    return empty;
  }
}

/**
 * Write tool cache to disk. Must never throw out of the loader — wrapped and reported.
 * Degrades metadata to names if content exceeds MAX_CACHE_FILE_SIZE.
 */
export function writeToolCache(agentDir: string, cache: ToolCacheData): boolean {
  try {
    const filePath = join(agentDir, TOOL_CACHE_FILENAME);
    let content = JSON.stringify(cache, null, 2);

    // Section C: If serialized cache exceeds MAX_CACHE_FILE_SIZE, degrade gracefully:
    // drop metadata (keeping names) rather than losing packages or throwing.
    if (Buffer.byteLength(content, "utf-8") > MAX_CACHE_FILE_SIZE) {
      const degradedPackages: string[] = [];
      const degradedPackagesMap: Record<string, CachedPackageTools> = {};

      for (const [pkgName, pkgEntry] of Object.entries(cache.packages)) {
        const hasMetadata = pkgEntry.tools.some((t: any) => {
          if (typeof t === "string") return false;
          return Object.keys(t).length > 1;
        });

        if (hasMetadata) {
          degradedPackages.push(pkgName);
          degradedPackagesMap[pkgName] = {
            fingerprint: pkgEntry.fingerprint,
            tools: pkgEntry.tools.map((t: any) => ({
              name: typeof t === "string" ? t : t.name,
            })),
          };
        } else {
          degradedPackagesMap[pkgName] = pkgEntry;
        }
      }

      if (degradedPackages.length > 0) {
        // Note in the code which packages were degraded
        console.warn(
          `[pi-lazy-loader] Tool cache exceeded ${MAX_CACHE_FILE_SIZE} bytes; degraded metadata to names for packages: ${degradedPackages.join(", ")}`
        );
        const degradedCache: ToolCacheData = {
          ...cache,
          packages: degradedPackagesMap,
        };
        content = JSON.stringify(degradedCache, null, 2);
      }
    }

    if (Buffer.byteLength(content, "utf-8") > MAX_CACHE_FILE_SIZE) {
      console.error(
        `[pi-lazy-loader] Tool cache still exceeds ${MAX_CACHE_FILE_SIZE} bytes after degradation; skipping write`
      );
      return false;
    }

    writeFileSync(filePath, content, "utf-8");
    return true;
  } catch (err: any) {
    console.error(
      `[pi-lazy-loader] Failed to write tool cache at "${join(agentDir, TOOL_CACHE_FILENAME)}": ${err?.message ?? err}`
    );
    return false;
  }
}

/**
 * Update cached tools for a single package. Safe wrapper around read + write.
 */
export function updateCachedPackageTools(
  agentDir: string,
  packageName: string,
  fingerprint: string,
  tools: Array<string | CachedTool | any>
): void {
  try {
    const cache = readToolCache(agentDir);

    // Last registration wins, matching Pi's `extension.tools.set(tool.name, ...)`.
    const byName = new Map<string, CachedTool>();
    const degraded: string[] = [];
    for (const tool of tools) {
      const sanitized = sanitizeToolDefinition(tool);
      if (!sanitized) continue;
      if (
        tool &&
        typeof tool === "object" &&
        Object.keys(sanitized).length === 1 &&
        Object.keys(tool).length > 1
      ) {
        degraded.push(sanitized.name);
      }
      byName.set(sanitized.name, sanitized);
    }

    if (degraded.length > 0) {
      console.warn(
        `[pi-lazy-loader] Tool metadata for "${packageName}" was not serializable; cached name-only: ${degraded.join(", ")}`
      );
    }

    const sanitizedTools = Array.from(byName.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );

    cache.version = 2;
    cache.packages[packageName] = {
      fingerprint,
      tools: sanitizedTools,
    };
    writeToolCache(agentDir, cache);
  } catch (err: any) {
    console.error(
      `[pi-lazy-loader] Failed to update tool cache for "${packageName}": ${err?.message ?? err}`
    );
  }
}

/**
 * Calculate total generated prompt characters across all guidance fields.
 */
export function computeGuidancePromptLength(guidance: LazyLoadGuidance): number {
  const guidelinesLen = guidance.promptGuidelines.reduce((acc, g) => acc + g.length, 0);
  return (
    guidance.description.length +
    guidance.promptSnippet.length +
    guidelinesLen +
    guidance.parameterDescription.length
  );
}

/**
 * Build lazy_load description and prompt guidelines from deferred packages and tool cache.
 * Bounded by MAX_LAZY_LOAD_PROMPT_BUDGET across all generated prompt text combined.
 */
export function buildLazyLoadGuidance(
  deferred: Array<{ name: string; capability: string }>,
  cache: ToolCacheData,
  budget: number = MAX_LAZY_LOAD_PROMPT_BUDGET
): LazyLoadGuidance {
  const promptSnippet = "Load deferred capabilities";
  const promptGuidelines = [
    deferred.length === 0
      ? "Use lazy_load before claiming a deferred capability is unavailable."
      : "Use lazy_load before claiming a deferred capability or tool is unavailable.",
  ];
  const parameterDescription = "Package name or source to load.";

  const fixedLength =
    promptSnippet.length +
    promptGuidelines.reduce((acc, g) => acc + g.length, 0) +
    parameterDescription.length;
  const descBudget = Math.max(0, budget - fixedLength);

  if (deferred.length === 0) {
    const defaultDesc = "Load a deferred Pi extension on demand. No packages are currently deferred.";
    const description =
      defaultDesc.length <= descBudget
        ? defaultDesc
        : defaultDesc.slice(0, descBudget);
    return {
      description,
      promptSnippet,
      promptGuidelines,
      parameterDescription,
    };
  }

  const prefix = "Load a deferred Pi extension on demand:";
  const items: string[] = [];

  for (const pkg of deferred) {
    const cachedTools = cache.packages[pkg.name]?.tools ?? [];
    const toolNames = cachedTools
      .map((t: any) => (typeof t === "string" ? t : t?.name))
      .filter((n: any): n is string => typeof n === "string" && n.length > 0);
    const toolsSuffix =
      toolNames.length > 0
        ? ` (tools: ${toolNames.slice(0, MAX_TOOLS_PER_PACKAGE).join(", ")})`
        : "";
    items.push(`${pkg.name} — ${pkg.capability}${toolsSuffix}`);
  }

  const fullDescription = `${prefix}\n${items.map((it) => `- ${it}`).join("\n")}`;
  let description = "";

  if (fullDescription.length <= descBudget) {
    description = fullDescription;
  } else {
    for (let kept = items.length - 1; kept >= 0; kept--) {
      const dropped = items.length - kept;
      const marker = `(+${dropped} more, see /lazy list)`;
      const candidate =
        kept > 0
          ? `${prefix}\n${items.slice(0, kept).map((it) => `- ${it}`).join("\n")}\n${marker}`
          : `${prefix}\n${marker}`;

      if (candidate.length <= descBudget) {
        description = candidate;
        break;
      }
    }

    if (!description) {
      const marker = `(+${items.length} more, see /lazy list)`;
      description = marker.length <= descBudget ? marker : marker.slice(0, descBudget);
    }
  }

  return {
    description,
    promptSnippet,
    promptGuidelines,
    parameterDescription,
  };
}