export function npmPackageName(spec: string): string {
  const trimmed = spec.trim();
  const versionAt = trimmed.startsWith("@")
    ? trimmed.indexOf("@", trimmed.indexOf("/") + 1)
    : trimmed.lastIndexOf("@");
  return versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed;
}

export function stripGitRef(spec: string): string {
  const trimmed = spec.trim();
  const refAt = trimmed.lastIndexOf("@");
  const pathStart = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
  return refAt > pathStart ? trimmed.slice(0, refAt) : trimmed;
}

/** Exact aliases for a package source; deliberately excludes ambiguous repository basenames. */
export function packageSourceAliases(source: string): Set<string> {
  const normalized = source.trim().toLowerCase();
  const aliases = new Set([normalized]);
  if (normalized.startsWith("npm:")) {
    aliases.add(npmPackageName(normalized.slice(4)));
  } else if (normalized.startsWith("git:")) {
    aliases.add(stripGitRef(normalized));
    aliases.add(stripGitRef(normalized.slice(4)));
  }
  return aliases;
}
