/**
 * MCP Server — exposes workflow engine as MCP tools.
 *
 * Tools:
 *   workflow_run      — start a workflow for a ticket (runs to completion / approval)
 *   workflow_step     — execute exactly one phase and pause; call repeatedly for phase-by-phase control
 *   workflow_status   — get current state of a running workflow
 *   workflow_approve  — approve a pending user_approval gate
 *   workflow_reject   — reject a pending approval
 *
 * Start: npx tsx src/mcp/server.ts
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "../workflow/WorkflowLoader.js";
import {
  WorkflowEngine,
  type WorkflowSnapshot,
} from "../workflow/WorkflowEngine.js";
import { OpenAiRunner } from "../agent/OpenAiRunner.js";
import { CopilotSdkRunner } from "../agent/CopilotSdkRunner.js";
import { ContextStore } from "../context/ContextStore.js";
import type { WorkflowEvent } from "../agent/AgentRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = join(__dirname, "..", "..");
// REPO_ROOT: the repo the runner operates on. Set WORKFLOW_REPO_ROOT env var or pass
// workflow_repo_root in tool input. Falls back to process.cwd() when neither is set.
const DEFAULT_REPO_ROOT = process.env.WORKFLOW_REPO_ROOT ?? process.cwd();

// ─── Engine registry (one per ticket) ──────────────────────────────────────

const engines = new Map<string, WorkflowEngine>();
const eventLogs = new Map<string, WorkflowEvent[]>();

/** Path to the active-run pointer file for a ticket. */
function activePointerPath(ticketId: string, repoRoot: string): string {
  return join(repoRoot, ".github", "tmp", `active-${ticketId}.json`);
}

/** Write the active pointer so MCP server can recover after restart. */
function writeActivePointer(ticketId: string, runDir: string, repoRoot: string): void {
  try {
    mkdirSync(join(repoRoot, ".github", "tmp"), { recursive: true });
    writeFileSync(
      activePointerPath(ticketId, repoRoot),
      JSON.stringify({ runDir, startedAt: new Date().toISOString() }, null, 2) +
        "\n",
    );
  } catch {
    // Best-effort
  }
}

/**
 * Load a snapshot from disk if an active pointer exists for this ticket.
 * Returns null if no pointer/snapshot found.
 */
function loadSnapshotFromPointer(ticketId: string, repoRoot: string): WorkflowSnapshot | null {
  const pointerFile = activePointerPath(ticketId, repoRoot);
  if (!existsSync(pointerFile)) return null;
  try {
    const pointer = JSON.parse(readFileSync(pointerFile, "utf-8")) as {
      runDir: string;
    };
    const snapshotFile = join(pointer.runDir, "snapshot.json");
    if (!existsSync(snapshotFile)) return null;
    return JSON.parse(readFileSync(snapshotFile, "utf-8")) as WorkflowSnapshot;
  } catch {
    return null;
  }
}

/** Key combining ticket + workflow path to allow concurrent runs of different workflows. */
function engineKey(ticketId: string, workflowPath: string): string {
  return `${ticketId}::${workflowPath}`;
}

function getOrCreateEngine(
  ticketId: string,
  dryRun: boolean,
  autoApprove: boolean,
  workflowPath?: string,
  runner: "copilot-sdk" | "openai" = "copilot-sdk",
  repoRoot: string = DEFAULT_REPO_ROOT,
): WorkflowEngine {
  const resolvedWorkflowPath = workflowPath ?? join(SDK_ROOT, "examples", "peon-workflow.yaml");
  const key = engineKey(ticketId, resolvedWorkflowPath);
  let engine = engines.get(key);
  if (engine) return engine;

  const workflow = loadWorkflow(resolvedWorkflowPath);
  const workflowDir = dirname(resolvedWorkflowPath);
  const tmpDir = join(repoRoot, ".github", "tmp");
  const store = new ContextStore(tmpDir);
  const events: WorkflowEvent[] = [];
  eventLogs.set(ticketId, events);

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(SDK_ROOT, "runs", `${ticketId}-${ts}`);
  mkdirSync(runDir, { recursive: true });

  const agentRunner =
    runner === "openai"
      ? new OpenAiRunner({ repoRoot, dryRun })
      : new CopilotSdkRunner({ repoRoot, dryRun });

  const engineOptions = {
    workflow,
    runner: agentRunner,
    autoApprove,
    gateOptions: { workflowDir },
    snapshotDir: runDir,
    onEvent: (e: WorkflowEvent) => events.push(e),
  };

  // Check for a snapshot from a previous MCP server session
  const existingSnapshot = loadSnapshotFromPointer(ticketId, repoRoot);
  if (existingSnapshot) {
    const restoredRunDir = JSON.parse(
      readFileSync(activePointerPath(ticketId, repoRoot), "utf-8"),
    ).runDir as string;
    engine = WorkflowEngine.restore(existingSnapshot, {
      ...engineOptions,
      snapshotDir: restoredRunDir,
      initialContext: existingSnapshot.context,
    });
  } else {
    const initialContext = store.read(ticketId);
    engine = new WorkflowEngine({ ...engineOptions, initialContext });
    writeActivePointer(ticketId, runDir, repoRoot);
  }

  engines.set(key, engine);
  return engine;
}

