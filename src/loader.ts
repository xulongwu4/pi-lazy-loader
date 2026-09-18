import { findPackageDefinition, type PackageDefinition } from "./package.js";
import { resolvePackageEntries } from "./resolver.js";
import { getAgentDir, importExtensionFactory, replayMissedLifecycle } from "./pi-host.js";
import { readLazyLoaderConfig } from "./config.js";
import { updateCachedPackage, type CachedRegistration, isCachedToolSchema, schemaIsJsonRepresentable, cloneJsonValue } from "./cache.js";
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
  /** Load-commit snapshot of reserved tools that were not registered. Not updated on late capture. */
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

export class CacheDriftError extends Error {
  readonly code = "CACHE_DRIFT" as const;
  readonly kind: "tool" | "command";
  readonly packageName: string;
  readonly target: string;
  constructor(kind: "tool" | "command", packageName: string, name: string) {
    super(`Package "${packageName}" did not register reserved ${kind} "${name}"`);
    this.name = "CacheDriftError";
    this.kind = kind;
    this.packageName = packageName;
    this.target = name;
  }
}

export function isExecutableCapture(kind: "tool" | "command", registration: any): boolean {
  return typeof registration?.[kind === "command" ? "handler" : "execute"] === "function";
}

function filterUncommittedReserved(
  items: any,
  reserved: { has(name: string): boolean; size: number } | undefined,
  protectedNames: { has(name: string): boolean } | undefined,
  observed: { has(name: string): boolean } | undefined,
  nameOf: (item: any) => unknown,
): any {
  if (!reserved?.size || !Array.isArray(items)) return items;
  return items.filter((item: any) => {
    const name = nameOf(item);
    if (typeof name !== "string" || !reserved.has(name)) return true;
    if (protectedNames?.has(name)) return true;
    if (observed?.has(name)) return true;
    return false;
  });
}

