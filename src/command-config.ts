import type { PackageDefinition } from "./package.js";
import type { CommandDescriptionContext } from "./command-presentation.js";

export interface MergedCommandDefinition extends CommandDescriptionContext {
  packageSource: string;
  /** Name registered with Pi: commandName, or commandName:N when several packages share it. */
  proxyName: string;
}

export interface CommandConfigResult {
  definitions: MergedCommandDefinition[];
  diagnostics: string[];
}

function isRegisteredCommandName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !/[\x00-\x1f\x7f]/.test(name);
}

/**
 * Validate cached registrations. Cross-package duplicates each get a proxy named like
 * Pi core resolves them (`name:1`, `name:2`, ... in package order).
 */
export function buildCommandDefinitions(packages: PackageDefinition[]): CommandConfigResult {
  const diagnostics: string[] = [];
  const definitions: Omit<MergedCommandDefinition, "proxyName">[] = [];
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

  // Like Pi's resolveRegisteredCommands (occurrence suffix, bumped past taken names), except
  // names only one package declares are never renamed.
  const taken = new Set(owners.keys());
  const occurrences = new Map<string, number>();
  return {
    definitions: definitions.map((definition) => {
      const name = definition.commandName;
      if (owners.get(name)!.length === 1) return { ...definition, proxyName: name };
      let suffix = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, suffix);
      while (taken.has(`${name}:${suffix}`)) suffix++;
      taken.add(`${name}:${suffix}`);
      return { ...definition, proxyName: `${name}:${suffix}` };
    }),
    diagnostics,
  };
}
