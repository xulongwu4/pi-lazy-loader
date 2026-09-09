import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { npmPackageName, stripGitRef } from "./package-locator.js";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProviders from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";

export { getAgentDir };

/** Resolve package root on disk for an npm or git package locator. */
export function resolvePackageRoot(source: string, agentDir?: string): string {
  const baseDir = agentDir ?? getAgentDir();
  const trimmed = source.trim();

  let root: string;
  if (trimmed.startsWith("npm:")) {
    const pkgName = npmPackageName(trimmed.slice(4).trim());
    root = join(baseDir, "npm", "node_modules", pkgName);
  } else if (trimmed.startsWith("git:")) {
    const gitSpec = stripGitRef(trimmed.slice(4).trim()).replace(/\.git$/, "");
    root = join(baseDir, "git", gitSpec);
  } else if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const url = new URL(trimmed);
    const gitPath = stripGitRef(url.pathname.replace(/^\//, "")).replace(/\.git$/, "");
    root = join(baseDir, "git", url.host, gitPath);
  } else if (existsSync(resolve(baseDir, trimmed))) {
    root = resolve(baseDir, trimmed);
  } else {
    throw new Error(`Unrecognized or non-existent package locator: "${source}"`);
  }

  if (!existsSync(root)) {
    throw new Error(`Package root directory not found at "${root}". Is package "${source}" installed?`);
  }
  return root;
}

export type MissedLifecycle = {
  sessionStart: { event: any; ctx: any } | null;
  resourcesDiscover: { event: any; ctx: any } | null;
};

function createPiVirtualModules() {
  return {
    typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": typeboxCompile,
    "@sinclair/typebox/value": typeboxValue,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-tui": piTui,
    "@earendil-works/pi-ai": piAiCompat,
    "@earendil-works/pi-ai/compat": piAiCompat,
    "@earendil-works/pi-ai/oauth": piAiOauth,
    "@earendil-works/pi-ai/providers/all": piAiProviders,
    "@earendil-works/pi-coding-agent": piCodingAgent,
    "@mariozechner/pi-agent-core": piAgentCore,
    "@mariozechner/pi-tui": piTui,
    "@mariozechner/pi-ai": piAiCompat,
    "@mariozechner/pi-ai/compat": piAiCompat,
    "@mariozechner/pi-ai/oauth": piAiOauth,
    "@mariozechner/pi-ai/providers/all": piAiProviders,
    "@mariozechner/pi-coding-agent": piCodingAgent,
  };
}

/** Import a Pi extension factory through the same jiti + virtualModules recipe Pi uses. */
export async function importExtensionFactory(entryPath: string): Promise<(pi: any) => any> {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: createPiVirtualModules(),
  });
  const factory = await jiti.import(entryPath, { default: true });
  if (typeof factory !== "function") {
    throw new Error(`Extension file "${entryPath}" does not export a default factory function (got ${typeof factory})`);
  }
  return factory as (pi: any) => any;
}

/** Replay already-fired session_start then resources_discover using the genuine objects. */
export async function replayMissedLifecycle(
  handlers: Array<{ event: string; handler: (...args: any[]) => any }>,
  lifecycle: MissedLifecycle,
): Promise<void> {
  if (lifecycle.sessionStart) {
    for (const { handler } of handlers.filter((h) => h.event === "session_start")) {
      await handler(lifecycle.sessionStart.event, lifecycle.sessionStart.ctx);
    }
  }
  if (lifecycle.resourcesDiscover) {
    for (const { handler } of handlers.filter((h) => h.event === "resources_discover")) {
      await handler(lifecycle.resourcesDiscover.event, lifecycle.resourcesDiscover.ctx);
    }
  }
}

/** Record a command name and, if Pi suffixed it as name:N, its unsuffixed base. */
export function addVisibleCommandName(visible: Set<string>, name: string): void {
  visible.add(name);
  const base = /^(.*):\d+$/.exec(name)?.[1];
  if (base) visible.add(base);
}
