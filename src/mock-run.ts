/**
 * mock-run — Execute a workflow scenario with mock data and write all artifacts to runs/.
 *
 * Usage:
 *   npx tsx src/mock-run.ts                          # defaults to "story"
 *   npx tsx src/mock-run.ts --scenario analysis
 *   npx tsx src/mock-run.ts --scenario bug
 *   npm run mock-run                                 # story
 *   npm run mock-run -- --scenario bug
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadWorkflow } from "./workflow/WorkflowLoader.js";
import { WorkflowEngine } from "./workflow/WorkflowEngine.js";
import { MockAgentRunner } from "./agent/MockAgentRunner.js";
import type { WorkflowEvent } from "./agent/AgentRunner.js";
import type { Context } from "./context/ContextStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── Parse args ─────────────────────────────────────────────────────────────

function parseArgs(): { scenario: string } {
  const args = process.argv.slice(2);
  let scenario = "story";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      scenario = args[i + 1];
    }
  }
  return { scenario };
}

// ─── Load mock data ─────────────────────────────────────────────────────────

interface MockScenario {
  description: string;
  phases: Record<string, Record<string, unknown>>;
}

function loadMockData(scenario: string): MockScenario {
  const mockPath = join(ROOT, "examples", "peon-mock-data.yaml");
  const raw = readFileSync(mockPath, "utf-8");
  const parsed = yaml.load(raw) as {
    scenarios: Record<string, MockScenario>;
  };
  const s = parsed.scenarios[scenario];
  if (!s) {
    const available = Object.keys(parsed.scenarios).join(", ");
    console.error(
      `❌ Unknown scenario: "${scenario}". Available: ${available}`,
    );
    process.exit(1);
  }
  return s;
}

// ─── Write helpers ──────────────────────────────────────────────────────────

function writeJson(dir: string, filename: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeText(dir: string, filename: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), text + "\n", "utf-8");
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
    case "phase_start":
      return `${CYAN}▶${RESET} ${BOLD}${e.phaseId}${RESET} ${DIM}(${e.label})${RESET}`;
    case "phase_complete":
      return `${GREEN}✓${RESET} ${e.phaseId} ${DIM}→ outputs: [${e.outputKeys.join(", ")}]${RESET}`;
    case "gate_blocked":
      return `${RED}⛔ BLOCKED${RESET} ${e.phaseId} — gate ${e.gate.gateId}: ${e.gate.reason ?? "missing inputs"}`;
    case "gate_advisory":
      return `${YELLOW}⚠${RESET}  ${e.phaseId} — advisory: ${e.gate.gateId}`;
    case "approval_required":
      return `${YELLOW}⏸ APPROVAL${RESET} ${e.phaseId} — ${e.message} ${DIM}(auto-approved)${RESET}`;
    case "routing_fork":
      return `${CYAN}⑂ FORK${RESET} → [${e.targets.join(", ")}] ${DIM}(${e.condition})${RESET}${e.stopAfterFork ? ` ${RED}[STOP]${RESET}` : ""}`;
    case "workflow_complete":
      return `${GREEN}${BOLD}✅ COMPLETE${RESET} — phases: [${e.history.join(" → ")}]`;
    case "workflow_error":
      return `${RED}${BOLD}❌ ERROR${RESET} at ${e.phaseId}: ${e.error}`;
    default:
      return `  ${(e as WorkflowEvent).type}`;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { scenario } = parseArgs();
  const mockData = loadMockData(scenario);
  const workflow = loadWorkflow(join(ROOT, "examples", "peon-workflow.yaml"));

  // ── Build run output directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(ROOT, "runs", `${scenario}-${timestamp}`);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "phases"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });

  console.log(
    `\n${BOLD}Workflow Mock Run${RESET} — scenario: ${CYAN}${scenario}${RESET}`,
  );
  console.log(`${DIM}${mockData.description}${RESET}`);
  console.log(`${DIM}Output: ${runDir}${RESET}\n`);

  // ── Configure MockAgentRunner from scenario data
  const runner = new MockAgentRunner();
  for (const [phaseId, outputs] of Object.entries(mockData.phases)) {
    runner.setPhaseOutput(phaseId, outputs);
  }

  // ── Collect events for file output
  const allEvents: WorkflowEvent[] = [];
  const phaseArtifacts: Record<
    string,
    { outputs: Partial<Context>; gateResults: unknown[] }
  > = {};

  function onEvent(event: WorkflowEvent): void {
    allEvents.push(event);
    console.log(`  ${fmtEvent(event)}`);
  }

  // ── Run the engine (auto-approve all user_approval gates)
  const engine = new WorkflowEngine({
    workflow,
    runner,
    onEvent,
    autoApprove: true,
  });

  let snap = await engine.run();

  // If somehow paused (shouldn't with autoApprove), keep approving
  while (snap.state === "paused") {
    snap = await engine.approve();
  }

  console.log("");

  // ── Write per-phase artifacts
  for (const phaseId of snap.history) {
    const phaseDir = join(runDir, "phases", phaseId);
    mkdirSync(phaseDir, { recursive: true });

    // Write the mock outputs this phase produced
    const phaseOutputs = mockData.phases[phaseId];
    if (phaseOutputs) {
      writeJson(phaseDir, "outputs.json", phaseOutputs);
    }

    // Write gate results for this phase (from events)
    const gateEvents = allEvents.filter(
      (e) =>
        (e.type === "gate_blocked" ||
          e.type === "gate_advisory" ||
          e.type === "approval_required") &&
        e.phaseId === phaseId,
    );
    if (gateEvents.length > 0) {
      writeJson(join(runDir, "gates"), `${phaseId}.json`, gateEvents);
    }
  }

  // ── Write accumulated context snapshot
  writeJson(runDir, "context-final.json", snap.context);

  // ── Write event log
  writeJson(runDir, "events.json", allEvents);

  // ── Write summary
  const summary = [
    `# Mock Run: ${scenario}`,
    ``,
    `**Date**: ${new Date().toISOString()}`,
    `**Description**: ${mockData.description}`,
    `**Final State**: ${snap.state}`,
    `**Phases Executed**: ${snap.history.length}`,
    `**Phase Order**: ${snap.history.join(" → ")}`,
    ``,
    `## Events`,
    ``,
    ...allEvents.map(
      (e) => `- \`${e.type}\` ${("phaseId" in e && e.phaseId) || ""}`,
    ),
    ``,
    `## Context Keys (final)`,
    ``,
    ...Object.keys(snap.context).map((k) => `- \`${k}\``),
    ``,
    `## Agent Calls`,
    ``,
    ...runner
      .getCalls()
      .map((c) => `- **${c.phaseId}** → agent \`${c.agentId}\``),
  ];

  if (snap.state === "blocked" && snap.blockedGate) {
    summary.push(
      ``,
      `## ⛔ Blocked`,
      ``,
      `- Phase: \`${snap.blockedGate.phaseId}\``,
      `- Gate: \`${snap.blockedGate.gateId}\``,
      `- Reason: ${snap.blockedGate.reason ?? "missing inputs"}`,
    );
  }

  writeText(runDir, "SUMMARY.md", summary.join("\n"));

  // ── Final console output
  const stateIcon =
    snap.state === "completed"
      ? `${GREEN}✅${RESET}`
      : snap.state === "blocked"
        ? `${RED}⛔${RESET}`
        : `${YELLOW}⚠${RESET}`;

  console.log(
    `${stateIcon} ${BOLD}${snap.state.toUpperCase()}${RESET} — ${snap.history.length} phases executed`,
  );
  console.log(`${DIM}Artifacts written to: ${runDir}${RESET}`);
  console.log(
    `${DIM}  context-final.json  events.json  SUMMARY.md  phases/  gates/${RESET}\n`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
