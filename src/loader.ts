import { createJiti } from "jiti";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProviders from "@earendil-works/pi-ai/providers/all";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";

import { findPackageDefinition, type PackageDefinition } from "./package.js";
import { getUserAgentDir, resolvePackageEntries } from "./resolver.js";
import { readLazyLoaderConfig } from "./config.js";
import { updateCachedPackage, type CachedRegistration } from "./cache.js";
import {
  type CommandDescriptionContext,
  formatPostLoadDescription,
} from "./command-presentation.js";

export interface ReserveCommandOptions {
  declaredDescription?: string;
  decorateDescription?: boolean;
}

export type PackageLoadStatus = "deferred" | "loading" | "loaded" | "failed";
export type CommandStatus = "deferred" | "ready" | "missing" | "failed" | "loading";

export interface PackageState {
  definition: PackageDefinition;
  status: PackageLoadStatus;
  error?: string;
  loadedEntries: string[];
  newTools: string[];
  missingTools: string[];
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
  missingTools?: string[];
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
  private protectedCommands = new Map<string, Set<string>>();
  private reservedTools = new Map<string, Set<string>>();
  private protectedTools = new Map<string, Set<string>>();

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

  private refreshCache(
    packageName: string,
    observedTools: Map<string, any>,
    observedCommands: Map<string, any>
  ): void {
    try {
      const registrations = (items: Map<string, any>): CachedRegistration[] =>
        Array.from(items.entries()).map(([name, value]) => ({
          name,
          description: typeof value?.description === "string" ? value.description : undefined,
        }));
      updateCachedPackage(
        this.agentDir,
        packageName,
        registrations(observedTools),
        registrations(observedCommands)
      );
    } catch (error: any) {
      console.error(`[pi-lazy-loader] Failed to cache registrations for "${packageName}": ${error?.message ?? error}`);
    }
  }

  constructor(pi: any, agentDir?: string, packages?: PackageDefinition[]) {
    this.pi = pi;
    this.agentDir = agentDir ?? getUserAgentDir();

    for (const entry of packages ?? readLazyLoaderConfig(this.agentDir).packages) {
      this.states.set(entry.name, {
        definition: entry,
        status: "deferred",
        loadedEntries: [],
        newTools: [],
        missingTools: [],
      });
    }
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


  getAgentDir(): string {
    return this.agentDir;
  }

  getAllStates(): PackageState[] {
    return Array.from(this.states.values());
  }

  reserveCommand(identifier: string, commandName: string, metadata?: ReserveCommandOptions): void {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) throw new Error(`Unknown package "${identifier}"`);
    let names = this.reservedCommands.get(definition.name);
    if (!names) {
      names = new Map<string, ReserveCommandOptions>();
      this.reservedCommands.set(definition.name, names);
    }
    names.set(commandName, metadata ?? {});
  }

