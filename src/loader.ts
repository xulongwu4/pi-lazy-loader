import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProviders from "@earendil-works/pi-ai/providers/all";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";

import { MANIFEST, type ManifestEntry, findManifestEntry } from "./manifest.js";
import { getUserAgentDir, resolvePackageEntries, resolvePackageRoot } from "./resolver.js";
import { computePackageFingerprint, updateCachedPackageTools } from "./tool-cache.js";
import {
  type CommandDescriptionContext,
  formatPostLoadDescription,
} from "./command-presentation.js";

export interface ReserveCommandOptions {
  declaredDescription?: string;
  targetLabel?: string;
  decorateDescription?: boolean;
}

export type PackageLoadStatus = "deferred" | "loading" | "loaded" | "failed";
export type CommandStatus = "deferred" | "ready" | "ready (eager)" | "missing" | "failed" | "loading";

export interface PackageState {
  manifest: ManifestEntry;
  status: PackageLoadStatus;
  error?: string;
  loadedEntries: string[];
  newTools: string[];
  loadMs?: number;
  loadPromise?: Promise<PackageLoadResult> | null;
}

export interface PackageLoadResult {
  success: boolean;
  status: PackageLoadStatus;
  package: string;
  source: string;
  alreadyLoaded?: boolean;
  loadMs?: number;
  newTools?: string[];
  entries?: string[];
  error?: string;
}

export interface CapturedLifecycleEvent {
  event: any;
  ctx: any;
}

export interface LifecycleState {
  sessionStart: CapturedLifecycleEvent | null;
  resourcesDiscover: CapturedLifecycleEvent | null;
}

/**
 * Construct virtualModules map for jiti matching Pi runtime conventions.
 * Shares Pi's actual module instances to avoid duplicate instance conflicts.
 */
