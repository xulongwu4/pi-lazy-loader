/**
 * Presentation and description formatting for slash-command proxies.
 * Handles target display formatting and delegated attribution.
 */

/**
 * Shared context for rendering command descriptions and delegated provenance.
 */
export interface CommandDescriptionContext {
  packageName: string;
  commandName: string;
  declaredDescription?: string;
  description?: string;
  targetLabel?: string;
}

/**
 * Helper: format target display label.
 * Supplemental targetLabel is rendered alongside canonical package name, never replacing it.
 */
export function formatTargetDisplay(packageName: string, targetLabel?: string): string {
  if (targetLabel && targetLabel !== packageName) {
    return `${packageName} (${targetLabel})`;
  }
  return packageName;
}

/**
 * Helper: compute startup stub description with delegated attribution.
 */
export function formatStartupDescription(ctx: CommandDescriptionContext): string {
  const targetDisplay = formatTargetDisplay(ctx.packageName, ctx.targetLabel);
  const base =
    ctx.declaredDescription ??
    ctx.description ??
    `Load ${targetDisplay} on first use for /${ctx.commandName}`;
  return `${base} [lazy target: ${targetDisplay}; proxy: pi-lazy-loader]`;
}

/**
 * Helper: compute post-load description with delegated attribution.
 */
export function formatPostLoadDescription(
  ctx: CommandDescriptionContext,
  targetDescription?: string
): string {
  const targetDisplay = formatTargetDisplay(ctx.packageName, ctx.targetLabel);
  const declaredDesc = ctx.declaredDescription ?? ctx.description;
  const base = targetDescription ?? declaredDesc ?? `Run /${ctx.commandName}`;
  return `${base} [target: ${targetDisplay}; via pi-lazy-loader]`;
}