function dispatchReservedStatus(
  status: PackageLoadStatus | undefined,
  commit: () => void,
  stage: () => void,
): void {
  if (status === "loaded") commit();
  else if (status === "loading") stage();
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
  private capturedTools = new Map<string, Map<string, any>>();
  private protectedTools = new Map<string, Set<string>>();
  private cacheRefreshQueued = new Set<string>();

  private ensureNested<T>(map: Map<string, T>, key: string, create: () => T): T {
    let nested = map.get(key);
    if (!nested) {
      nested = create();
      map.set(key, nested);
    }
    return nested;
  }

  private getCaptured(store: Map<string, Map<string, any>>, packageName: string, name: string): any {
    return store.get(packageName)?.get(name);
  }

  private setCaptured(store: Map<string, Map<string, any>>, packageName: string, name: string, value: any): void {
    this.ensureNested(store, packageName, () => new Map<string, any>()).set(name, value);
  }

  private hasCapturedCommand(packageName: string, commandName: string): boolean {
    return isExecutableCapture("command", this.getCaptured(this.capturedCommands, packageName, commandName));
  }

  private requireDefinitionName(identifier: string): string {
    const definition = this.getPackageState(identifier)?.definition;
    if (!definition) throw new Error(`Unknown package "${identifier}"`);
    return definition.name;
  }

  private requireCaptured(kind: "tool" | "command", identifier: string, name: string): any {
    const packageName = this.requireDefinitionName(identifier);
    const item = this.getCaptured(
      kind === "command" ? this.capturedCommands : this.capturedTools,
      packageName,
      name,
    );
    if (!isExecutableCapture(kind, item)) throw new CacheDriftError(kind, packageName, name);
    return item;
  }

  private refreshCache(
    packageName: string,
    observedTools: Map<string, any>,
    observedCommands: Map<string, any>
  ): void {
    try {
      const registrations = (items: Map<string, any>): CachedRegistration[] =>
        Array.from(items.entries()).map(([name, value]) => {
          let parameters: unknown;
          const raw = value?.parameters;
          if (raw !== undefined && raw !== null) {
            if (!isCachedToolSchema(raw) || !schemaIsJsonRepresentable(raw)) {
              console.error(`[pi-lazy-loader] Skipping non-JSON parameter schema for "${name}" in "${packageName}"`);
            } else {
              // schemaIsJsonRepresentable already allowed only TYPEBOX_JSON_META (~kind/~optional/~readonly/~unsafe).
              parameters = cloneJsonValue(raw);
            }
          }
          return {
            name,
            description: typeof value?.description === "string" ? value.description : undefined,
            parameters,
            executionMode: value?.executionMode,
            constrainedSampling: value?.constrainedSampling,
            hasPrepareArguments: typeof value?.prepareArguments === "function" ? true : undefined,
            promptSnippet: value?.promptSnippet,
            promptGuidelines: value?.promptGuidelines,
          };
        });
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

  private scheduleCacheRefresh(
    packageName: string,
    observedTools: Map<string, any>,
    observedCommands: Map<string, any>,
  ): void {
    if (this.states.get(packageName)?.status !== "loaded") return;
    if (this.cacheRefreshQueued.has(packageName)) return;
    this.cacheRefreshQueued.add(packageName);
    queueMicrotask(() => {
      this.cacheRefreshQueued.delete(packageName);
      this.refreshCache(packageName, observedTools, observedCommands);
    });
  }

  private commitReservedCommand(packageName: string, name: string, targetOptions: any): void {
    if (!isExecutableCapture("command", targetOptions)) return;
    if (this.hasCapturedCommand(packageName, name)) {
      throw new Error(
        `Duplicate target registration for command "${name}" in package "${packageName}"`
      );
    }
    this.setCaptured(this.capturedCommands, packageName, name, targetOptions);
    const meta = this.reservedCommands.get(packageName)?.get(name);
    const shouldDecorate = meta?.decorateDescription ?? meta?.declaredDescription !== undefined;
    const committedOptions = shouldDecorate
      ? {
          ...targetOptions,
          description: formatPostLoadDescription(
            {
              packageName,
              commandName: name,
              declaredDescription: meta?.declaredDescription,
            } satisfies CommandDescriptionContext,
            targetOptions?.description,
          ),
        }
      : { ...targetOptions };
    this.pi.registerCommand(name, committedOptions);
  }

  private commitReservedTool(packageName: string, name: string, tool: any): void {
    if (!isExecutableCapture("tool", tool)) return;
    this.setCaptured(this.capturedTools, packageName, name, tool);
    this.pi.registerTool(tool);
  }

  constructor(pi: any, agentDir?: string, packages?: PackageDefinition[]) {
    this.pi = pi;
    this.agentDir = agentDir ?? getAgentDir();

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
    const packageName = this.requireDefinitionName(identifier);
    this.ensureNested(this.reservedCommands, packageName, () => new Map<string, ReserveCommandOptions>()).set(commandName, metadata ?? {});
  }

  protectCommand(identifier: string, commandName: string): void {
    const packageName = this.requireDefinitionName(identifier);
    this.ensureNested(this.protectedCommands, packageName, () => new Set<string>()).add(commandName);
  }

  reserveTool(identifier: string, toolName: string): void {
    const packageName = this.requireDefinitionName(identifier);
    this.ensureNested(this.reservedTools, packageName, () => new Set<string>()).add(toolName);
  }

  protectTool(identifier: string, toolName: string): void {
    const packageName = this.requireDefinitionName(identifier);
    this.ensureNested(this.protectedTools, packageName, () => new Set<string>()).add(toolName);
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
    const command = this.requireCaptured("command", identifier, commandName);
    return await command.handler(args, ctx);
  }

  async invokeCapturedTool(
    identifier: string,
    toolName: string,
    toolCallId: string,
    params: any,
    signal: AbortSignal,
    onUpdate: any,
    ctx: any,
  ): Promise<any> {
    const tool = this.requireCaptured("tool", identifier, toolName);
    return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
  }

  getCapturedTool(identifier: string, toolName: string): any | undefined {
    const packageName = this.getPackageState(identifier)?.definition.name;
    if (!packageName) return undefined;
    return this.getCaptured(this.capturedTools, packageName, toolName);
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
          this.commitReservedCommand(definition.name, name, targetOptions);
        }

        // Commit staged reserved real tools so they replace proxies.
        for (const [name, tool] of stagedTools.entries()) {
          this.commitReservedTool(definition.name, name, tool);
        }

        // Track cached tools that disappeared from the loaded package
        const reserved = this.reservedTools.get(definition.name);
        const missingTools: string[] = [];
        if (reserved) {
          for (const toolName of reserved) {
            if (!isExecutableCapture("tool", this.getCaptured(this.capturedTools, definition.name, toolName))) {
              missingTools.push(toolName);
            }
          }
        }

        const toolsAfter = (this.pi?.getAllTools?.() ?? []).map((t: any) => t.name);
        const diffTools = toolsAfter.filter((name: string) => !toolsBefore.has(name));
        const finalTools = observedTools.size > 0
          ? Array.from(observedTools.entries())
              .filter(([, tool]) => isExecutableCapture("tool", tool))
              .map(([name]) => name)
          : diffTools;

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
    const factory = await importExtensionFactory(entryPath);

    // Proxy pi.on to capture handlers registered by this entry while registering them for future events
    const capturedHandlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
    const refreshIfLoaded = () => {
      if (observedTools && observedCommands) {
        this.scheduleCacheRefresh(packageName, observedTools, observedCommands);
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
                dispatchReservedStatus(
                  this.states.get(packageName)?.status,
                  () => this.commitReservedTool(packageName, tool.name, tool),
                  () => {
                    stagedTools?.set(tool.name, tool);
                  },
                );
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
              dispatchReservedStatus(
                this.states.get(packageName)?.status,
                () => this.commitReservedCommand(packageName, name, command),
                () => {
                  if (stagedRegistrations?.has(name)) {
                    throw new Error(
                      `Duplicate target registration for command "${name}" in package "${packageName}"`
                    );
                  }
                  stagedRegistrations?.set(name, command);
                },
              );
              return;
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
        // Hide this package's uncommitted reserved proxies so skip-if-registered
        // factories still call registerCommand/registerTool once. Leave protected
        // names and already-observed names visible so a later check does not re-register.
        if (prop === "getCommands" && typeof target.getCommands === "function") {
          return (...args: any[]) => filterUncommittedReserved(
            target.getCommands(...args),
            this.reservedCommands.get(packageName),
            this.protectedCommands.get(packageName),
            observedCommands,
            (command: any) => command?.name,
          );
        }
        if (prop === "getAllTools" && typeof target.getAllTools === "function") {
          return (...args: any[]) => filterUncommittedReserved(
            target.getAllTools(...args),
            this.reservedTools.get(packageName),
            this.protectedTools.get(packageName),
            observedTools,
            (tool: any) => tool?.name,
          );
        }
        if (prop === "getActiveTools" && typeof target.getActiveTools === "function") {
          return (...args: any[]) => filterUncommittedReserved(
            target.getActiveTools(...args),
            this.reservedTools.get(packageName),
            this.protectedTools.get(packageName),
            observedTools,
            (name: any) => name,
          );
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });

    // Invoke factory with live API proxy
    await factory(proxy);

    await replayMissedLifecycle(capturedHandlers, this.lifecycleState);
  }
}
