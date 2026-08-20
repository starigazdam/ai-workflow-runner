/**
 * main.ts — CLI entry point for the workflow engine.
 *
 * Usage:
 *   npx tsx src/main.ts --ticket PROJ-1234                        # real run (copilot-sdk runner, default)
 *   npx tsx src/main.ts --ticket PROJ-1234 --runner openai          # raw /chat/completions fallback
 *   npx tsx src/main.ts --ticket PROJ-1234 --runner anthropic       # Anthropic API fallback
 *   npx tsx src/main.ts --ticket PROJ-1234 --runner claude-sdk      # Claude Agent SDK (agentic, file/bash tools)
 *   npx tsx src/main.ts --ticket PROJ-1234 --dry-run                # show what would happen
 *   npx tsx src/main.ts --ticket PROJ-1234 --auto-approve           # skip approval pauses
 *   npx tsx src/main.ts --mock --scenario story                       # mock run
 *
 * --repo-root <path>   Root of the repo the runner operates on.
 *                      Defaults to WORKFLOW_REPO_ROOT env var, then process.cwd().
 *                      The runner stores context in <repo-root>/.github/tmp/ and reads
 *                      agent .md files from <repo-root>/.github/agents/.
 *
 * --workflow <path>    Path to workflow.yaml. Defaults to examples/example-workflow.yaml.
 *
 * BYOK via copilot-sdk runner:
 *   --provider-type openai|azure|anthropic
 *   --provider-url  https://api.openai.com/v1
 *   --provider-key  sk-...
 *
 * Env vars for OpenAI-compatible runner (fallback):
 *   LLM_BASE_URL=https://api.openai.com/v1
 *   LLM_API_KEY=sk-...
 *   LLM_MODEL=gpt-4o
 *
 * Env vars for Anthropic runner (fallback):
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   LLM_MODEL=claude-sonnet-4-5
 *
 * Env vars for Claude Agent SDK runner:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   LLM_MODEL=claude-sonnet-4-5
 *
 * Env vars:
 *   WORKFLOW_REPO_ROOT  — fallback repo root when --repo-root is not supplied
 */
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadWorkflow } from "./workflow/WorkflowLoader.js";
import { WorkflowEngine } from "./workflow/WorkflowEngine.js";
import { CopilotSdkRunner } from "./agent/CopilotSdkRunner.js";
import { OpenAiRunner } from "./agent/OpenAiRunner.js";
import { AnthropicRunner } from "./agent/AnthropicRunner.js";
import { ClaudeSdkRunner } from "./agent/ClaudeSdkRunner.js";
import { MockAgentRunner } from "./agent/MockAgentRunner.js";
import { ContextStore } from "./context/ContextStore.js";
import { calculateCost, formatCost } from "./agent/pricing.js";
import type { WorkflowEvent } from "./agent/AgentRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = join(__dirname, "..");

// ─── Args ───────────────────────────────────────────────────────────────────

type RunnerType = "copilot-sdk" | "openai" | "anthropic" | "claude-sdk" | "mock";

interface CliArgs {
  ticket?: string;
  workflow?: string;
  repoRoot?: string;
  dryRun: boolean;
  autoApprove: boolean;
  mock: boolean;
  scenario: string;
  runner: RunnerType;
  providerType?: "openai" | "azure" | "anthropic";
  providerUrl?: string;
  providerKey?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: CliArgs = {
    dryRun: false,
    autoApprove: false,
    mock: false,
    scenario: "story",
    runner: "copilot-sdk",
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--ticket":
        parsed.ticket = args[++i];
        break;
      case "--workflow":
        parsed.workflow = args[++i];
        break;
      case "--repo-root":
        parsed.repoRoot = args[++i];
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--auto-approve":
        parsed.autoApprove = true;
        break;
      case "--mock":
        parsed.mock = true;
        break;
      case "--scenario":
        parsed.scenario = args[++i];
        break;
      case "--provider-type": {
        const v = args[++i];
        if (v !== "openai" && v !== "azure" && v !== "anthropic") {
          console.error(
            `Unknown provider type: ${v}. Use openai|azure|anthropic`,
          );
          process.exit(1);
        }
        parsed.providerType = v;
        break;
      }
      case "--provider-url":
        parsed.providerUrl = args[++i];
        break;
      case "--provider-key":
        parsed.providerKey = args[++i];
        break;
      case "--runner": {
        const v = args[++i];
        if (
          v !== "copilot-sdk" &&
          v !== "openai" &&
          v !== "anthropic" &&
          v !== "claude-sdk" &&
          v !== "mock"
        ) {
          console.error(
            `Unknown runner: ${v}. Use copilot-sdk|openai|anthropic|claude-sdk|mock`,
          );
          process.exit(1);
        }
        parsed.runner = v;
        break;
      }
    }
  }
  // --mock flag also sets runner to mock for convenience
  if (parsed.mock) parsed.runner = "mock";
  return parsed;
}

