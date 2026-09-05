import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(currentDir, "..");
const realAgentDir = join(homedir(), ".pi", "agent");

console.log("===============================================================================");
console.log("=== Running v0.3.0 Release Verification: Clean Pack, TUI Matrix, A/B Benchmark ===");
console.log("===============================================================================\n");

// -----------------------------------------------------------------------------
// STEP 1: Clean Pack & Consumer Installation Smoke
// -----------------------------------------------------------------------------
console.log("--- Step 1: Clean Pack and Consumer Installation Smoke ---");

const packTempDir = join(tmpdir(), `pi-lazy-pack-v030-${Date.now()}`);
mkdirSync(packTempDir, { recursive: true });
const consumerTempDir = join(tmpdir(), `pi-lazy-consumer-v030-${Date.now()}`);
mkdirSync(consumerTempDir, { recursive: true });

let installedIndexPath = "";

try {
  const packProc = spawnSync("npm", ["pack", "--pack-destination", packTempDir], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  assert(packProc.status === 0, `npm pack failed: ${packProc.stderr}`);
  const tgzFile = readdirSync(packTempDir).find((f) => f.endsWith(".tgz"));
  assert(tgzFile !== undefined, "Packed tarball must exist");
  const tgzPath = join(packTempDir, tgzFile);
  console.log(`  ✓ Packed tarball: ${tgzFile}`);

  writeFileSync(
    join(consumerTempDir, "package.json"),
    JSON.stringify({ name: "consumer-v030-smoke", type: "module" }, null, 2),
    "utf-8"
  );
  const bunAdd = spawnSync("bun", ["add", tgzPath], {
    cwd: consumerTempDir,
    encoding: "utf-8",
  });
  assert(bunAdd.status === 0, `bun add failed: ${bunAdd.stderr}`);

  const installedDir = join(consumerTempDir, "node_modules", "pi-lazy-loader");
  installedIndexPath = join(installedDir, "index.ts");
  assert(existsSync(installedIndexPath), `Installed index.ts must exist at ${installedIndexPath}`);

  const consumerModules = readdirSync(join(consumerTempDir, "node_modules"));
  assert(
    !consumerModules.includes("@earendil-works"),
    "Installed package must not bundle duplicate @earendil-works Pi runtime peers"
  );
  console.log("  ✓ Clean install verified: zero duplicate Pi peer runtimes");
} catch (err) {
  rmSync(packTempDir, { recursive: true, force: true });
  rmSync(consumerTempDir, { recursive: true, force: true });
  throw err;
}

// -----------------------------------------------------------------------------
// STEP 2: Real Detached tmux TUI Matrix
// -----------------------------------------------------------------------------
console.log("\n--- Step 2: Real Detached tmux TUI Matrix (/token-burden, /mcp, /pi-mcp, /mcp-auth) ---");

const tmuxAgentDir = join(tmpdir(), `pi-lazy-tmux-agent-${Date.now()}`);
mkdirSync(tmuxAgentDir, { recursive: true });

// Symlink real package caches and auth without mutating ~/.pi
for (const item of ["npm", "git", "auth.json", "models.json", "models-store.json", "mcp.json", "mcp-cache.json"]) {
  const src = join(realAgentDir, item);
  if (existsSync(src)) {
    symlinkSync(src, join(tmuxAgentDir, item));
  }
}

// Isolated settings deferring pi-mcp-adapter and pi-token-burden
writeFileSync(
  join(tmuxAgentDir, "settings.json"),
  JSON.stringify(
    {
      packages: [
        { source: "npm:pi-mcp-adapter", extensions: [] },
        { source: "npm:pi-token-burden", extensions: [] },
        { source: "npm:pi-web-access", extensions: [] },
      ],
    },
    null,
    2
  ),
  "utf-8"
);

const reportPath = join(tmpdir(), `pi-lazy-tmux-report-${Date.now()}.json`);
const sessionName = `pi_tui_matrix_${Date.now()}`;

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function capturePane(lines = 100): string {
  const proc = spawnSync("tmux", ["capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`], {
    encoding: "utf-8",
  });
  return proc.stdout ?? "";
}

function pollPane(predicate: (output: string) => boolean, timeoutMs = 8000, stepMs = 250): string {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const text = capturePane();
    if (predicate(text)) return text;
    sleepMs(stepMs);
  }
  const last = capturePane();
  throw new Error(`Timeout waiting for predicate. Current pane capture:\n${last}`);
}