  protectCommand(identifier: string, commandName: string): void {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) throw new Error(`Unknown package "${identifier}"`);
    let names = this.protectedCommands.get(definition.name);
    if (!names) {
      names = new Set<string>();
      this.protectedCommands.set(definition.name, names);
    }
    names.add(commandName);
  }

  reserveTool(identifier: string, toolName: string): void {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) throw new Error(`Unknown package "${identifier}"`);
    let names = this.reservedTools.get(definition.name);
    if (!names) {
      names = new Set<string>();
      this.reservedTools.set(definition.name, names);
    }
    names.add(toolName);
  }

  protectTool(identifier: string, toolName: string): void {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) throw new Error(`Unknown package "${identifier}"`);
    let names = this.protectedTools.get(definition.name);
    if (!names) {
      names = new Set<string>();
      this.protectedTools.set(definition.name, names);
    }
    names.add(toolName);
  }

  isCommandCaptured(identifier: string, commandName: string): boolean {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) return false;
    return this.hasCapturedCommand(definition.name, commandName);
  }

  getCommandStatus(identifier: string, commandName: string): CommandStatus {
    const pkgState = this.getPackageState(identifier);
    if (!pkgState) return "deferred";
    if (pkgState.status === "loaded") {
      return this.isCommandCaptured(identifier, commandName) ? "ready" : "missing";
    }
    if (pkgState.status === "failed") return "failed";
    if (pkgState.status === "loading") return "loading";
    return "deferred";
  }

  async invokeCapturedCommand(identifier: string, commandName: string, args: string, ctx: any): Promise<any> {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) throw new Error(`Unknown package "${identifier}"`);
    const command = this.getCapturedCommand(definition.name, commandName);
    if (!command?.handler) throw new Error(`Package "${definition.name}" did not register reserved command "${commandName}"`);
    return await command.handler(args, ctx);
  }

  getPackageState(identifier: string): PackageState | undefined {
    const definition = findPackageDefinition(
      Array.from(this.states.values(), (state) => state.definition),
      identifier
    );
    return definition ? this.states.get(definition.name) : undefined;
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
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) {
      return {
        success: false,
        status: "failed",
        package: identifier,
        source: identifier,
        error: `Unknown package "${identifier}". Add it to lazy-loader.json before lazy loading.`,
      };
    }

    let pkgState = this.states.get(definition.name);
    if (!pkgState) {
      pkgState = {
        definition,
        status: "deferred",
        loadedEntries: [],
        newTools: [],
        missingTools: [],
      };
      this.states.set(definition.name, pkgState);
    }

    // 1. Idempotent check
    if (pkgState.status === "loaded") {
      return {
        success: true,
        status: "loaded",
        alreadyLoaded: true,
        package: definition.name,
        source: definition.source,
        newTools: pkgState.newTools,
        missingTools: pkgState.missingTools.length > 0 ? pkgState.missingTools : undefined,
        entries: pkgState.loadedEntries,
        loadMs: pkgState.loadMs,
      };
    }

    // 1b. Sticky session failure check: a failed package cannot be reloaded in this session
    if (pkgState.status === "failed") {
      return {
        success: false,
        status: "failed",
        package: definition.name,
        source: definition.source,
        error: `Package "${definition.name}" failed previously in this session (${pkgState.error ?? "unknown error"}). Use /reload or restart the session to retry.`,
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
        const entries = resolvePackageEntries(definition, this.agentDir);
        const toolsBefore = new Set((this.pi?.getAllTools?.() ?? []).map((t: any) => t.name));

        const stagedRegistrations = new Map<string, any>();
        const stagedTools = new Map<string, any>();
        const newlyLoaded: string[] = [];
        const observedTools = new Map<string, any>();
        const observedCommands = new Map<string, any>();
        for (const entryPath of entries) {
          await this.loadSingleEntry(
            entryPath,
            definition.name,
            stagedRegistrations,
            stagedTools,
            observedTools,
            observedCommands
          );
          newlyLoaded.push(entryPath);
        }

        // Commit staged registrations atomically only after all entries and lifecycle replay succeeded
        for (const [name, targetOptions] of stagedRegistrations.entries()) {
          this.setCapturedCommand(definition.name, name, targetOptions);

          const meta = this.reservedCommands.get(definition.name)?.get(name);
          const shouldDecorate =
            meta?.decorateDescription ??
            meta?.declaredDescription !== undefined;

          let committedOptions: any;
          if (shouldDecorate) {
            const descCtx: CommandDescriptionContext = {
              packageName: definition.name,
              commandName: name,
              declaredDescription: meta?.declaredDescription,
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

        // Commit staged reserved real tools so they replace proxies.
        for (const tool of stagedTools.values()) this.pi.registerTool(tool);

        // Track cached tools that disappeared from the loaded package
        const reserved = this.reservedTools.get(definition.name);
        const missingTools: string[] = [];
        if (reserved) {
          for (const toolName of reserved) {
            if (!stagedTools.has(toolName)) {
              missingTools.push(toolName);
            }
          }
        }

        const toolsAfter = (this.pi?.getAllTools?.() ?? []).map((t: any) => t.name);
        const diffTools = toolsAfter.filter((name: string) => !toolsBefore.has(name));
        const finalTools = observedTools.size > 0 ? Array.from(observedTools.keys()) : diffTools;

        pkgState.status = "loaded";
        pkgState.loadedEntries = newlyLoaded;
        pkgState.newTools = finalTools;
        pkgState.missingTools = missingTools;
        pkgState.loadMs = Date.now() - t0;
        pkgState.error = undefined;

        // Refresh every exposed command and tool for the next session.
        this.refreshCache(definition.name, observedTools, observedCommands);

        return {
          success: true,
          status: "loaded",
          alreadyLoaded: false,
          package: definition.name,
          source: definition.source,
          newTools: finalTools,
          missingTools: missingTools.length > 0 ? missingTools : undefined,
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
          package: definition.name,
          source: definition.source,
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
    stagedTools?: Map<string, any>,
    observedTools?: Map<string, any>,
    observedCommands?: Map<string, any>
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
    const refreshIfLoaded = () => {
      if (observedTools && observedCommands && this.states.get(packageName)?.status === "loaded") {
        this.refreshCache(packageName, observedTools, observedCommands);
      }
    };

    const proxy = new Proxy(this.pi, {
      get: (target: any, prop: string | symbol, receiver: any) => {
        if (prop === "registerTool") {
          return (tool: any) => {
            if (tool && typeof tool.name === "string") {
              observedTools?.set(tool.name, tool);
              refreshIfLoaded();
              if (this.protectedTools.get(packageName)?.has(tool.name)) return;
              if (this.reservedTools.get(packageName)?.has(tool.name)) {
                stagedTools?.set(tool.name, tool);
                return;
              }
            }
            return typeof target.registerTool === "function" ? target.registerTool(tool) : undefined;
          };
        }
        if (prop === "registerCommand") {
          return (name: string, command: any) => {
            observedCommands?.set(name, command);
            refreshIfLoaded();
            if (this.protectedCommands.get(packageName)?.has(name)) return;
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
