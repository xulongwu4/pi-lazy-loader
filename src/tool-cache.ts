import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOOL_CACHE_FILENAME = "lazy-loader-tools.json";
export const MAX_CACHE_FILE_SIZE = 64 * 1024; // 64 KiB
export const MAX_LAZY_LOAD_PROMPT_BUDGET = 1200;
export const MAX_TOOLS_PER_PACKAGE = 6;

export interface CachedPackageTools {
  fingerprint: string;
  tools: string[];
}

export interface ToolCacheData {
  version: 1;
  packages: Record<string, CachedPackageTools>;
}

export interface LazyLoadGuidance {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameterDescription: string;
}

/**
 * Compute fingerprint for a package: <pkg version>:<max entry mtimeMs>
 */
export function computePackageFingerprint(packageRoot: string, entryPaths: string[]): string {
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

  return `${version}:${Math.floor(maxMtime)}`;
}

/**
 * Read tool cache from ${agentDir}/lazy-loader-tools.json.
 * Follows command-config conventions: 64 KiB read cap, unknown/invalid fails soft (never throws).
 */
export function readToolCache(agentDir: string): ToolCacheData {
  const filePath = join(agentDir, TOOL_CACHE_FILENAME);
  const empty: ToolCacheData = { version: 1, packages: {} };

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

    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
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
      const p = pkgVal as Record<string, any>;
      if (typeof p.fingerprint !== "string" || !Array.isArray(p.tools)) {
        continue;
      }
      const tools = p.tools.filter((t: any): t is string => typeof t === "string" && t.length > 0);
      packages[pkgName] = {
        fingerprint: p.fingerprint,
        tools,
      };
    }

    return {
      version: 1,
      packages,
    };
  } catch {
    return empty;
  }
}

/**
 * Write tool cache to disk. Must never throw out of the loader — wrapped and reported.
 */
export function writeToolCache(agentDir: string, cache: ToolCacheData): boolean {
  try {
    const filePath = join(agentDir, TOOL_CACHE_FILENAME);
    const content = JSON.stringify(cache, null, 2);
    writeFileSync(filePath, content, "utf-8");
    return true;
  } catch (err: any) {
    console.error(`[pi-lazy-loader] Failed to write tool cache at "${join(agentDir, TOOL_CACHE_FILENAME)}": ${err?.message ?? err}`);
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
  tools: string[]
): void {
  try {
    const cache = readToolCache(agentDir);
    cache.packages[packageName] = {
      fingerprint,
      tools: Array.from(new Set(tools)).sort(),
    };
    writeToolCache(agentDir, cache);
  } catch (err: any) {
    console.error(`[pi-lazy-loader] Failed to update tool cache for "${packageName}": ${err?.message ?? err}`);
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
    const toolsSuffix =
      cachedTools.length > 0
        ? ` (tools: ${cachedTools.slice(0, MAX_TOOLS_PER_PACKAGE).join(", ")})`
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