// ─── Console formatting ────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

function fmtEvent(e: WorkflowEvent): string {
  switch (e.type) {
    case "phase_start": {
      const modelTag = e.model ? ` ${DIM}[${e.model}]${RESET}` : "";
      return `${CYAN}▶${RESET} ${BOLD}${e.phaseId}${RESET} ${DIM}(${e.label})${RESET}${modelTag}`;
    }
    case "phase_complete": {
      const mTag = e.model ? ` ${DIM}model=${e.model}${RESET}` : "";
      const uTag =
        e.usage && e.usage.totalTokens > 0
          ? ` ${DIM}[${e.usage.totalTokens} tokens]${RESET}`
          : "";
      return `${GREEN}✓${RESET} ${e.phaseId} ${DIM}→ [${e.outputKeys.join(", ")}]${RESET}${mTag}${uTag}`;
    }
    case "phase_retry":
      return `${YELLOW}↺${RESET}  ${e.phaseId} retry ${e.attempt}/${e.maxAttempts - 1} — ${e.gateFailure}`;
    case "gate_blocked":
      return `${RED}⛔${RESET} ${e.phaseId} — ${e.gate.gateId}: ${e.gate.reason ?? "blocked"}`;
    case "gate_passed": {
      const msg = e.gate.reason ? ` ${DIM}(${e.gate.reason})${RESET}` : "";
      return `${GREEN}✔${RESET}  ${DIM}gate${RESET} ${e.phaseId}/${e.gate.gateId}${msg}`;
    }
    case "gate_advisory":
      return `${YELLOW}⚠${RESET}  ${e.phaseId} — ${e.gate.gateId}`;
    case "approval_required":
      return `${YELLOW}⏸${RESET}  ${e.phaseId} — ${e.message}`;
    case "routing_fork":
      return `${CYAN}⑂${RESET}  → [${e.targets.join(", ")}]${e.stopAfterFork ? ` ${RED}[STOP]${RESET}` : ""}`;
    case "workflow_complete":
      return `${GREEN}${BOLD}✅ DONE${RESET} [${e.history.join(" → ")}]`;
    case "workflow_error":
      return `${RED}${BOLD}❌${RESET} ${e.phaseId}: ${e.error}`;
    case "assistant_delta":
      return ""; // handled inline via process.stdout.write
    default:
      return `  ${(e as WorkflowEvent).type}`;
  }
}

// ─── Output writer ─────────────────────────────────────────────────────────

