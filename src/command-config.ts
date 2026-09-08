import type { PackageDefinition } from "./package.js";
import type { CommandDescriptionContext } from "./command-presentation.js";

export interface MergedCommandDefinition extends CommandDescriptionContext {
  packageSource: string;
}

export interface CommandConfigResult {
  definitions: MergedCommandDefinition[];
  diagnostics: string[];
}

function isRegisteredCommandName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !/[\x00-\x1f\x7f]/.test(name);
}

/** Validate cached registrations and omit ambiguous cross-package command names. */
export function buildCommandDefinitions(packages: PackageDefinition[]): CommandConfigResult {
  const diagnostics: string[] = [];
  const definitions: MergedCommandDefinition[] = [];
  const owners = new Map<string, string[]>();

  for (const pkg of packages) {
    const seen = new Set<string>();
    for (const command of pkg.commands ?? []) {
      if (!command || typeof command !== "object" || !isRegisteredCommandName(command.name)) {
        diagnostics.push(`Package "${pkg.name}" has an invalid cached command registration`);
        continue;
      }
      if (seen.has(command.name)) {
        diagnostics.push(`Package "${pkg.name}" declares duplicate command "${command.name}"`);
        continue;
      }
      seen.add(command.name);
      definitions.push({
        packageName: pkg.name,
        packageSource: pkg.source,
        commandName: command.name,
        declaredDescription: command.description,
      });
      owners.set(command.name, [...(owners.get(command.name) ?? []), pkg.name]);
    }
  }

  const conflicts = new Set<string>();
  for (const [commandName, packageNames] of owners) {
    if (packageNames.length > 1) {
      conflicts.add(commandName);
      diagnostics.push(
        `Command "${commandName}" is cached by multiple packages (${packageNames.join(", ")}); skipping proxy`
      );
    }
  }

  return {
    definitions: definitions.filter((definition) => !conflicts.has(definition.commandName)),
    diagnostics,
  };
}
