import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ManifestEntry, findManifestEntry } from "./manifest.js";

/**
 * Get the agent directory where user packages are installed.
 * Respects PI_CODING_AGENT_DIR with home-dir expansion, fallback to ~/.pi/agent.
 */
export function getUserAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir.startsWith("~")) {
      return resolve(homedir(), envDir.slice(1).replace(/^[/\\]/, ""));
    }
    return resolve(envDir);
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * Resolve package root on disk for an npm or git package locator.
 */
export function resolvePackageRoot(source: string, agentDir?: string): string {
  const baseDir = agentDir ?? getUserAgentDir();
  const trimmed = source.trim();

  let root: string;
  if (trimmed.startsWith("npm:")) {
    const pkgName = trimmed.slice(4).trim();
    root = join(baseDir, "npm", "node_modules", pkgName);
  } else if (trimmed.startsWith("git:")) {
    const gitSpec = trimmed.slice(4).trim().split("@")[0].replace(/\.git$/, "");
    root = join(baseDir, "git", gitSpec);
  } else if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const url = new URL(trimmed);
    const gitPath = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    root = join(baseDir, "git", url.host, gitPath);
  } else if (existsSync(trimmed)) {
    root = resolve(trimmed);
  } else {
    throw new Error(`Unrecognized or non-existent package locator: "${source}"`);
  }

  if (!existsSync(root)) {
    throw new Error(`Package root directory not found at "${root}". Is package "${source}" installed?`);
  }
  return root;
}

/**
 * Check if a directory has explicit extension entries:
 * 1. package.json with pi.extensions
 * 2. index.ts or index.js
 */
function resolveExplicitDirEntries(dir: string): string[] | null {
  const pkgJsonPath = join(dir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0) {
        const found: string[] = [];
        for (const ext of pkg.pi.extensions) {
          const resolvedPath = resolve(dir, ext);
          if (existsSync(resolvedPath)) {
            found.push(resolvedPath);
          }
        }
        if (found.length > 0) return found;
      }
    } catch {
      // Ignore malformed sub-package.json
    }
  }

  for (const idx of ["index.ts", "index.js"]) {
    const idxPath = join(dir, idx);
    if (existsSync(idxPath)) {
      return [idxPath];
    }
  }
  return null;
}

/**
 * Discover extension files in a directory following Pi conventions:
 * 1. Direct files: *.ts or *.js (excluding *.d.ts)
 * 2. Subdirectory with explicit entries (index.ts/js or package.json pi.extensions)
 */
export function discoverExtensionsInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const direct = resolveExplicitDirEntries(dir);
  if (direct) return direct;

  const discovered: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);

      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(fullPath);
          isFile = st.isFile();
          isDir = st.isDirectory();
        } catch {
          continue;
        }
      }

      if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) && !entry.name.endsWith(".d.ts")) {
        discovered.push(fullPath);
      } else if (isDir) {
        const subEntries = resolveExplicitDirEntries(fullPath);
        if (subEntries) {
          discovered.push(...subEntries);
        }
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

/**
 * Resolve all extension entry files for a package.
 * Reads package.json `pi.extensions`, or falls back to `extensions/` convention.
 */
export function resolvePackageEntries(sourceOrManifest: string | ManifestEntry, agentDir?: string): string[] {
  let source: string;
  if (typeof sourceOrManifest === "string") {
    const manifest = findManifestEntry(sourceOrManifest);
    source = manifest ? manifest.source : sourceOrManifest;
  } else {
    source = sourceOrManifest.source;
  }

  const root = resolvePackageRoot(source, agentDir);
  const pkgJsonPath = join(root, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`Package missing package.json at "${root}"`);
  }

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Invalid package.json in "${root}": ${err?.message ?? err}`);
  }

  const entries: string[] = [];

  if (Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0) {
    for (const declaredPath of pkg.pi.extensions) {
      const fullPath = resolve(root, declaredPath);
      if (!existsSync(fullPath)) {
        throw new Error(`Declared extension entry does not exist: "${fullPath}" (from "${declaredPath}" in ${pkgJsonPath})`);
      }
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        const dirEntries = discoverExtensionsInDir(fullPath);
        if (dirEntries.length === 0) {
          throw new Error(`No extension entry files found in directory "${fullPath}"`);
        }
        entries.push(...dirEntries);
      } else if (st.isFile()) {
        entries.push(fullPath);
      }
    }
  } else {
    // Convention check: root/extensions/ or root/index.ts
    const extDir = join(root, "extensions");
    if (existsSync(extDir) && statSync(extDir).isDirectory()) {
      entries.push(...discoverExtensionsInDir(extDir));
    } else {
      const rootEntries = resolveExplicitDirEntries(root);
      if (rootEntries) entries.push(...rootEntries);
    }
  }

  if (entries.length === 0) {
    throw new Error(`No extension entry points found for package "${source}" in "${root}"`);
  }

  // Deduplicate entries while preserving order
  return Array.from(new Set(entries));
}
