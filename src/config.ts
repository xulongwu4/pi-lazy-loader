import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageDefinition } from "./package.js";
import { resolvePackageDefinition } from "./resolver.js";

export const CONFIG_FILENAME = "lazy-loader.json";
export const SETTINGS_FILENAME = "settings.json";
export const SETTINGS_KEY = "lazy-loader";

export interface LazyLoaderConfigResult {
  packages: PackageDefinition[];
  diagnostics: string[];
}

function proxyNames(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value)) throw new Error(`"${field}" for "${source}" must be an array`);
  const names = value.map((name) => {
    if (typeof name !== "string" || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error(`"${field}" for "${source}" contains an invalid proxy name`);
    }
    return name.trim();
  });
  return [...new Set(names)];
}

interface LazyConfigSource {
  /** File the catalog was read from (and writes target). */
  path: string;
  /** Raw parsed content of that file. */
  raw: any;
  /** The object holding the lazy entries (the settings root for inline form, or the catalog sub-object). */
  catalog: any;
  /** Which shape `catalog` holds. */
  kind: "inline" | "key" | "file";
  /** Human label for diagnostics. */
  label: string;
  /** Non-fatal diagnostics collected while locating (e.g. malformed entries that were skipped). */
  diagnostics: string[];
}

const LAZY_FLAG = "lazy";

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Extract the lazy entry list from a settings.json `packages` array.
 *  An entry is lazy when it is an object carrying `"lazy": true` or a `"lazy": {...}` options object.
 *  Malformed entries are skipped with a diagnostic rather than aborting the whole catalog. */
function inlineLazyEntries(settings: any): { entries: any[]; diagnostics: string[] } {
  const list = settings?.packages;
  if (!Array.isArray(list)) return { entries: [], diagnostics: [] };
  const entries: any[] = [];
  const diagnostics: string[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || !Object.hasOwn(item, LAZY_FLAG)) continue;
    const flag = item[LAZY_FLAG];
    if (flag === false) continue;
    const source = typeof item.source === "string" ? item.source.trim() : "";
    if (!source) {
      diagnostics.push(`a "lazy" package entry is missing a valid "source"`);
      continue;
    }
    if (flag === true) {
      entries.push({ source });
    } else if (flag !== null && typeof flag === "object" && !Array.isArray(flag)) {
      const unknown = Object.keys(flag).filter((key) => !["commands", "tools", "guidelines"].includes(key));
      if (unknown.length > 0) {
        diagnostics.push(`"lazy" for "${source}" has unknown properties: ${unknown.join(", ")}`);
        continue;
      }
      // Keep the entry even if a filter value is malformed — a bad "tools" value must not
      // silently disable the package (it is likely paired with "extensions": [] already).
      const clean: any = { source };
      for (const field of ["commands", "tools", "guidelines"] as const) {
        if (!Object.hasOwn(flag, field)) continue;
        try {
          clean[field] = proxyNames(flag[field], `lazy.${field}`, source);
        } catch (error: any) {
          diagnostics.push(`"lazy.${field}" for "${source}" is invalid (${error?.message ?? error}); ignoring it`);
        }
      }
      entries.push(clean);
    } else {
      diagnostics.push(`"lazy" for "${source}" must be true, false, or an options object`);
    }
  }
  return { entries, diagnostics };
}

/** Resolve the catalog location. Precedence: inline `"lazy"` entries in settings.json packages
 *  → settings.json "lazy-loader" key → lazy-loader.json. A broken settings.json warns but
 *  does not block the lazy-loader.json fallback. */
function locateConfig(agentDir: string): LazyConfigSource | { diagnostics: string[] } | null {
  const settingsPath = join(agentDir, SETTINGS_FILENAME);
  const diagnostics: string[] = [];
  if (existsSync(settingsPath)) {
    let settings: any;
    try {
      settings = readJson(settingsPath);
    } catch (error: any) {
      diagnostics.push(`Failed to parse "${settingsPath}": ${error?.message ?? error}`);
    }
    if (settings && typeof settings === "object") {
      const inline = inlineLazyEntries(settings);
      diagnostics.push(...inline.diagnostics.map((d) => `"${settingsPath}" packages: ${d}`));
      if (inline.entries.length > 0) {
        // Inline wins; still surface a malformed shadowed "lazy-loader" key so a stale
        // catalog does not silently resurrect after the last inline entry is pinned.
        const shadowed = settings[SETTINGS_KEY];
        if (Object.hasOwn(settings, SETTINGS_KEY) &&
            (!shadowed || typeof shadowed !== "object" || Array.isArray(shadowed) || !Array.isArray(shadowed.packages))) {
          diagnostics.push(`"${settingsPath}" ${SETTINGS_KEY} is shadowed by inline "lazy" entries and is malformed`);
        }
        return {
          path: settingsPath,
          raw: settings,
          catalog: { packages: inline.entries },
          kind: "inline",
          label: `"${settingsPath}" packages "lazy" entries`,
          diagnostics,
        };
      }
      if (Object.hasOwn(settings, SETTINGS_KEY)) {
        const catalog = settings[SETTINGS_KEY];
        const label = `"${settingsPath}" ${SETTINGS_KEY}`;
        const keyValid = catalog && typeof catalog === "object" && !Array.isArray(catalog) && Array.isArray(catalog.packages);
        const unknownTopLevel = keyValid
          ? Object.keys(catalog).filter((key) => key !== "packages" && key !== "$schema")
          : [];
        if (!keyValid) {
          diagnostics.push(`${label} must contain a packages array`);
        } else if (unknownTopLevel.length > 0) {
          diagnostics.push(`${label} has unknown properties: ${unknownTopLevel.join(", ")}`);
        } else {
          return { path: settingsPath, raw: settings, catalog, kind: "key", label, diagnostics };
        }
      }
    }
  }

  const configPath = join(agentDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return diagnostics.length > 0 ? { diagnostics } : null;
  }
  let raw: any;
  try {
    raw = readJson(configPath);
  } catch (error: any) {
    return { diagnostics: [...diagnostics, `Failed to parse "${configPath}": ${error?.message ?? error}`] };
  }
  const label = `"${configPath}"`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.packages)) {
    return { diagnostics: [...diagnostics, `${label} must contain a packages array`] };
  }
  const unknownTopLevel = Object.keys(raw).filter((key) => key !== "packages" && key !== "$schema");
  if (unknownTopLevel.length > 0) {
    return { diagnostics: [...diagnostics, `${label} has unknown properties: ${unknownTopLevel.join(", ")}`] };
  }
  return { path: configPath, raw, catalog: raw, kind: "file", label, diagnostics };
}