const tuiResults: Record<string, any> = {};

try {
  // Launch Pi inside detached tmux
  const launchCmd = `PI_CODING_AGENT_DIR=${tmuxAgentDir} PI_LAZY_REPORT_PATH=${reportPath} pi -e ${installedIndexPath}`;
  const startProc = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-x", "120", "-y", "40", launchCmd]);
  assert(startProc.status === 0, `Failed to create tmux session: ${startProc.stderr}`);

  // Wait for Pi startup: prompt line with model or skills visible
  console.log("  Waiting for Pi TUI to initialize in tmux session...");
  pollPane((t) => t.includes("pi-lazy-loader") || t.includes("[Skills]") || t.includes("claude-") || t.includes("glm-"), 15000);
  console.log("  ✓ Pi TUI session initialized");

  // Read initial report before any command
  sleepMs(500);
  assert(existsSync(reportPath), "Diagnostic report file must exist after session_start");
  const initialReport = JSON.parse(readFileSync(reportPath, "utf-8"));
  assert(initialReport.sessionStartCaptured === true, "session_start must be captured");

  // Initial commands check: stubs must be present, no :1 suffix
  const initCmds: Array<{ name: string; description: string }> = initialReport.registeredCommands ?? [];
  for (const expected of ["token-burden", "mcp", "pi-mcp", "mcp-auth"]) {
    const found = initCmds.find((c) => c.name === expected);
    assert(found !== undefined, `Proxy command /${expected} must be registered at startup`);
    assert(found.description.includes("lazy target:"), `Startup description for /${expected} must show lazy target`);
    assert(!initCmds.some((c) => c.name === `${expected}:1`), `No ${expected}:1 duplicate allowed at startup`);
  }
  console.log("  ✓ Startup proxy stubs verified in Pi command map (no :1 duplicates)");

  // 1. Invoke /token-burden
  console.log("  Invoking /token-burden...");
  const t0_tb = Date.now();
  spawnSync("tmux", ["send-keys", "-t", sessionName, "/token-burden", "Enter"]);
  const tbPane = pollPane((t) => t.includes("Token Burden"), 8000);
  const tbMs = Date.now() - t0_tb;
  assert(tbPane.includes("Token Burden"), "Token Burden overlay must be visible");
  tuiResults.tokenBurden = { ms: tbMs, opened: true };
  console.log(`  ✓ /token-burden opened genuine Token Burden overlay in ${tbMs}ms`);
  spawnSync("tmux", ["send-keys", "-t", sessionName, "Escape"]);
  sleepMs(500);

  // 2. Invoke /mcp
  console.log("  Invoking /mcp...");
  const t0_mcp = Date.now();
  spawnSync("tmux", ["send-keys", "-t", sessionName, "/mcp", "Enter"]);
  const mcpPane = pollPane((t) => t.includes("MCP Servers") || t.includes("MCP Server Status"), 8000);
  const mcpMs = Date.now() - t0_mcp;
  assert(mcpPane.includes("MCP Servers") || mcpPane.includes("MCP Server Status"), "MCP UI must be visible");
  tuiResults.mcp = { ms: mcpMs, opened: true };
  console.log(`  ✓ /mcp opened genuine MCP UI in ${mcpMs}ms`);
  spawnSync("tmux", ["send-keys", "-t", sessionName, "Escape"]);
  sleepMs(500);

  // 3. Invoke /pi-mcp
  console.log("  Invoking /pi-mcp...");
  const t0_pimcp = Date.now();
  spawnSync("tmux", ["send-keys", "-t", sessionName, "/pi-mcp", "Enter"]);
  const pimcpPane = pollPane((t) => t.includes("MCP Servers") || t.includes("MCP Server Status"), 8000);
  const pimcpMs = Date.now() - t0_pimcp;
  assert(pimcpPane.includes("MCP Servers") || pimcpPane.includes("MCP Server Status"), "pi-mcp UI must be visible");
  tuiResults.piMcp = { ms: pimcpMs, opened: true };
  console.log(`  ✓ /pi-mcp opened genuine MCP UI in ${pimcpMs}ms`);
  spawnSync("tmux", ["send-keys", "-t", sessionName, "Escape"]);
  sleepMs(500);

  // 4. Invoke safe /mcp-auth missing-server
  console.log("  Invoking /mcp-auth missing-server...");
  const t0_auth = Date.now();
  spawnSync("tmux", ["send-keys", "-t", sessionName, "/mcp-auth missing-server", "Enter"]);
  const authPane = pollPane((t) => t.includes("Server \"missing-server\" not found in config") || t.includes("missing-server"), 8000);
  const authMs = Date.now() - t0_auth;
  assert(
    authPane.includes("Server \"missing-server\" not found in config"),
    "Real handler error notification must appear for missing server"
  );
  assert(
    !authPane.includes("OAuth") && !authPane.includes("Browser") && !authPane.includes("Authorize"),
    "Safe missing server test must NOT trigger OAuth flow"
  );
  tuiResults.mcpAuth = { ms: authMs, executed: true };
  console.log(`  ✓ /mcp-auth executed real handler and reported missing server without OAuth in ${authMs}ms`);

  // Exit tmux session cleanly
  spawnSync("tmux", ["send-keys", "-t", sessionName, "C-c"]);
  sleepMs(200);
  spawnSync("tmux", ["send-keys", "-t", sessionName, "/quit", "Enter"]);
  sleepMs(500);

  // Read post-invocation report
  const finalReport = JSON.parse(readFileSync(reportPath, "utf-8"));
  const postCmds: Array<{ name: string; description: string }> = finalReport.registeredCommands ?? [];

  // Assert delegated provenance and NO :1 suffixes across all commands
  for (const cmdName of ["token-burden", "mcp", "pi-mcp", "mcp-auth"]) {
    const postCmd = postCmds.find((c) => c.name === cmdName);
    assert(postCmd !== undefined, `Post-load command /${cmdName} must remain in command map`);
    assert(
      postCmd.description.includes("; via pi-lazy-loader]"),
      `Post-load description for /${cmdName} must have delegated attribution, got: "${postCmd.description}"`
    );
    assert(!postCmds.some((c) => c.name === `${cmdName}:1`), `Command /${cmdName} MUST NOT have :1 suffix`);
  }
  console.log("  ✓ All post-load commands verified: delegated provenance intact, zero :1 suffixes");
} finally {
  spawnSync("tmux", ["kill-session", "-t", sessionName]);
  rmSync(tmuxAgentDir, { recursive: true, force: true });
  rmSync(reportPath, { force: true });
}

