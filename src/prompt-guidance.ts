import type { LazyLoaderCache } from "./cache.js";
import { selectCachedRegistrations } from "./cache.js";
import type { PackageDefinition } from "./package.js";

export const DEFERRED_GUIDANCE_HEADER = "## Deferred tools (pi-lazy-loader)";

/**
 * System-prompt text for proxied tools that Pi did not render itself.
 * `renderedTools` is Pi's active tool list for this prompt build; tools in it already show their
 * own snippet/guidelines, so they are skipped. Snippets are always emitted for the rest;
 * guidelines only for names in the package's `guidelineTools` allowlist.
 */
export function buildDeferredToolGuidance(
  packages: PackageDefinition[],
  cache: LazyLoaderCache,
  renderedTools: string[],
): string {
  const rendered = new Set(renderedTools);
  const snippets: string[] = [];
  const guidelines: string[] = [];
  for (const pkg of packages) {
    const allow = new Set(pkg.guidelineTools ?? []);
    for (const tool of selectCachedRegistrations(cache.packages[pkg.name]?.tools ?? [], pkg.proxyTools)) {
      if (rendered.has(tool.name)) continue;
      if (tool.promptSnippet) snippets.push(`- ${tool.name}: ${tool.promptSnippet}`);
      if (allow.has(tool.name)) for (const g of tool.promptGuidelines ?? []) guidelines.push(`- ${g}`);
    }
  }
  if (snippets.length === 0 && guidelines.length === 0) return "";
  const lines = [DEFERRED_GUIDANCE_HEADER, "These load on first call; call them by name like any other extension tool."];
  if (snippets.length > 0) lines.push(...snippets);
  if (guidelines.length > 0) lines.push("Guidelines:", ...guidelines);
  return lines.join("\n");
}