/** Write back through the resolved symlink target so dotfiles links are preserved.
 *  File mode of the existing target is preserved (settings.json may hold secrets at 0600). */
function writeConfig(source: LazyConfigSource, packages: any[], removedSources?: string[]): void {
  if (source.kind === "file") {
    source.raw = { ...source.raw, packages };
  } else if (source.kind === "key") {
    source.raw = { ...source.raw, [SETTINGS_KEY]: { ...source.catalog, packages } };
  } else {
    // inline: strip "lazy" (and the "extensions": [] that only existed to defer it) from removed entries
    const removed = new Set(removedSources ?? []);
    source.raw = {
      ...source.raw,
      packages: (source.raw.packages ?? []).map((item: any) => {
        if (typeof item !== "object" || item === null || !removed.has(typeof item.source === "string" ? item.source.trim() : "")) {
          return item;
        }
        return Object.fromEntries(
          Object.entries(item).filter(([key, value]) =>
            key !== LAZY_FLAG && !(key === "extensions" && Array.isArray(value) && value.length === 0)
          )
        );
      }),
    };
  }
  const target = realpathSync(source.path);
  let mode = 0o600;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    // keep the restrictive default
  }
  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(source.raw, null, 2), { encoding: "utf-8", mode, flag: "wx" });
    renameSync(tempPath, target);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Read the explicit lazy package catalog and optional command/tool proxy filters.
 *  Precedence: inline "lazy" entries in settings.json packages → settings.json "lazy-loader" → lazy-loader.json. */
export function readLazyLoaderConfig(agentDir: string): LazyLoaderConfigResult {
  const located = locateConfig(agentDir);
  if (!located) return { packages: [], diagnostics: [] };
  if ("diagnostics" in located && !("catalog" in located)) return { packages: [], diagnostics: located.diagnostics };
  const src = located as LazyConfigSource;
  const { catalog } = src;

  const packages = new Map<string, PackageDefinition>();
  const diagnostics: string[] = [...src.diagnostics];
  for (const item of catalog.packages) {
    try {
      const source = typeof item === "string" ? item : item?.source;
      if (typeof source !== "string" || !source.trim()) throw new Error("package source must be a non-empty string");
      const definition = resolvePackageDefinition(source.trim(), agentDir);
      if (typeof item === "object" && item !== null) {
        const unknown = Object.keys(item).filter((key) => !["source", "commands", "tools", "guidelines"].includes(key));
        if (unknown.length > 0) throw new Error(`"${source}" has unknown properties: ${unknown.join(", ")}`);
        if (Object.hasOwn(item, "commands")) definition.proxyCommands = proxyNames(item.commands, "commands", source);
        if (Object.hasOwn(item, "tools")) definition.proxyTools = proxyNames(item.tools, "tools", source);
        if (Object.hasOwn(item, "guidelines")) definition.guidelineTools = proxyNames(item.guidelines, "guidelines", source);
      }
      if (packages.has(definition.name)) throw new Error(`duplicate package name "${definition.name}"`);
      packages.set(definition.name, definition);
    } catch (error: any) {
      diagnostics.push(`Invalid lazy package entry: ${error?.message ?? error}`);
    }
  }
  return { packages: Array.from(packages.values()), diagnostics };
}

/** Remove one exact configured source; the change takes effect after reload.
 *  Returns the human-readable label of the catalog that was written. */
export function removeLazyPackage(agentDir: string, source: string): string {
  const located = locateConfig(agentDir);
  if (!located || !("catalog" in located)) {
    const detail = located && "diagnostics" in located && located.diagnostics.length > 0
      ? `: ${located.diagnostics.join("; ")}`
      : "";
    throw new Error(`No lazy package catalog found${detail}`);
  }
  const src = located as LazyConfigSource;
  const packages = src.catalog.packages.filter((item: any) =>
    (typeof item === "string" ? item.trim() : item?.source?.trim()) !== source
  );
  if (packages.length === src.catalog.packages.length) {
    throw new Error(`Package "${source}" is not in ${src.label}`);
  }
  writeConfig(src, packages, src.kind === "inline" ? [source] : undefined);
  return src.label;
}
