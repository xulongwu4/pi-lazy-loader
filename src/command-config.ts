import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  MANIFEST,
  type ManifestEntry,
  type CommandProxyDeclaration,
  findManifestEntry,
} from "./manifest.js";
import { getUserAgentDir } from "./resolver.js";
import {
  type CommandDescriptionContext,
  formatTargetDisplay,
  formatStartupDescription,
  formatPostLoadDescription,
} from "./command-presentation.js";

const COMMAND_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CONFIG_FILE_SIZE = 64 * 1024; // 64 KiB
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_LABEL_LENGTH = 100;

export type { CommandProxyDeclaration, CommandDescriptionContext };
export { formatTargetDisplay, formatStartupDescription, formatPostLoadDescription };

export type UserCommandDeclaration = string | CommandProxyDeclaration;

export interface UserPackageCommandConfig {
  targetLabel?: string;
  commands: UserCommandDeclaration[];
}

export interface UserCommandConfig {
  $schema?: string;
  version: 1;
  packages: Record<string, UserPackageCommandConfig>;
}

export interface MergedCommandDefinition extends CommandDescriptionContext {
  packageSource: string;
}

export interface CommandConfigResult {
  definitions: MergedCommandDefinition[];
  diagnostics: string[];
}

function isValidCommandName(name: unknown): name is string {
  return typeof name === "string" && COMMAND_NAME_REGEX.test(name);
}

function isValidDescription(desc: unknown): desc is string {
  if (typeof desc !== "string") return false;
  if (desc.length === 0 || desc.length > MAX_DESCRIPTION_LENGTH) return false;
  return !/[\x00-\x1f\x7f]/.test(desc);
}

function isValidTargetLabel(label: unknown): label is string {
  if (typeof label !== "string") return false;
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
  return !/[\x00-\x1f\x7f]/.test(label);
}

export interface ValidatedBuiltinCommands {
  builtinMap: Map<string, Map<string, { description?: string }>>;
  packageToSource: Map<string, string>;
  diagnostics: string[];
}

/**
 * Validate and normalize command declarations in manifest entries once.
 */
export function normalizeManifestCommands(entries: ManifestEntry[]): ValidatedBuiltinCommands {
  const diagnostics: string[] = [];
  const builtinMap = new Map<string, Map<string, { description?: string }>>();
  const packageToSource = new Map<string, string>();
  const commandToPackage = new Map<string, string>();

  for (const entry of entries) {
    packageToSource.set(entry.name, entry.source);
    if (!entry.commands) continue;
    if (!Array.isArray(entry.commands)) {
      diagnostics.push(`Package "${entry.name}" commands must be an array`);
      continue;
    }

    const seenInPackage = new Set<string>();
    const cmds = new Map<string, { description?: string }>();

    for (const cmd of entry.commands) {
      if (!cmd || typeof cmd !== "object") {
        diagnostics.push(`Package "${entry.name}" has invalid command entry: expected object`);
        continue;
      }

      if (!isValidCommandName(cmd.name)) {
        diagnostics.push(`Package "${entry.name}" has invalid command name: "${cmd.name}"`);
        continue;
      }

      if (cmd.description !== undefined && !isValidDescription(cmd.description)) {
        diagnostics.push(`Package "${entry.name}" command "${cmd.name}" has invalid description`);
        continue;
      }

      if (seenInPackage.has(cmd.name)) {
        diagnostics.push(`Package "${entry.name}" has duplicate command declaration for "${cmd.name}"`);
        continue;
      }
      seenInPackage.add(cmd.name);

      const existingPkg = commandToPackage.get(cmd.name);
      if (existingPkg && existingPkg !== entry.name) {
        diagnostics.push(
          `Command "${cmd.name}" in package "${entry.name}" conflicts with package "${existingPkg}"`
        );
      } else {
        commandToPackage.set(cmd.name, entry.name);
        cmds.set(cmd.name, { description: cmd.description });
      }
    }

    if (cmds.size > 0) {
      builtinMap.set(entry.name, cmds);
    }
  }

  return { builtinMap, packageToSource, diagnostics };
}

