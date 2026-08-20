/**
 * @experimental This module is experimental and not yet validated for production use.
 *
 * batch.ts — Autonomous batch runner for overnight ticket processing.
 *
 * Runs multiple tickets sequentially with autoApprove=true. Supports:
 *   - Ralph loop (re-run each ticket N times, iteration 2+ gets prior context)
 *   - Per-ticket timeout (kills engine if it exceeds limit)
 *   - Circuit breaker (halts entire batch after N consecutive failures)
 *   - Aggregated report in runs/batch-{date}/report.md
 *
 * Usage:
 *   npx tsx src/batch.ts --tickets PROJ-1,PROJ-2
 *   npx tsx src/batch.ts --tickets-file tickets.txt --max-iterations 2
 *   npx tsx src/batch.ts --mock --scenario story --tickets MOCK-1,MOCK-2,MOCK-3
 *   npx tsx src/batch.ts --mock --tickets MOCK-1 < /dev/null   # headless/cron
 *
 * --repo-root <path>  Root of the repo the runner operates on.
 *                     Defaults to WORKFLOW_REPO_ROOT env var, then process.cwd().
 *
 * Exit codes:
 *   0 — all tickets completed
 *   1 — partial failures (some blocked/error)
 *   2 — circuit breaker triggered
 */
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadWorkflow } from "./workflow/WorkflowLoader.js";
import { WorkflowEngine } from "./workflow/WorkflowEngine.js";
import type { WorkflowSnapshot } from "./workflow/WorkflowEngine.js";
import { OpenAiRunner } from "./agent/OpenAiRunner.js";
import { AnthropicRunner } from "./agent/AnthropicRunner.js";
import { ClaudeSdkRunner } from "./agent/ClaudeSdkRunner.js";
import { MockAgentRunner } from "./agent/MockAgentRunner.js";
import type { AgentRunner, WorkflowEvent } from "./agent/AgentRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = join(__dirname, "..");

// ─── Types ──────────────────────────────────────────────────────────────────

type RunnerType = "openai" | "anthropic" | "claude-sdk" | "mock";

interface BatchArgs {
  tickets: string[];
  ticketsFile?: string;
  maxIterations: number;
  timeoutPerTicket: number; // minutes; 0 = no timeout
  circuitBreaker: number;
  runner: RunnerType;
  dryRun: boolean;
  mock: boolean;
  scenario: string;
  workflow?: string;
  repoRoot?: string;
}

export interface TicketResult {
  ticketId: string;
  iterations: number;
  state: string;
  totalTokens: number;
  durationMs: number;
  notes: string;
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(): BatchArgs {
  const argv = process.argv.slice(2);
  const parsed: BatchArgs = {
    tickets: [],
    maxIterations: 1,
    timeoutPerTicket: 0,
    circuitBreaker: 5,
    runner: "openai",
    dryRun: false,
    mock: false,
    scenario: "story",
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--tickets":
        parsed.tickets = argv[++i].split(",").map((t) => t.trim());
        break;
      case "--tickets-file":
        parsed.ticketsFile = argv[++i];
        break;
      case "--max-iterations":
        parsed.maxIterations = parseInt(argv[++i], 10);
        break;
      case "--timeout-per-ticket":
        parsed.timeoutPerTicket = parseInt(argv[++i], 10);
        break;
      case "--circuit-breaker":
        parsed.circuitBreaker = parseInt(argv[++i], 10);
        break;
      case "--runner": {
        const v = argv[++i];
        if (v !== "openai" && v !== "anthropic" && v !== "claude-sdk" && v !== "mock") {
          console.error(`Unknown runner: ${v}. Use openai|anthropic|claude-sdk|mock`);
          process.exit(1);
        }
        parsed.runner = v;
        break;
      }
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--mock":
        parsed.mock = true;
        parsed.runner = "mock";
        break;
      case "--scenario":
        parsed.scenario = argv[++i];
        break;
      case "--workflow":
        parsed.workflow = argv[++i];
        break;
      case "--repo-root":
        parsed.repoRoot = argv[++i];
        break;
    }
  }