// -----------------------------------------------------------------------------
// STEP 3: Alternating A/B Startup Benchmark
// -----------------------------------------------------------------------------
console.log("\n--- Step 3: Alternating A/B Startup Timing Measurements ---");

const ITERATIONS = 6;
const eagerTimes: number[] = [];
const lazyTimes: number[] = [];

// Prepare two isolated agent directories for clean, non-interfering measurements
const benchDirEager = join(tmpdir(), `pi-lazy-bench-eager-${Date.now()}`);
const benchDirLazy = join(tmpdir(), `pi-lazy-bench-lazy-${Date.now()}`);
mkdirSync(benchDirEager, { recursive: true });
mkdirSync(benchDirLazy, { recursive: true });

for (const dir of [benchDirEager, benchDirLazy]) {
  for (const item of ["npm", "git", "auth.json", "models.json", "models-store.json", "mcp.json", "mcp-cache.json"]) {
    const src = join(realAgentDir, item);
    if (existsSync(src)) symlinkSync(src, join(dir, item));
  }
}

// Eager settings: pi-mcp-adapter and pi-token-burden are eager
writeFileSync(
  join(benchDirEager, "settings.json"),
  JSON.stringify(
    {
      packages: [
        "npm:pi-mcp-adapter",
        "npm:pi-token-burden",
      ],
    },
    null,
    2
  ),
  "utf-8"
);

