export interface CommandProxyDeclaration {
  name: string;
  description?: string;
  /** Cached: target has getArgumentCompletions; the proxy loads the package on Tab to serve them. */
  hasArgumentCompletions?: boolean;
}

export interface PackageDefinition {
  name: string;
  source: string;
  aliases?: string[];
  commands?: CommandProxyDeclaration[];
  proxyCommands?: string[];
  proxyTools?: string[];
}

export function findPackageDefinition(
  packages: PackageDefinition[],
  identifier: string
): PackageDefinition | undefined {
  if (!identifier) return undefined;
  const normalized = identifier.trim().toLowerCase();
  return packages.find((pkg) =>
    pkg.name.toLowerCase() === normalized ||
    pkg.source.toLowerCase() === normalized ||
    pkg.aliases?.some((alias) => alias.toLowerCase() === normalized)
  );
}