/**
 * Validate command declarations in manifest entries.
 */
export function validateManifestCommands(entries: ManifestEntry[]): string[] {
  return normalizeManifestCommands(entries).diagnostics;
}

/**
 * Validate the structure of user command configuration.
 */
export function validateUserConfig(raw: unknown): { config?: UserCommandConfig; diagnostics: string[] } {
  const diagnostics: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { diagnostics: ["User command configuration must be a JSON object"] };
  }

  const obj = raw as Record<string, any>;

  // Check unknown top-level fields (exempting $schema)
  const allowedTopLevel = new Set(["$schema", "version", "packages"]);
  for (const key of Object.keys(obj)) {
    if (!allowedTopLevel.has(key)) {
      diagnostics.push(`Unknown top-level field "${key}" in user command configuration`);
    }
  }

  // Validate $schema if present
  if (obj.$schema !== undefined && typeof obj.$schema !== "string") {
    diagnostics.push(`"$schema" must be a string if provided`);
  }

  // Validate version
  if (obj.version !== 1) {
    diagnostics.push(`Unsupported user command configuration version: ${obj.version} (expected 1)`);
    return { diagnostics };
  }

  // Validate packages
  if (!obj.packages || typeof obj.packages !== "object" || Array.isArray(obj.packages)) {
    diagnostics.push(`"packages" field must be an object in user command configuration`);
    return { diagnostics };
  }

  const validatedPackages: Record<string, UserPackageCommandConfig> = {};
  const allowedPackageKeys = new Set(["targetLabel", "commands"]);

  for (const [pkgKey, pkgVal] of Object.entries(obj.packages)) {
    const manifest = findManifestEntry(pkgKey);
    if (!manifest) {
      diagnostics.push(`Unknown package "${pkgKey}" in user command configuration`);
      continue;
    }

    if (!pkgVal || typeof pkgVal !== "object" || Array.isArray(pkgVal)) {
      diagnostics.push(`Package configuration for "${pkgKey}" must be an object`);
      continue;
    }

    const pkgObj = pkgVal as Record<string, any>;

    // Check unknown fields in package config
    for (const key of Object.keys(pkgObj)) {
      if (!allowedPackageKeys.has(key)) {
        diagnostics.push(`Unknown field "${key}" in package configuration for "${pkgKey}"`);
      }
    }

    // Validate targetLabel
    let targetLabel: string | undefined;
    if (pkgObj.targetLabel !== undefined) {
      if (!isValidTargetLabel(pkgObj.targetLabel)) {
        diagnostics.push(`Invalid targetLabel in package configuration for "${pkgKey}"`);
      } else {
        targetLabel = pkgObj.targetLabel;
      }
    }

    // Validate commands array
    if (!Array.isArray(pkgObj.commands)) {
      diagnostics.push(`"commands" in package configuration for "${pkgKey}" must be an array`);
      continue;
    }

    const validatedCommands: UserCommandDeclaration[] = [];
    const allowedCommandKeys = new Set(["name", "description"]);

    for (const cmdItem of pkgObj.commands) {
      if (typeof cmdItem === "string") {
        if (!isValidCommandName(cmdItem)) {
          diagnostics.push(`Invalid command name "${cmdItem}" in package "${pkgKey}"`);
          continue;
        }
        validatedCommands.push(cmdItem);
      } else if (cmdItem && typeof cmdItem === "object" && !Array.isArray(cmdItem)) {
        const cmdObj = cmdItem as Record<string, any>;

        let hasUnknownField = false;
        for (const k of Object.keys(cmdObj)) {
          if (!allowedCommandKeys.has(k)) {
            diagnostics.push(`Unknown field "${k}" in command definition for package "${pkgKey}"`);
            hasUnknownField = true;
          }
        }
        if (hasUnknownField) continue;

        if (!isValidCommandName(cmdObj.name)) {
          diagnostics.push(`Invalid command name "${cmdObj.name}" in package "${pkgKey}"`);
          continue;
        }

        if (cmdObj.description !== undefined && !isValidDescription(cmdObj.description)) {
          diagnostics.push(`Invalid description for command "${cmdObj.name}" in package "${pkgKey}"`);
          continue;
        }

        validatedCommands.push({
          name: cmdObj.name,
          description: cmdObj.description,
        });
      } else {
        diagnostics.push(`Invalid command item in package "${pkgKey}": expected string or object`);
      }
    }

    validatedPackages[pkgKey] = {
      targetLabel,
      commands: validatedCommands,
    };
  }

  const config: UserCommandConfig = {
    $schema: obj.$schema,
    version: 1,
    packages: validatedPackages,
  };

  return { config, diagnostics };
}

