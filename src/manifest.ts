import rawManifest from "../manifest.json" with { type: "json" };

export interface CommandProxyDeclaration {
  name: string;
  description?: string;
}

export interface ManifestEntry {
  name: string;
  source: string;
  locator: string;
  cost: number;
  capability: string;
  aliases?: string[];
  commands?: CommandProxyDeclaration[];
}

export const MANIFEST: ManifestEntry[] = (rawManifest as ManifestEntry[]).map((entry) => {
  const aliases: string[] = [entry.name.toLowerCase(), entry.source.toLowerCase(), entry.locator.toLowerCase()];
  if (entry.source.startsWith("npm:")) {
    const bare = entry.source.slice(4).toLowerCase();
    if (!aliases.includes(bare)) aliases.push(bare);
  } else if (entry.source.startsWith("git:")) {
    const bare = entry.source.slice(4).toLowerCase().replace(/\.git$/, "");
    if (!aliases.includes(bare)) aliases.push(bare);
    const repoName = bare.split("/").pop();
    if (repoName && !aliases.includes(repoName)) aliases.push(repoName);
  }
  // Special aliases for pi-quotas
  if (entry.name === "pi-quotas" || entry.source.includes("pi-quotas")) {
    if (!aliases.includes("github.com/xulongwu4/pi-quotas")) aliases.push("github.com/xulongwu4/pi-quotas");
    if (!aliases.includes("@latentminds/pi-quotas")) aliases.push("@latentminds/pi-quotas");
  }
  return { ...entry, aliases };
});

export function findManifestEntry(identifier: string): ManifestEntry | undefined {
  if (!identifier) return undefined;
  const normalized = identifier.trim().toLowerCase();
  return MANIFEST.find((entry) => {
    if (entry.name.toLowerCase() === normalized) return true;
    if (entry.source.toLowerCase() === normalized) return true;
    if (entry.locator.toLowerCase() === normalized) return true;
    if (entry.aliases?.some((alias) => alias === normalized)) return true;
    return false;
  });
}