  // Load tickets from file if given
  if (parsed.ticketsFile) {
    const lines = readFileSync(parsed.ticketsFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    parsed.tickets.push(...lines);
  }

  return parsed;
}

// ─── Mock data loader ────────────────────────────────────────────────────────

interface MockScenario {
  description: string;
  phases: Record<string, Record<string, unknown>>;
}

function loadMockScenario(scenario: string): MockScenario {
  const mockPath = join(SDK_ROOT, "examples", "example-mock-data.yaml");
  const mockData = yaml.load(readFileSync(mockPath, "utf-8")) as {
    scenarios: Record<string, MockScenario>;
  };
  const s = mockData.scenarios[scenario];
  if (!s) {
    console.error(`Unknown mock scenario: ${scenario}`);
    process.exit(1);
  }
  return s;
}

// ─── Runner factory ───────────────────────────────────────────────────────────

function makeRunner(args: BatchArgs, scenarioData?: MockScenario): AgentRunner {
  const repoRoot = args.repoRoot ?? process.env.WORKFLOW_REPO_ROOT ?? process.cwd();
  if (args.mock || args.runner === "mock") {
    const runner = new MockAgentRunner();
    if (scenarioData) {
      for (const [phaseId, outputs] of Object.entries(scenarioData.phases)) {
        runner.setPhaseOutput(phaseId, outputs);
      }
    }
    return runner;
  }
  if (args.runner === "anthropic") {
    return new AnthropicRunner({ repoRoot, dryRun: args.dryRun });
  }
  if (args.runner === "claude-sdk") {
    return new ClaudeSdkRunner({ repoRoot, dryRun: args.dryRun });
  }
  return new OpenAiRunner({ repoRoot, dryRun: args.dryRun });
}

// ─── Timeout wrapper ─────────────────────────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMinutes: number,
  label: string,
): Promise<T> {
  if (timeoutMinutes <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`Timeout: ${label} exceeded ${timeoutMinutes}m`)),
        timeoutMinutes * 60 * 1000,
      ),
    ),
  ]);
}

// ─── Single ticket run ───────────────────────────────────────────────────────

export async function runTicket(
  ticketId: string,
  iterationIdx: number,
  args: BatchArgs,
  workflowPath: string,
  batchDir: string,
  previousContext: Record<string, unknown> | undefined,
  scenarioData: MockScenario | undefined,
): Promise<{ snap: WorkflowSnapshot; tokens: number; runDir: string }> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const label = iterationIdx > 0 ? `iter${iterationIdx + 1}` : "run";
  const runDir = join(batchDir, `${ticketId}-${label}-${ts}`);
  mkdirSync(runDir, { recursive: true });

  const workflow = loadWorkflow(workflowPath);
  const workflowDir = dirname(workflowPath);
  const events: WorkflowEvent[] = [];

  const runner = makeRunner(args, scenarioData);

  const engine = new WorkflowEngine({
    workflow,
    runner,
    autoApprove: true,
    initialContext: previousContext ?? {},
    gateOptions: { workflowDir },
    snapshotDir: runDir,
    onEvent: (e) => events.push(e),
  });

  const snap = await withTimeout(engine.run(), args.timeoutPerTicket, ticketId);

  // Persist events for this run
  writeFileSync(
    join(runDir, "events.json"),
    JSON.stringify(events, null, 2) + "\n",
  );

  // Sum token usage
  const tokens = events
    .filter(
      (e): e is Extract<WorkflowEvent, { type: "phase_complete" }> =>
        e.type === "phase_complete",
    )
    .reduce((sum, e) => sum + (e.usage?.totalTokens ?? 0), 0);

  return { snap, tokens, runDir };
}

// ─── Report writer ───────────────────────────────────────────────────────────