// ─── MCP Server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: "workflow-engine", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "workflow_run",
      description:
        "Start a workflow for a Jira ticket. Returns snapshot when done, paused, or blocked.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "string",
            description: "Jira ticket ID (e.g. COPEE2-1234)",
          },
          workflow_path: {
            type: "string",
            description:
              "Absolute path to workflow.yaml. Defaults to the built-in peon workflow.",
          },
          runner: {
            type: "string",
            enum: ["copilot-sdk", "openai"],
            description: "Runner to use. Default: copilot-sdk.",
          },
          dry_run: {
            type: "boolean",
            description: "Skip LLM calls, just show phase transitions",
          },
          auto_approve: {
            type: "boolean",
            description: "Auto-approve all user_approval gates",
          },
          repo_root: {
            type: "string",
            description:
              "Absolute path to the repo the runner operates on. Overrides WORKFLOW_REPO_ROOT env var. Defaults to process.cwd().",
          },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "workflow_status",
      description: "Get current state of a workflow for a ticket.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: { type: "string", description: "Jira ticket ID" },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "workflow_step",
      description:
        "Execute exactly one phase of a workflow, then pause. Call repeatedly to advance phase by phase. Creates the engine on first call (same params as workflow_run).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: {
            type: "string",
            description: "Jira ticket ID (e.g. COPEE2-1234)",
          },
          workflow_path: {
            type: "string",
            description:
              "Absolute path to workflow.yaml. Defaults to the built-in peon workflow.",
          },
          runner: {
            type: "string",
            enum: ["copilot-sdk", "openai"],
            description: "Runner to use. Default: copilot-sdk.",
          },
          dry_run: {
            type: "boolean",
            description: "Skip LLM calls, just show phase transitions",
          },
          repo_root: {
            type: "string",
            description:
              "Absolute path to the repo the runner operates on. Overrides WORKFLOW_REPO_ROOT env var.",
          },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "workflow_approve",
      description:
        "Approve the pending user_approval gate and resume workflow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: { type: "string", description: "Jira ticket ID" },
        },
        required: ["ticket_id"],
      },
    },
    {
      name: "workflow_reject",
      description: "Reject the pending approval and stop the workflow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: { type: "string", description: "Jira ticket ID" },
          reason: { type: "string", description: "Rejection reason" },
        },
        required: ["ticket_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const ticketId = (args as Record<string, unknown>).ticket_id as string;

  try {
    switch (name) {
      case "workflow_run": {
        const dryRun = (args as Record<string, unknown>).dry_run === true;
        const autoApprove =
          (args as Record<string, unknown>).auto_approve === true;
        const workflowPath = (args as Record<string, unknown>).workflow_path as
          | string
          | undefined;
        const runnerType =
          ((args as Record<string, unknown>).runner as
            | "copilot-sdk"
            | "openai"
            | undefined) ?? "copilot-sdk";
        const repoRoot =
          ((args as Record<string, unknown>).repo_root as string | undefined) ??
          DEFAULT_REPO_ROOT;
        const engine = getOrCreateEngine(
          ticketId,
          dryRun,
          autoApprove,
          workflowPath,
          runnerType,
          repoRoot,
        );
        const snap = await engine.run();
        return {
          content: [{ type: "text", text: formatSnapshot(ticketId, snap) }],
        };
      }
      case "workflow_step": {
        const dryRun = (args as Record<string, unknown>).dry_run === true;
        const workflowPath = (args as Record<string, unknown>).workflow_path as
          | string
          | undefined;
        const runnerType =
          ((args as Record<string, unknown>).runner as
            | "copilot-sdk"
            | "openai"
            | undefined) ?? "copilot-sdk";
        const repoRoot =
          ((args as Record<string, unknown>).repo_root as string | undefined) ??
          DEFAULT_REPO_ROOT;
        const engine = getOrCreateEngine(
          ticketId,
          dryRun,
          false /* autoApprove — user controls phase-by-phase */,
          workflowPath,
          runnerType,
          repoRoot,
        );
        const snap = await engine.step();
        return {
          content: [{ type: "text", text: formatSnapshot(ticketId, snap) }],
        };
      }
      case "workflow_status": {
        const engine = engines.get(ticketId);
        if (!engine) {
          return {
            content: [
              { type: "text", text: `No active workflow for ${ticketId}` },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: formatSnapshot(ticketId, engine.snapshot()) },
          ],
        };
      }
      case "workflow_approve": {
        const engine = engines.get(ticketId);
        if (!engine) {
          return {
            content: [
              { type: "text", text: `No active workflow for ${ticketId}` },
            ],
          };
        }
        const snap = await engine.approve();
        return {
          content: [{ type: "text", text: formatSnapshot(ticketId, snap) }],
        };
      }
      case "workflow_reject": {
        const engine = engines.get(ticketId);
        if (!engine) {
          return {
            content: [
              { type: "text", text: `No active workflow for ${ticketId}` },
            ],
          };
        }
        const reason = (args as Record<string, unknown>).reason as
          | string
          | undefined;
        const snap = await engine.reject(reason);
        return {
          content: [{ type: "text", text: formatSnapshot(ticketId, snap) }],
        };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

function formatSnapshot(ticketId: string, snap: WorkflowSnapshot): string {
  const lines = [
    `## Workflow: ${ticketId}`,
    `**State**: ${snap.state}`,
    `**History**: ${snap.history.join(" → ") || "(none)"}`,
    `**Context keys**: ${Object.keys(snap.context).join(", ") || "(empty)"}`,
  ];
  if (snap.pendingApproval) {
    lines.push(
      `**Pending approval**: ${snap.pendingApproval.message} (gate: ${snap.pendingApproval.gateId})`,
    );
  }
  if (snap.blockedGate) {
    lines.push(
      `**Blocked**: ${snap.blockedGate.gateId} at ${snap.blockedGate.phaseId} — ${snap.blockedGate.reason ?? "missing inputs"}`,
    );
  }
  if (snap.error) {
    lines.push(`**Error**: ${snap.error}`);
  }
  return lines.join("\n");
}

// ─── Start ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
