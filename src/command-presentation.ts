const MAX_DESCRIPTION = 240;

export interface CommandDescriptionContext {
  packageName: string;
  commandName: string;
  declaredDescription?: string;
}

function cap(text: string): string {
  if (text.length <= MAX_DESCRIPTION) return text;
  return `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}

export function formatStartupDescription(ctx: CommandDescriptionContext): string {
  const base = ctx.declaredDescription?.trim() || `/${ctx.commandName}`;
  return cap(`${base} [lazy target: ${ctx.packageName}; proxy: pi-lazy-loader]`);
}

export function formatPostLoadDescription(
  ctx: CommandDescriptionContext,
  targetDescription?: string
): string {
  const base = targetDescription?.trim() || ctx.declaredDescription?.trim() || `/${ctx.commandName}`;
  return cap(`${base} [target: ${ctx.packageName}; via pi-lazy-loader]`);
}
