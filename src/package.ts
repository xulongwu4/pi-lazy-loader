export interface CommandProxyDeclaration {
  name: string;
  description?: string;
  /** Cached: target has getArgumentCompletions; the proxy loads the package on Tab to serve them. */
  hasArgumentCompletions?: boolean;
}

export const TOOL_EXPOSURE_OVERRIDES = ["direct", "codemode", "deferred", "hidden"] as const;
export type ToolExposureOverride = typeof TOOL_EXPOSURE_OVERRIDES[number];

export interface PackageDefinition {
  name: string;
  source: string;
  aliases?: string[];
  commands?: CommandProxyDeclaration[];
  proxyCommands?: string[];
  proxyTools?: string[];
  toolExposure?: Record<string, ToolExposureOverride>;
}

/** Configured exposure for a tool. Only direct/codemode/deferred (undefined = Pi's direct) are
 *  overridable; hidden, model-only and unknown values always win, so an override never promotes. */
export function effectiveExposure(definition: PackageDefinition | undefined, toolName: string, liveExposure: unknown): unknown {
  const overrides = definition?.toolExposure;
  if (!overrides || !Object.hasOwn(overrides, toolName)) return liveExposure;
  return ["direct", "codemode", "deferred"].includes((liveExposure ?? "direct") as string) ? overrides[toolName] : liveExposure;
}

/** Same object when the policy leaves the tool unchanged; otherwise a flat view with the effective exposure.
 *  Not a spread: that drops prototype methods (class tools) and rebinds `this`, breaking #private
 *  fields and WeakMap(this) state. Not a mutation: the cache must keep the raw object, and packages
 *  may reuse one tool object across /reload. So copy own + inherited props, binding methods to the original. */
export function withEffectiveExposure<T extends { name: string; exposure?: unknown }>(definition: PackageDefinition | undefined, tool: T): T {
  const exposure = effectiveExposure(definition, tool.name, tool.exposure);
  if (exposure === tool.exposure) return tool;
  const view: Record<string, unknown> = {};
  for (let o: object | null = tool; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === "constructor" || Object.hasOwn(view, key)) continue;
      const value = (tool as any)[key];
      view[key] = typeof value === "function" ? value.bind(tool) : value;
    }
  }
  return { ...view, exposure } as T;
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