export function writeReport(
  batchDir: string,
  results: TicketResult[],
  halted: boolean,
  haltReason?: string,
): void {
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const completedCount = results.filter((r) => r.state === "completed").length;

  const rows = results.map(
    (r) =>
      `| ${r.ticketId} | ${r.iterations} | ${r.state} | ${r.totalTokens} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.notes} |`,
  );

  const lines = [
    `# Batch Run Report`,
    `**Date**: ${new Date().toISOString()}`,
    `**Completed**: ${completedCount}/${results.length}`,
    `**Total tokens**: ${totalTokens}`,
    `**Total duration**: ${(totalMs / 1000).toFixed(1)}s`,
    halted ? `**Status**: ⛔ HALTED — circuit breaker triggered` : "",
    "",
    "## Ticket Results",
    "| Ticket | Iterations | State | Tokens | Duration | Notes |",
    "| ------ | ---------- | ----- | ------ | -------- | ----- |",
    ...rows,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  writeFileSync(join(batchDir, "report.md"), lines + "\n");

  if (halted && haltReason) {
    writeFileSync(
      join(batchDir, "HALTED.md"),
      [
        `# HALTED`,
        `**Reason**: ${haltReason}`,
        `**Date**: ${new Date().toISOString()}`,
        "",
        "## Remaining tickets",
        "The following tickets were not processed:",
        "",
        ...results
          .filter((r) => r.state === "pending")
          .map((r) => `- ${r.ticketId}`),
      ].join("\n") + "\n",
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.tickets.length === 0) {
    console.error("No tickets specified. Use --tickets or --tickets-file.");
    process.exit(1);
  }

  const workflowPath = args.workflow ?? join(SDK_ROOT, "examples", "example-workflow.yaml");
  const scenarioData =
    args.mock || args.runner === "mock"
      ? loadMockScenario(args.scenario)
      : undefined;

  const datestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = join(SDK_ROOT, "runs", `batch-${datestamp}`);
  mkdirSync(batchDir, { recursive: true });

  console.log(`\nBatch runner — ${args.tickets.length} ticket(s)`);
  console.log(
    `Runner: ${args.runner}${args.dryRun ? " [DRY-RUN]" : ""}  Iterations: ${args.maxIterations}  Circuit-breaker: ${args.circuitBreaker}\n`,
  );

  // Initialize all tickets as "pending" for the HALTED report
  const results: TicketResult[] = args.tickets.map((ticketId) => ({
    ticketId,
    iterations: 0,
    state: "pending",
    totalTokens: 0,
    durationMs: 0,
    notes: "",
  }));

  let consecutiveFailures = 0;
  let circuitBreakerTriggered = false;
  let processedCount = 0;

  for (let idx = 0; idx < args.tickets.length; idx++) {
    const ticketId = args.tickets[idx];
    const result = results[idx];

    // Check circuit breaker before processing each ticket
    if (consecutiveFailures >= args.circuitBreaker) {
      circuitBreakerTriggered = true;
      const haltReason = `${consecutiveFailures} consecutive failures`;
      console.log(`\n⛔ Circuit breaker triggered: ${haltReason}`);
      writeReport(batchDir, results, true, haltReason);
      process.exit(2);
    }

    console.log(`\n[${idx + 1}/${args.tickets.length}] ${ticketId}`);

    let lastContext: Record<string, unknown> | undefined = undefined;
    let totalTokensForTicket = 0;
    let ticketState = "error";
    let ticketNotes = "";
    const ticketStart = Date.now();

    for (let iter = 0; iter < args.maxIterations; iter++) {
      if (args.maxIterations > 1) {
        console.log(`  Iteration ${iter + 1}/${args.maxIterations}`);
      }
      try {
        const { snap, tokens, runDir } = await runTicket(
          ticketId,
          iter,
          args,
          workflowPath,
          batchDir,
          lastContext,
          scenarioData,
        );

        totalTokensForTicket += tokens;
        ticketState = snap.state;
        // Feed context forward for Ralph loop
        lastContext = snap.context;

        const icon =
          snap.state === "completed"
            ? "✓"
            : snap.state === "blocked"
              ? "⛔"
              : "✗";
        console.log(
          `  ${icon} iter=${iter + 1} state=${snap.state} tokens=${tokens} dir=${runDir}`,
        );

        if (snap.state !== "completed") {
          ticketNotes = `iter ${iter + 1} state=${snap.state}`;
          if (snap.error) ticketNotes += `: ${snap.error}`;
          if (snap.blockedGate)
            ticketNotes += `: gate ${snap.blockedGate.gateId}`;
          break; // Stop iterating on failure
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ✗ iter=${iter + 1} error: ${msg}`);
        ticketState = msg.startsWith("Timeout") ? "timeout" : "error";
        ticketNotes = msg;
        break;
      }
    }

    const durationMs = Date.now() - ticketStart;
    result.iterations = args.maxIterations;
    result.state = ticketState;
    result.totalTokens = totalTokensForTicket;
    result.durationMs = durationMs;
    result.notes = ticketNotes;
    processedCount++;

    if (ticketState === "completed") {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }
  }

  // Write final report
  writeReport(batchDir, results, circuitBreakerTriggered);
  console.log(`\nReport: ${join(batchDir, "report.md")}`);

  const allCompleted = results.every((r) => r.state === "completed");
  const anyFailed = results.some(
    (r) => r.state !== "completed" && r.state !== "pending",
  );

  if (allCompleted) {
    process.exit(0);
  } else if (anyFailed) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Only execute main when run directly (not when imported by tests)
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").slice(-1)[0],
  );

if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

export { main };
