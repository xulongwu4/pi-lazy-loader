import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageDefinition } from "./package.js";
import { resolvePackageDefinition } from "./resolver.js";

export const CONFIG_FILENAME = "lazy-loader.json";

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

/** Read the explicit lazy package catalog and optional command/tool proxy filters. */
export function readLazyLoaderConfig(agentDir: string): LazyLoaderConfigResult {
  const configPath = join(agentDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) return { packages: [], diagnostics: [] };

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error: any) {
    return { packages: [], diagnostics: [`Failed to parse "${configPath}": ${error?.message ?? error}`] };
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.packages)) {
    return { packages: [], diagnostics: [`"${configPath}" must contain a packages array`] };
  }
  const unknownTopLevel = Object.keys(raw).filter((key) => key !== "packages" && key !== "$schema");
  if (unknownTopLevel.length > 0) {
    return { packages: [], diagnostics: [`"${configPath}" has unknown properties: ${unknownTopLevel.join(", ")}`] };
  }

  const packages = new Map<string, PackageDefinition>();
  const diagnostics: string[] = [];
  for (const item of raw.packages) {
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

/** Remove one exact configured source; the change takes effect after reload. */
export function removeLazyPackage(agentDir: string, source: string): void {
  const configPath = join(agentDir, CONFIG_FILENAME);
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!Array.isArray(raw?.packages)) throw new Error(`"${configPath}" must contain a packages array`);
  const packages = raw.packages.filter((item: any) =>
    (typeof item === "string" ? item.trim() : item?.source?.trim()) !== source
  );
  if (packages.length === raw.packages.length) throw new Error(`Package "${source}" is not in ${configPath}`);
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify({ ...raw, packages }, null, 2), "utf-8");
  renameSync(tempPath, configPath);
}