function writeRun(
  runDir: string,
  events: WorkflowEvent[],
  context: Record<string, unknown>,
  history: string[],
  mode: string,
  usageNote?: string,
): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "context-final.json"),
    JSON.stringify(context, null, 2) + "\n",
  );
  writeFileSync(
    join(runDir, "events.json"),
    JSON.stringify(events, null, 2) + "\n",
  );
  // Build token usage audit from events
  const tokenUsageEvents = events.filter(
    (e): e is Extract<WorkflowEvent, { type: "phase_complete" }> =>
      e.type === "phase_complete",
  );
  const tokenRows = tokenUsageEvents.map((e) => {
    const u = e.usage;
    const prompt = u ? String(u.promptTokens) : "0";
    const completion = u ? String(u.completionTokens) : "0";
    const total = u ? String(u.totalTokens) : "0";
    return `| ${e.phaseId} | ${e.model ?? "—"} | ${prompt} | ${completion} | ${total} |`;
  });
  const totalPrompt = tokenUsageEvents.reduce(
    (s, e) => s + (e.usage?.promptTokens ?? 0),
    0,
  );
  const totalCompletion = tokenUsageEvents.reduce(
    (s, e) => s + (e.usage?.completionTokens ?? 0),
    0,
  );
  const totalAll = totalPrompt + totalCompletion;
  tokenRows.push(
    `| **Total** | | **${totalPrompt}** | **${totalCompletion}** | **${totalAll}** |`,
  );

  // Build cost breakdown from token events
  let totalCost = 0;
  const costRows = tokenUsageEvents.map((e) => {
    const cost = calculateCost(
      e.model,
      e.usage ?? { promptTokens: 0, completionTokens: 0 },
    );
    totalCost += cost;
    return `| ${e.phaseId} | ${e.model ?? "—"} | ${e.usage?.totalTokens ?? 0} | ${formatCost(cost)} |`;
  });
  costRows.push(
    `| **Total** | | **${totalAll}** | **${formatCost(totalCost)}** |`,
  );

  // Build model audit from events
  const modelAudit = events
    .filter(
      (e): e is Extract<WorkflowEvent, { type: "phase_complete" }> =>
        e.type === "phase_complete" && !!e.model,
    )
    .map((e) => `| ${e.phaseId} | ${e.model} |`);

  // Build gate audit from events
  const gateEvents = events.filter(
    (
      e,
    ): e is Extract<
      WorkflowEvent,
      { type: "gate_passed" | "gate_blocked" | "gate_advisory" }
    > =>
      e.type === "gate_passed" ||
      e.type === "gate_blocked" ||
      e.type === "gate_advisory",
  );
  const gateAudit = gateEvents.map((e) => {
    const status =
      e.type === "gate_passed" ? "✅" : e.type === "gate_blocked" ? "❌" : "⚠️";
    const reason = e.gate.reason ?? "";
    return `| ${e.phaseId} | ${e.gate.gateId} | ${status} | ${reason} |`;
  });

  writeFileSync(
    join(runDir, "SUMMARY.md"),
    [
      `# Run: ${mode}`,
      `**Date**: ${new Date().toISOString()}`,
      `**Phases**: ${history.join(" → ")}`,
      `**Context keys**: ${Object.keys(context).join(", ")}`,
      "",
      "## Token Usage",
      ...(usageNote ? [`> ⚠️ ${usageNote}`, ""] : []),
      "| Phase | Model | Prompt | Completion | Total |",
      "| ----- | ----- | ------ | ---------- | ----- |",
      ...tokenRows,
      "",
      "## Cost",
      ...(usageNote ? [`> ⚠️ ${usageNote}`, ""] : []),
      "| Phase | Model | Tokens | Cost ($) |",
      "| ----- | ----- | ------ | -------- |",
      ...costRows,
      "",
      "## Models Used",
      "| Phase | Model |",
      "| ----- | ----- |",
      ...modelAudit,
      "",
      "## Gate Results",
      "| Phase | Gate | Status | Detail |",
      "| ----- | ---- | ------ | ------ |",
      ...gateAudit,
    ].join("\n") + "\n",
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const workflowPath = args.workflow ?? join(SDK_ROOT, "examples", "example-workflow.yaml");
  const REPO_ROOT = args.repoRoot ?? process.env.WORKFLOW_REPO_ROOT ?? process.cwd();
  const workflowDir = dirname(workflowPath);
  const workflow = loadWorkflow(workflowPath);
  const events: WorkflowEvent[] = [];

  // ── Mock mode ──────────────────────────────────────────────────────────
  if (args.mock) {
    const mockPath = join(SDK_ROOT, "examples", "example-mock-data.yaml");
    const mockData = yaml.load(readFileSync(mockPath, "utf-8")) as {
      scenarios: Record<
        string,
        { description: string; phases: Record<string, Record<string, unknown>> }
      >;
    };
    const scenario = mockData.scenarios[args.scenario];
    if (!scenario) {
      console.error(`Unknown scenario: ${args.scenario}`);
      process.exit(1);
    }

    const runner = new MockAgentRunner();
    for (const [phaseId, outputs] of Object.entries(scenario.phases)) {
      runner.setPhaseOutput(phaseId, outputs);
    }

    console.log(`${BOLD}Mock run${RESET} — ${args.scenario}\n`);
    let mockLastWasDelta = false;
    const engine = new WorkflowEngine({
      workflow,
      runner,
      autoApprove: true,
      gateOptions: { workflowDir },
      onEvent: (e) => {
        events.push(e);
        if (e.type === "assistant_delta") {
          mockLastWasDelta = true;
          process.stdout.write(e.delta);
        } else {
          if (mockLastWasDelta) {
            process.stdout.write("\n");
            mockLastWasDelta = false;
          }
          console.log(`  ${fmtEvent(e)}`);
        }
      },
    });

    const snap = await engine.run();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    writeRun(
      join(SDK_ROOT, "runs", `${args.scenario}-${ts}`),
      events,
      snap.context,
      snap.history,
      `mock:${args.scenario}`,
    );
    process.exit(snap.state === "completed" ? 0 : 1);
  }

  // ── Real mode ──────────────────────────────────────────────────────────
  const tmpDir = join(REPO_ROOT, ".github", "tmp");
  const store = new ContextStore(tmpDir);

  const ticketId = args.ticket ?? store.nextAdHocId();
  if (!args.ticket) {
    console.log(
      `${DIM}No --ticket provided, using ${CYAN}${ticketId}${RESET}\n`,
    );
  }
  console.log(
    `\n${BOLD}Workflow Engine${RESET} — ticket: ${CYAN}${ticketId}${RESET}\n`,
  );

  // Load existing context if any
  const initialContext = store.read(ticketId);
  if (Object.keys(initialContext).length > 0) {
    console.log(
      `${DIM}Loaded existing context (${Object.keys(initialContext).length} keys)${RESET}\n`,
    );
  }

  const runnerTag = args.dryRun ? ` ${YELLOW}[DRY-RUN]${RESET}` : "";
  console.log(`${DIM}Runner: ${args.runner}${RESET}${runnerTag}\n`);

  // Pre-compute runDir so snapshotDir is available before run starts
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(SDK_ROOT, "runs", `${ticketId}-${ts}`);
  mkdirSync(join(runDir, "diffs"), { recursive: true });

  const logDryRun = (agentId: string) => {
    if (args.dryRun) {
      console.log(`  ${DIM}[dry-run] would call agent: ${agentId}${RESET}`);
    }
  };

  const runner =
    args.runner === "copilot-sdk"
      ? new CopilotSdkRunner({
          repoRoot: REPO_ROOT,
          dryRun: args.dryRun,
          provider: args.providerUrl
            ? {
                type: args.providerType,
                baseUrl: args.providerUrl,
                apiKey: args.providerKey,
              }
            : undefined,
          onAgentCall: (agentId) => logDryRun(agentId),
        })
      : args.runner === "anthropic"
        ? new AnthropicRunner({
            repoRoot: REPO_ROOT,
            dryRun: args.dryRun,
            onAgentCall: (agentId) => logDryRun(agentId),
          })
        : args.runner === "claude-sdk"
          ? new ClaudeSdkRunner({
              repoRoot: REPO_ROOT,
              dryRun: args.dryRun,
              onAgentCall: (agentId) => logDryRun(agentId),
            })
          : new OpenAiRunner({
              repoRoot: REPO_ROOT,
              dryRun: args.dryRun,
              onAgentCall: (agentId) => logDryRun(agentId),
            });

  let lastWasDelta = false;
  const engine = new WorkflowEngine({
    workflow,
    runner,
    autoApprove: args.autoApprove,
    initialContext,
    gateOptions: { workflowDir },
    snapshotDir: runDir,
    onEvent: (e) => {
      events.push(e);
      if (e.type === "assistant_delta") {
        lastWasDelta = true;
        process.stdout.write(e.delta);
      } else {
        if (lastWasDelta) {
          process.stdout.write("\n");
          lastWasDelta = false;
        }
        console.log(`  ${fmtEvent(e)}`);
        // Capture staged git diff after each phase completes (best-effort)
        if (e.type === "phase_complete" && !args.dryRun) {
          try {
            const diff = execSync("git diff --cached", {
              cwd: REPO_ROOT,
              encoding: "utf-8",
              timeout: 5000,
            });
            if (diff.trim()) {
              writeFileSync(join(runDir, "diffs", `${e.phaseId}.diff`), diff);
            }
          } catch {
            // Diff capture is best-effort — never fail the workflow
          }
        }
      }
    },
  });

  let snap = await engine.run();

  // Stop SDK client if used
  if (runner instanceof CopilotSdkRunner) {
    await runner.stop();
  }

  // Handle approval pauses interactively (for non-auto-approve mode)
  while (snap.state === "paused" && snap.pendingApproval) {
    const msg = snap.pendingApproval.message;
    console.log(`\n${YELLOW}⏸ Approval required:${RESET} ${msg}`);
    console.log(
      `${DIM}  Press Enter to approve, or type 'reject' to abort${RESET}`,
    );

    const answer = await readLine();
    if (answer.trim().toLowerCase() === "reject") {
      snap = await engine.reject("User rejected");
    } else {
      snap = await engine.approve();
    }
  }

  // Persist context
  if (Object.keys(snap.context).length > 0) {
    store.write(ticketId, snap.context);
    console.log(
      `\n${DIM}Context saved to ${tmpDir}/context-${ticketId}.json${RESET}`,
    );
  }

  // Write run artifacts (snapshot.json already written by engine; writeRun adds SUMMARY.md etc.)
  writeRun(
    runDir,
    events,
    snap.context,
    snap.history,
    ticketId,
    args.runner === "copilot-sdk"
      ? "Token usage not available: @github/copilot-sdk does not expose token counts. Tracked as future improvement (roadmap Stage 10)."
      : undefined,
  );
  console.log(`${DIM}Artifacts: ${runDir}${RESET}\n`);

  const code = snap.state === "completed" ? 0 : 1;
  process.exit(code);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString());
    });
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
