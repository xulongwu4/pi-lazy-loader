export function fakePi(active: string[] = []) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const restored: string[][] = [];
  const handlers = new Map<string, Function[]>();
  return {
    tools,
    commands,
    restored,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getCommands() {
      return Array.from(commands, ([name, command]) => ({ name, ...command }));
    },
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
    getAllTools() {
      return Array.from(tools.values());
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      restored.push([...names]);
    },
  };
}