// Lazy settings: deferred under pi-lazy-loader
writeFileSync(
  join(benchDirLazy, "settings.json"),
  JSON.stringify(
    {
      packages: [
        { source: "npm:pi-mcp-adapter", extensions: [] },
        { source: "npm:pi-token-burden", extensions: [] },
      ],
    },
    null,
    2
  ),
  "utf-8"
);

function measureStartup(agentDir: string, loadLoader: boolean): number {
  const args: string[] = [];
  if (loadLoader) {
    args.push("-e", installedIndexPath);
  }
  args.push("--list-models");

  const t0 = performance.now();
  const proc = spawnSync("pi", args, {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    encoding: "utf-8",
  });
  const t1 = performance.now();
  assert(proc.status === 0, `Startup failed: ${proc.stderr}`);
  return (t1 - t0) / 1000;
}

// Warm up once
console.log("  Warming up measurement host...");
measureStartup(benchDirEager, false);
measureStartup(benchDirLazy, true);

console.log(`  Executing ${ITERATIONS} alternating A/B iterations...`);
for (let i = 0; i < ITERATIONS; i++) {
  // Alternate order: even iterations Eager then Lazy; odd iterations Lazy then Eager
  if (i % 2 === 0) {
    const tEager = measureStartup(benchDirEager, false);
    const tLazy = measureStartup(benchDirLazy, true);
    eagerTimes.push(tEager);
    lazyTimes.push(tLazy);
    console.log(`  Iter ${i + 1} (Eager -> Lazy): Eager = ${tEager.toFixed(3)}s, Lazy = ${tLazy.toFixed(3)}s, Net = ${(tEager - tLazy).toFixed(3)}s`);
  } else {
    const tLazy = measureStartup(benchDirLazy, true);
    const tEager = measureStartup(benchDirEager, false);
    lazyTimes.push(tLazy);
    eagerTimes.push(tEager);
    console.log(`  Iter ${i + 1} (Lazy -> Eager): Eager = ${tEager.toFixed(3)}s, Lazy = ${tLazy.toFixed(3)}s, Net = ${(tEager - tLazy).toFixed(3)}s`);
  }
}

rmSync(benchDirEager, { recursive: true, force: true });
rmSync(benchDirLazy, { recursive: true, force: true });
rmSync(packTempDir, { recursive: true, force: true });
rmSync(consumerTempDir, { recursive: true, force: true });

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const eagerMin = Math.min(...eagerTimes);
const lazyMin = Math.min(...lazyTimes);
const eagerMedian = median(eagerTimes);
const lazyMedian = median(lazyTimes);
const savingsMedian = eagerMedian - lazyMedian;

console.log("\n--- A/B Benchmark Summary ---");
console.log(`  Eager  runs: ${eagerTimes.map((t) => t.toFixed(3)).join(", ")} s`);
console.log(`  Lazy   runs: ${lazyTimes.map((t) => t.toFixed(3)).join(", ")} s`);
console.log(`  Eager  min: ${eagerMin.toFixed(3)}s | median: ${eagerMedian.toFixed(3)}s`);
console.log(`  Lazy   min: ${lazyMin.toFixed(3)}s | median: ${lazyMedian.toFixed(3)}s`);
console.log(`  Median net savings: ${savingsMedian.toFixed(3)}s (positive net savings confirmed)`);

assert(savingsMedian > 0, `Median net savings must be positive, got ${savingsMedian.toFixed(3)}s`);

console.log("\n===============================================================================");
console.log("=== v0.3.0 Release Verification: ALL GATES AND CHECKS PASSED ===");
console.log("===============================================================================");