/**
 * Merge built-in manifest commands with optional user configuration.
 * Resolves package aliases, normalizes commands, collapses duplicates, detects conflicts.
 */
export function mergeCommandDefinitions(
  manifestEntries: ManifestEntry[] | ValidatedBuiltinCommands,
  userConfig?: UserCommandConfig
): CommandConfigResult {
  const validatedBuiltins = Array.isArray(manifestEntries)
    ? normalizeManifestCommands(manifestEntries)
    : manifestEntries;

  const diagnostics: string[] = [...validatedBuiltins.diagnostics];
  const { builtinMap, packageToSource } = validatedBuiltins;

  // 2. Process user declarations grouped by canonical package name
  // canonicalPackageName -> { targetLabel?: string; commands: Map<commandName, { descriptions: Set<string> }> }
  const userPackages = new Map<
    string,
    {
      targetLabel?: string;
      commands: Map<string, { descriptions: Set<string> }>;
    }
  >();

  if (userConfig?.packages) {
    for (const [pkgKey, pkgVal] of Object.entries(userConfig.packages)) {
      const manifest = findManifestEntry(pkgKey);
      if (!manifest) continue; // Already diagnosed in validation

      const canonicalName = manifest.name;
      let existing = userPackages.get(canonicalName);
      if (!existing) {
        existing = {
          targetLabel: pkgVal.targetLabel,
          commands: new Map(),
        };
        userPackages.set(canonicalName, existing);
      } else if (pkgVal.targetLabel) {
        existing.targetLabel = pkgVal.targetLabel;
      }

      for (const cmdItem of pkgVal.commands) {
        const name = typeof cmdItem === "string" ? cmdItem : cmdItem.name;
        const desc = typeof cmdItem === "string" ? undefined : cmdItem.description;

        let cmdData = existing.commands.get(name);
        if (!cmdData) {
          cmdData = { descriptions: new Set() };
          existing.commands.set(name, cmdData);
        }

        if (desc !== undefined && desc.length > 0) {
          cmdData.descriptions.add(desc);
        }
      }
    }
  }

  // 3. Flatten into candidate definitions per package
  // canonicalPackageName -> Map<commandName, { description?: string; targetLabel?: string }>
  const combinedPerPackage = new Map<
    string,
    Map<string, { description?: string; targetLabel?: string }>
  >();

  // Initialize with built-ins
  for (const [pkgName, cmds] of builtinMap.entries()) {
    const map = new Map<string, { description?: string; targetLabel?: string }>();
    for (const [cmdName, data] of cmds.entries()) {
      map.set(cmdName, { description: data.description });
    }
    combinedPerPackage.set(pkgName, map);
  }

  // Overlay user declarations
  for (const [pkgName, userPkg] of userPackages.entries()) {
    let pkgCmds = combinedPerPackage.get(pkgName);
    if (!pkgCmds) {
      pkgCmds = new Map();
      combinedPerPackage.set(pkgName, pkgCmds);
    }

    // Apply targetLabel to all commands in this package group
    if (userPkg.targetLabel) {
      for (const cmdData of pkgCmds.values()) {
        cmdData.targetLabel = userPkg.targetLabel;
      }
    }

    for (const [cmdName, userCmdData] of userPkg.commands.entries()) {
      // Check for conflict: multiple different non-empty descriptions in user declarations
      if (userCmdData.descriptions.size > 1) {
        diagnostics.push(
          `Conflicting descriptions for command "${cmdName}" in package "${pkgName}"; skipping command proxy`
        );
        pkgCmds.delete(cmdName);
        continue;
      }

      const existingBuiltin = pkgCmds.get(cmdName);
      const userSuppliedDesc =
        userCmdData.descriptions.size === 1
          ? Array.from(userCmdData.descriptions)[0]
          : undefined;

      // User non-empty description overrides built-in; omitted description preserves built-in
      const finalDesc = userSuppliedDesc ?? existingBuiltin?.description;
      pkgCmds.set(cmdName, {
        description: finalDesc,
        targetLabel: userPkg.targetLabel ?? existingBuiltin?.targetLabel,
      });
    }
  }

  // 4. Cross-package conflict detection:
  // Same command name declared for multiple packages is a conflict
  const commandToPackages = new Map<string, string[]>();
  for (const [pkgName, cmds] of combinedPerPackage.entries()) {
    for (const cmdName of cmds.keys()) {
      const list = commandToPackages.get(cmdName) ?? [];
      list.push(pkgName);
      commandToPackages.set(cmdName, list);
    }
  }

  const conflictedCommandNames = new Set<string>();
  for (const [cmdName, pkgs] of commandToPackages.entries()) {
    if (pkgs.length > 1) {
      diagnostics.push(
        `Command "${cmdName}" is declared by multiple packages (${pkgs.join(", ")}); skipping registration`
      );
      conflictedCommandNames.add(cmdName);
    }
  }

  // 5. Build final list of merged definitions, filtering out conflicts
  const definitions: MergedCommandDefinition[] = [];

  for (const [pkgName, cmds] of combinedPerPackage.entries()) {
    const source = packageToSource.get(pkgName) ?? `npm:${pkgName}`;
    for (const [cmdName, data] of cmds.entries()) {
      if (conflictedCommandNames.has(cmdName)) continue;

      definitions.push({
        packageName: pkgName,
        packageSource: source,
        commandName: cmdName,
        description: data.description,
        targetLabel: data.targetLabel,
      });
    }
  }

  // Deterministic sorting: by packageName ascending, then commandName ascending
  definitions.sort((a, b) => {
    const p = a.packageName.localeCompare(b.packageName);
    if (p !== 0) return p;
    return a.commandName.localeCompare(b.commandName);
  });

  return { definitions, diagnostics };
}