export function createPiVirtualModules() {
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

export class LazyLoader {
  private states = new Map<string, PackageState>();
  private pi: any;
  private lifecycleState: LifecycleState = {
    sessionStart: null,
    resourcesDiscover: null,
  };
  private agentDir: string;
  private reservedCommands = new Map<string, Map<string, ReserveCommandOptions>>();
  private capturedCommands = new Map<string, Map<string, any>>();
  private partialExtensionPackages = new Set<string>();

  private getCapturedCommand(packageName: string, commandName: string): any {
    return this.capturedCommands.get(packageName)?.get(commandName);
  }

  private setCapturedCommand(packageName: string, commandName: string, command: any): void {
    let pkgMap = this.capturedCommands.get(packageName);
    if (!pkgMap) {
      pkgMap = new Map<string, any>();
      this.capturedCommands.set(packageName, pkgMap);
    }
    pkgMap.set(commandName, command);
  }

  private hasCapturedCommand(packageName: string, commandName: string): boolean {
    return this.capturedCommands.get(packageName)?.has(commandName) ?? false;
  }

  constructor(pi: any, agentDir?: string, syncSettings = true) {
    this.pi = pi;
    this.agentDir = agentDir ?? getUserAgentDir();

    for (const entry of MANIFEST) {
      this.states.set(entry.name, {
        manifest: entry,
        status: "deferred",
        loadedEntries: [],
        newTools: [],
      });
    }
    if (syncSettings) this.syncConfiguredEager();
  }

  setSessionStart(event: any, ctx: any) {
    this.lifecycleState.sessionStart = { event, ctx };
  }

  setResourcesDiscover(event: any, ctx: any) {
    this.lifecycleState.resourcesDiscover = { event, ctx };
  }

  getLifecycleState(): LifecycleState {
    return this.lifecycleState;
  }

  /** Mark packages whose extensions Pi already loaded eagerly, preventing duplicate factories. */
  syncConfiguredEager(settingsPath = join(this.agentDir, "settings.json")): string[] {
    let settings: any;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      return [];
    }

    this.partialExtensionPackages.clear();
    const eagerSources = new Set<string>();
    for (const item of settings?.packages ?? []) {
      if (typeof item === "string") {
        eagerSources.add(item);
      } else if (item && typeof item.source === "string") {
        if (Array.isArray(item.extensions)) {
          if (item.extensions.length > 0) {
            eagerSources.add(item.source);
            const entry = findManifestEntry(item.source);
            this.partialExtensionPackages.add(entry ? entry.name : item.source);
          }
        } else {
          eagerSources.add(item.source);
        }
      }
    }

    const marked: string[] = [];
    for (const state of this.states.values()) {
      if (state.status === "deferred" && eagerSources.has(state.manifest.source)) {
        state.status = "loaded";
        state.loadedEntries = ["<configured eager>"];
        marked.push(state.manifest.name);
      }
    }
    return marked;
  }

  getAgentDir(): string {
    return this.agentDir;
  }

  getPartialExtensionPackages(): string[] {
    return Array.from(this.partialExtensionPackages);
  }

  getAllStates(): PackageState[] {
    return Array.from(this.states.values());
  }

  reserveCommand(identifier: string, commandName: string, metadata?: ReserveCommandOptions): void {
    const manifest = findManifestEntry(identifier);
    if (!manifest) throw new Error(`Unknown package "${identifier}"`);
    let names = this.reservedCommands.get(manifest.name);
    if (!names) {
      names = new Map<string, ReserveCommandOptions>();
      this.reservedCommands.set(manifest.name, names);
    }
    names.set(commandName, metadata ?? {});
  }

  isCommandCaptured(identifier: string, commandName: string): boolean {
    const manifest = findManifestEntry(identifier);
    if (!manifest) return false;
    return this.hasCapturedCommand(manifest.name, commandName);
  }

  getCommandStatus(identifier: string, commandName: string): CommandStatus {
    const pkgState = this.getPackageState(identifier);
    if (!pkgState) return "deferred";
    if (pkgState.status === "loaded") {
      if (pkgState.loadedEntries.includes("<configured eager>")) {
        return "ready (eager)";
      }
      return this.isCommandCaptured(identifier, commandName) ? "ready" : "missing";
    }
    if (pkgState.status === "failed") return "failed";
    if (pkgState.status === "loading") return "loading";
    return "deferred";
  }

  async invokeCapturedCommand(identifier: string, commandName: string, args: string, ctx: any): Promise<any> {
    const manifest = findManifestEntry(identifier);
    if (!manifest) throw new Error(`Unknown package "${identifier}"`);
    const command = this.getCapturedCommand(manifest.name, commandName);
    if (!command?.handler) throw new Error(`Package "${manifest.name}" did not register reserved command "${commandName}"`);
    return await command.handler(args, ctx);
  }

  getPackageState(identifier: string): PackageState | undefined {
    const entry = findManifestEntry(identifier);
    if (entry) {
      return this.states.get(entry.name);
    }
    return undefined;
  }

  /**
   * Dynamically load a package extension into the running session.
   * - Idempotent
   * - Concurrent calls share one promise
   * - Multiple entries all load; partial failure is marked failed
   * - Intercepts and registers event handlers
   * - Replays missed session_start and resources_discover exactly once with real objects
   */
  async loadPackage(identifier: string): Promise<PackageLoadResult> {
    const manifest = findManifestEntry(identifier);
    if (!manifest) {
      return {
        success: false,
        status: "failed",
        package: identifier,
        source: identifier,
        error: `Unknown package "${identifier}". Only Phase 0 packages can be lazily loaded.`,
      };
    }

    let pkgState = this.states.get(manifest.name);
    if (!pkgState) {
      pkgState = {
        manifest,
        status: "deferred",
        loadedEntries: [],
        newTools: [],
      };
      this.states.set(manifest.name, pkgState);
    }

    // 1. Idempotent check
    if (pkgState.status === "loaded") {
      return {
        success: true,
        status: "loaded",
        alreadyLoaded: true,
        package: manifest.name,
        source: manifest.source,
        newTools: pkgState.newTools,
        entries: pkgState.loadedEntries,
        loadMs: pkgState.loadMs,
      };
    }

    // 1b. Sticky session failure check: a failed package cannot be reloaded in this session
    if (pkgState.status === "failed") {
      return {
        success: false,
        status: "failed",
        package: manifest.name,
        source: manifest.source,
        error: `Package "${manifest.name}" failed previously in this session (${pkgState.error ?? "unknown error"}). Use /reload or restart the session to retry.`,
        loadMs: pkgState.loadMs,
      };
    }

    // 2. Concurrent calls share in-flight load promise
    if (pkgState.status === "loading" && pkgState.loadPromise) {
      return await pkgState.loadPromise;
    }

    // 3. Initiate load
    pkgState.status = "loading";
    pkgState.error = undefined;

    pkgState.loadPromise = (async (): Promise<PackageLoadResult> => {
      const t0 = Date.now();
      try {
        const entries = resolvePackageEntries(manifest, this.agentDir);
        const toolsBefore = new Set((this.pi?.getAllTools?.() ?? []).map((t: any) => t.name));

        const stagedRegistrations = new Map<string, any>();
        const newlyLoaded: string[] = [];
        const observedTools = new Map<string, any>();
        for (const entryPath of entries) {
          await this.loadSingleEntry(entryPath, manifest.name, stagedRegistrations, observedTools);
          newlyLoaded.push(entryPath);
        }

        // Commit staged registrations atomically only after all entries and lifecycle replay succeeded
        for (const [name, targetOptions] of stagedRegistrations.entries()) {
          this.setCapturedCommand(manifest.name, name, targetOptions);

          const meta = this.reservedCommands.get(manifest.name)?.get(name);
          const shouldDecorate =
            meta?.decorateDescription ??
            (meta?.declaredDescription !== undefined || meta?.targetLabel !== undefined);

          let committedOptions: any;
          if (shouldDecorate) {
            const descCtx: CommandDescriptionContext = {
              packageName: manifest.name,
              commandName: name,
              declaredDescription: meta?.declaredDescription,
              targetLabel: meta?.targetLabel,
            };
            const decoratedDescription = formatPostLoadDescription(
              descCtx,
              targetOptions?.description
            );
            committedOptions = {
              ...targetOptions,
              description: decoratedDescription,
            };
          } else {
            committedOptions = { ...targetOptions };
          }

          this.pi.registerCommand(name, committedOptions);
        }

        const toolsAfter = (this.pi?.getAllTools?.() ?? []).map((t: any) => t.name);
        const diffTools = toolsAfter.filter((name: string) => !toolsBefore.has(name));
        const finalTools = observedTools.size > 0 ? Array.from(observedTools.keys()) : diffTools;

        pkgState.status = "loaded";
        pkgState.loadedEntries = newlyLoaded;
        pkgState.newTools = finalTools;
        pkgState.loadMs = Date.now() - t0;
        pkgState.error = undefined;

        try {
          const pkgRoot = resolvePackageRoot(manifest.source, this.agentDir);
          const fingerprint = computePackageFingerprint(pkgRoot, entries);
          const toolsToCache = observedTools.size > 0
            ? Array.from(observedTools.values())
            : diffTools;
          updateCachedPackageTools(this.agentDir, manifest.name, fingerprint, toolsToCache);
        } catch (cacheErr: any) {
          console.error(`[pi-lazy-loader] Failed to cache tools for "${manifest.name}": ${cacheErr?.message ?? cacheErr}`);
        }

        return {
          success: true,
          status: "loaded",
          alreadyLoaded: false,
          package: manifest.name,
          source: manifest.source,
          newTools: finalTools,
          entries,
          loadMs: pkgState.loadMs,
        };
      } catch (err: any) {
        pkgState.status = "failed";
        pkgState.error = err instanceof Error ? err.message : String(err);
        pkgState.loadMs = Date.now() - t0;
        return {
          success: false,
          status: "failed",
          package: manifest.name,
          source: manifest.source,
          error: pkgState.error,
          loadMs: pkgState.loadMs,
        };
      } finally {
        pkgState.loadPromise = null;
      }
    })();

    return await pkgState.loadPromise;
  }

  /**
   * Load and initialize a single extension entry file with jiti and lifecycle replay.
   */
  private async loadSingleEntry(
    entryPath: string,
    packageName: string,
    stagedRegistrations?: Map<string, any>,
    observedTools?: Map<string, any>
  ): Promise<void> {
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      tryNative: false,
      virtualModules: createPiVirtualModules(),
    });

    const factory = await jiti.import(entryPath, { default: true });
    if (typeof factory !== "function") {
      throw new Error(`Extension file "${entryPath}" does not export a default factory function (got ${typeof factory})`);
    }

    // Proxy pi.on to capture handlers registered by this entry while registering them for future events
    const capturedHandlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];

    const proxy = new Proxy(this.pi, {
      get: (target: any, prop: string | symbol, receiver: any) => {
        if (prop === "registerTool") {
          return (tool: any) => {
            if (tool && typeof tool.name === "string") {
              observedTools?.set(tool.name, tool);
            }
            return typeof target.registerTool === "function" ? target.registerTool(tool) : undefined;
          };
        }
        if (prop === "registerCommand") {
          return (name: string, command: any) => {
            if (this.reservedCommands.get(packageName)?.has(name)) {
              if (stagedRegistrations) {
                if (stagedRegistrations.has(name)) {
                  throw new Error(
                    `Duplicate target registration for command "${name}" in package "${packageName}"`
                  );
                }
                // Stage intercepted registration for atomic commit upon successful load
                stagedRegistrations.set(name, command);
                return;
              }
              if (this.hasCapturedCommand(packageName, name)) {
                throw new Error(
                  `Duplicate target registration for command "${name}" in package "${packageName}"`
                );
              }
              this.setCapturedCommand(packageName, name, command);
            }
            return target.registerCommand(name, command);
          };
        }
        if (prop === "on") {
          return (event: string, handler: (...args: any[]) => any) => {
            capturedHandlers.push({ event, handler });
            return target.on(event, handler);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });

    // Invoke factory with live API proxy
    await factory(proxy);

    // Replay already-fired lifecycle events exactly once using the real event objects
    // Order: session_start first, then resources_discover
    if (this.lifecycleState.sessionStart) {
      const sessionStartHandlers = capturedHandlers.filter((h) => h.event === "session_start");
      for (const { handler } of sessionStartHandlers) {
        await handler(this.lifecycleState.sessionStart.event, this.lifecycleState.sessionStart.ctx);
      }
    }

    if (this.lifecycleState.resourcesDiscover) {
      const resourcesDiscoverHandlers = capturedHandlers.filter((h) => h.event === "resources_discover");
      for (const { handler } of resourcesDiscoverHandlers) {
        await handler(this.lifecycleState.resourcesDiscover.event, this.lifecycleState.resourcesDiscover.ctx);
      }
    }
  }
}
