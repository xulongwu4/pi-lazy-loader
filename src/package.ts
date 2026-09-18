export interface CommandProxyDeclaration {
  name: string;
  description?: string;
}

export interface PackageDefinition {
  name: string;
  source: string;
  aliases?: string[];
  commands?: CommandProxyDeclaration[];
  proxyCommands?: string[];
  proxyTools?: string[];
  /** Tool names whose cached promptGuidelines are injected into the system prompt while hidden from Pi's native tool list. */
  guidelineTools?: string[];
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