/**
 * Load, validate, and merge command configuration from the active agent directory.
 */
export function loadCommandConfig(options?: {
  agentDir?: string;
  configPath?: string;
  manifest?: ManifestEntry[];
}): CommandConfigResult {
  const agentDir = options?.agentDir ?? getUserAgentDir();
  const filePath = options?.configPath ?? join(agentDir, "lazy-loader.json");
  const manifest = options?.manifest ?? MANIFEST;

  if (!existsSync(filePath)) {
    return mergeCommandDefinitions(manifest, undefined);
  }

  try {
    const st = statSync(filePath);
    if (st.size > MAX_CONFIG_FILE_SIZE) {
      return {
        definitions: mergeCommandDefinitions(manifest, undefined).definitions,
        diagnostics: [
          `User command config file "${filePath}" exceeds 64 KiB limit (${st.size} bytes); using built-in commands only`,
        ],
      };
    }

    const content = readFileSync(filePath, "utf-8");
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (parseErr: any) {
      return {
        definitions: mergeCommandDefinitions(manifest, undefined).definitions,
        diagnostics: [
          `Failed to parse user command config at "${filePath}": ${parseErr?.message ?? parseErr}`,
        ],
      };
    }

    const { config, diagnostics: valDiagnostics } = validateUserConfig(raw);
    const { definitions, diagnostics: mergeDiagnostics } = mergeCommandDefinitions(
      manifest,
      config
    );

    return {
      definitions,
      diagnostics: [...valDiagnostics, ...mergeDiagnostics],
    };
  } catch (err: any) {
    return {
      definitions: mergeCommandDefinitions(manifest, undefined).definitions,
      diagnostics: [
        `Error reading user command config at "${filePath}": ${err?.message ?? err}`,
      ],
    };
  }
}
