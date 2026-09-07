import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverLazyPackages, getUserAgentDir } from "./resolver.js";
import { findPackageDefinition } from "./package.js";
import { npmPackageName, packageSourceAliases } from "./package-locator.js";

export interface PinResult {
  success: boolean;
  package: string;
  source: string;
  settingsPath: string;
  previousEntry: any;
  updatedEntry: any;
}

export function getUserSettingsPath(agentDir?: string): string {
  const dir = agentDir ?? getUserAgentDir();
  return join(dir, "settings.json");
}

function packageNameFromSource(source: string): string {
  return source.trim().startsWith("npm:") ? npmPackageName(source.trim().slice(4)) : source;
}

/** Check a settings entry by exact source or canonical npm package name. */
export function isPackageMatch(item: any, identifier: string): boolean {
  const source = typeof item === "string" ? item : (item?.source ?? "");
  if (!source) return false;
  const expected = packageSourceAliases(identifier);
  return Array.from(packageSourceAliases(source)).some((alias) => expected.has(alias));
}

/**
 * Pure function: Transform settings object in memory to pin a deferred package to eager.
 * Refuses missing or ambiguous matching entries.
 * Preserves unknown properties on the package object.
 */
export function transformPinSettings(settings: Record<string, any>, packageInput: string): {
  updatedSettings: Record<string, any>;
  packageName: string;
  previousEntry: any;
  updatedEntry: any;
} {
  const rawPackages = settings.packages;

  if (!Array.isArray(rawPackages)) {
    throw new Error(`Invalid settings format: "packages" is not an array.`);
  }

  // Find all matching indices
  const matchingIndices: number[] = [];
  for (let i = 0; i < rawPackages.length; i++) {
    if (isPackageMatch(rawPackages[i], packageInput)) {
      matchingIndices.push(i);
    }
  }

  if (matchingIndices.length === 0) {
    throw new Error(`Cannot pin "${packageInput}": package not found in settings packages list.`);
  }

  if (matchingIndices.length > 1) {
    throw new Error(
      `Cannot pin "${packageInput}": ambiguous matches in settings packages list (${matchingIndices.length} entries matched).`
    );
  }

  const index = matchingIndices[0];
  const targetEntry = rawPackages[index];

  if (typeof targetEntry === "string") {
    throw new Error(
      `Cannot pin "${packageInput}": package is configured as eager string "${targetEntry}", not a deferred object with "extensions: []".`
    );
  }

  if (typeof targetEntry !== "object" || targetEntry === null) {
    throw new Error(`Cannot pin "${packageInput}": invalid package entry in settings at index ${index}.`);
  }

  // Must have extensions: []
  if (!Array.isArray(targetEntry.extensions) || targetEntry.extensions.length !== 0) {
    throw new Error(
      `Cannot pin "${packageInput}": package does not have "extensions: []" configured (current value: ${JSON.stringify(
        targetEntry.extensions
      )}). Nothing to pin.`
    );
  }

  // Preserve all properties except "extensions"
  const { extensions: _removed, ...rest } = targetEntry;

  const newPackages = [...rawPackages];
  newPackages[index] = rest;

  const updatedSettings = {
    ...settings,
    packages: newPackages,
  };

  const source = targetEntry.source;
  const packageName = packageNameFromSource(source);
  return {
    updatedSettings,
    packageName,
    previousEntry: targetEntry,
    updatedEntry: rest,
  };
}

/**
 * Atomically pin a deferred package in a settings.json file.
 * Refuses missing/ambiguous entries, preserves unknown properties, writes atomically.
 */
export function pinPackageInSettingsFile(settingsPath: string, packageInput: string): PinResult {
  if (!existsSync(settingsPath)) {
    throw new Error(`Settings file not found at "${settingsPath}".`);
  }

  let rawContent: string;
  let parsedSettings: Record<string, any>;
  try {
    rawContent = readFileSync(settingsPath, "utf-8");
    parsedSettings = JSON.parse(rawContent);
  } catch (err: any) {
    throw new Error(`Failed to read/parse settings file at "${settingsPath}": ${err?.message ?? err}`);
  }

  const packageDefinition = findPackageDefinition(discoverLazyPackages(dirname(settingsPath)), packageInput);
  const { updatedSettings, packageName, previousEntry, updatedEntry } = transformPinSettings(
    parsedSettings,
    packageDefinition?.source ?? packageInput
  );

  // Atomic write via temp file + rename
  const dir = dirname(settingsPath);
  const tempPath = join(dir, `.settings.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const serialized = JSON.stringify(updatedSettings, null, 2) + "\n";

  try {
    writeFileSync(tempPath, serialized, "utf-8");
    renameSync(tempPath, settingsPath);
  } catch (err: any) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {}
    throw new Error(`Failed to atomically write settings to "${settingsPath}": ${err?.message ?? err}`);
  }

  return {
    success: true,
    package: packageDefinition?.name ?? packageName,
    source: previousEntry.source,
    settingsPath,
    previousEntry,
    updatedEntry,
  };
}
