import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findManifestEntry, type ManifestEntry } from "./manifest.js";
import { getUserAgentDir } from "./resolver.js";

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

/**
 * Check if a packages array item matches a package identifier or manifest entry.
 */
export function isPackageMatch(item: any, identifier: string, manifest?: ManifestEntry): boolean {
  const sourceStr = typeof item === "string" ? item : (item?.source ?? "");
  if (!sourceStr) return false;

  const normalizedInput = identifier.trim().toLowerCase();
  const normalizedSource = sourceStr.trim().toLowerCase();

  // 1. Direct match with input string
  if (normalizedSource === normalizedInput) return true;
  if (normalizedSource === `npm:${normalizedInput}`) return true;
  if (normalizedSource === `git:${normalizedInput}`) return true;
  if (`npm:${normalizedSource}` === normalizedInput) return true;
  if (`git:${normalizedSource}` === normalizedInput) return true;

  // 2. Match with manifest entry
  if (manifest) {
    if (normalizedSource === manifest.source.toLowerCase()) return true;
    if (normalizedSource === manifest.locator.toLowerCase()) return true;
    if (normalizedSource === manifest.name.toLowerCase()) return true;
    if (manifest.aliases?.some((alias) => normalizedSource === alias.toLowerCase())) return true;

    // Bare name match (e.g. source is "npm:pi-fabric" and item is "npm:pi-fabric")
    const bareSource = normalizedSource.replace(/^(npm|git):/, "");
    if (bareSource === manifest.name.toLowerCase()) return true;
  }

  return false;
}

/**
 * Pure function: Transform settings object in memory to pin a deferred package to eager.
 * Refuses missing or ambiguous matching entries.
 * Preserves unknown properties on the package object.
 */
export function transformPinSettings(settings: Record<string, any>, packageInput: string): {
  updatedSettings: Record<string, any>;
  manifest: ManifestEntry | undefined;
  previousEntry: any;
  updatedEntry: any;
} {
  const manifest = findManifestEntry(packageInput);
  const rawPackages = settings.packages;

  if (!Array.isArray(rawPackages)) {
    throw new Error(`Invalid settings format: "packages" is not an array.`);
  }

  // Find all matching indices
  const matchingIndices: number[] = [];
  for (let i = 0; i < rawPackages.length; i++) {
    if (isPackageMatch(rawPackages[i], packageInput, manifest)) {
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

  return {
    updatedSettings,
    manifest,
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

  const { updatedSettings, manifest, previousEntry, updatedEntry } = transformPinSettings(
    parsedSettings,
    packageInput
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
    package: manifest?.name ?? packageInput,
    source: manifest?.source ?? previousEntry.source,
    settingsPath,
    previousEntry,
    updatedEntry,
  };
}
