/**
 * WorkflowEngine — generic YAML-driven state machine.
 *
 * Walks the phase graph defined in workflow.yaml, executing agents via AgentRunner.
 * Supports routing forks, gate checks, user-approval pauses, and auto-approve mode.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDef, PhaseDef } from "../types/workflow.js";
import type { Context } from "../context/ContextStore.js";
import type {
  AgentRunner,
  TokenUsage,
  WorkflowEvent,
  WorkflowEventHandler,
} from "../agent/AgentRunner.js";
import type { GateRunnerOptions } from "../gates/GateRunner.js";
import { buildPhaseMap } from "./WorkflowLoader.js";
import { evaluateRouting } from "./routing.js";
import { executePhase } from "./PhaseExecutor.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type EngineState =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "blocked"
  | "error";

export interface WorkflowSnapshot {
  state: EngineState;
  currentPhase: string | null;
  history: string[];
  context: Context;
  /** Phases still pending execution — needed for full engine reconstruction. */
  phaseQueue: string[];
  /** IDs of phases that have already been executed — prevents re-runs on restore. */
  executed: string[];
  /** Indices of routing rules that have already fired. */
  routingFired: number[];
  pendingApproval?: { phaseId: string; gateId: string; message: string };
  blockedGate?: { phaseId: string; gateId: string; reason?: string };
  error?: string;
}

export interface WorkflowEngineOptions {
  workflow: WorkflowDef;
  runner: AgentRunner;
  onEvent?: WorkflowEventHandler;
  /** Gate options passed to every phase (prompt, isAutopilot). */
  gateOptions?: GateRunnerOptions;
  /** Skip user_approval pauses (auto-approve). Useful for fully automated runs. */
  autoApprove?: boolean;
  /** Initial context (e.g. pre-loaded from ContextStore). */
  initialContext?: Context;
  /**
   * Directory to write snapshot.json after every phase transition.
   * Enables persistence and MCP server restart recovery.
   */
  snapshotDir?: string;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private readonly workflow: WorkflowDef;
  private readonly phaseMap: Map<string, PhaseDef>;
  private readonly runner: AgentRunner;
  private readonly emit: WorkflowEventHandler;
  private readonly gateOptions: GateRunnerOptions;
  private readonly autoApprove: boolean;
  private readonly snapshotDir: string | undefined;

  private state: EngineState = "idle";
  private context: Context;
  private history: string[] = [];
  private phaseQueue: string[] = [];
  private routingFired = new Set<number>();
  private executed = new Set<string>();
  private pendingApproval: {
    phaseId: string;
    gateId: string;
    message: string;
  } | null = null;

  constructor(options: WorkflowEngineOptions) {
    this.workflow = options.workflow;
    this.phaseMap = buildPhaseMap(options.workflow);
    this.runner = options.runner;
    this.emit = options.onEvent ?? (() => {});
    this.gateOptions = options.gateOptions ?? {};
    this.autoApprove = options.autoApprove ?? false;
    this.snapshotDir = options.snapshotDir;
    this.context = { ...(options.initialContext ?? {}) };
  }

  /**
   * Restore a WorkflowEngine from a previously serialized snapshot.
   * The returned engine is in the same state as when the snapshot was taken.
   * If state was `running`, call `resume()` to continue execution.
   */
  static restore(
    snapshot: WorkflowSnapshot,
    options: WorkflowEngineOptions,
  ): WorkflowEngine {
    const engine = new WorkflowEngine({
      ...options,
      initialContext: snapshot.context,
    });
    engine.state = snapshot.state;
    engine.history = [...snapshot.history];
    engine.phaseQueue = [...snapshot.phaseQueue];
    engine.executed = new Set(snapshot.executed);
    engine.routingFired = new Set(snapshot.routingFired);
    if (snapshot.pendingApproval) {
      engine.pendingApproval = { ...snapshot.pendingApproval };
    }
    return engine;
  }

  /**
   * Resume a restored engine that was in `running` state when snapshotted.
   * Continues executing from the current phase queue.
   */
  async resume(): Promise<WorkflowSnapshot> {
    if (this.state !== "running") {
      throw new Error(`Cannot resume: engine is in '${this.state}' state`);
    }
    return this.loop();
  }

  /** Current engine snapshot (full serializable state for persistence). */
  snapshot(): WorkflowSnapshot {
    const snap: WorkflowSnapshot = {
      state: this.state,
      currentPhase: this.phaseQueue[0] ?? null,
      history: [...this.history],
      context: { ...this.context },
      phaseQueue: [...this.phaseQueue],
      executed: [...this.executed],
      routingFired: [...this.routingFired],
    };
    if (this.pendingApproval) {
      snap.pendingApproval = { ...this.pendingApproval };
    }
    return snap;
  }

  /** Write snapshot.json to snapshotDir (best-effort — never crashes workflow). */
  private persistSnapshot(): void {
    if (!this.snapshotDir) return;
    try {
      mkdirSync(this.snapshotDir, { recursive: true });
      writeFileSync(
        join(this.snapshotDir, "snapshot.json"),
        JSON.stringify(this.snapshot(), null, 2) + "\n",
      );
    } catch {
      // Persistence failure must not crash the workflow
    }
  }

  /**
   * Start the workflow from the first phase.
   * Returns when the workflow completes, pauses for approval, or errors.
   */
  async run(): Promise<WorkflowSnapshot> {
    if (this.state !== "idle") {
      throw new Error(`Cannot run: engine is in '${this.state}' state`);
    }

    const firstPhase = this.workflow.phases[0];
    if (!firstPhase) {
      this.state = "completed";
      this.emit({
        type: "workflow_complete",
        finalPhaseId: "",
        history: [],
      });
      return this.snapshot();
    }

    this.state = "running";
    this.phaseQueue = [firstPhase.id];
    return this.loop();
  }

  /**
   * Execute exactly one phase from the queue, then return.
   *
   * - If state is `idle`, initialises the queue from the first phase.
   * - If state is `running`, advances by one phase.
   * - After the phase: state stays `running` if more phases remain,
   *   transitions to `completed` if the queue is drained.
   * - Blocked/paused states work the same as in `run()`.
   *
   * Use this for phase-by-phase MCP interaction instead of `run()`.
   */
  async step(): Promise<WorkflowSnapshot> {
    if (this.state === "idle") {
      const firstPhase = this.workflow.phases[0];
      if (!firstPhase) {
        this.state = "completed";
        this.emit({ type: "workflow_complete", finalPhaseId: "", history: [] });
        return this.snapshot();
      }
      this.state = "running";
      this.phaseQueue = [firstPhase.id];
    }

    if (this.state !== "running") {
      throw new Error(`Cannot step: engine is in '${this.state}' state`);
    }

    // Skip already-executed phases at the head of the queue
    while (
      this.phaseQueue.length > 0 &&
      this.executed.has(this.phaseQueue[0])
    ) {
      this.phaseQueue.shift();
    }

    if (this.phaseQueue.length === 0) {
      const finalPhase = this.history[this.history.length - 1] ?? "";
      this.state = "completed";
      this.emit({
        type: "workflow_complete",
        finalPhaseId: finalPhase,
        history: [...this.history],
      });
      this.persistSnapshot();
      return this.snapshot();
    }

    const phaseId = this.phaseQueue.shift()!;
    const phase = this.phaseMap.get(phaseId);
    if (!phase) {
      this.state = "error";
      const msg = `Unknown phase: ${phaseId}`;
      this.emit({ type: "workflow_error", phaseId, error: msg });
      return { ...this.snapshot(), error: msg };
    }

    this.emit({
      type: "phase_start",
      phaseId,
      label: phase.label,
      model: phase.model,
    });

    const result = await executePhase(
      phase,
      this.context,
      this.runner,
      this.gateOptions,
      this.emit,
    );

    if (result.blocked) {
      this.state = "blocked";
      this.emit({ type: "gate_blocked", phaseId, gate: result.blocked });
      this.persistSnapshot();
      return {
        ...this.snapshot(),
        blockedGate: {
          phaseId,
          gateId: result.blocked.gateId,
          reason: result.blocked.reason,
        },
      };
    }

    for (const gr of result.gateResults) {
      if (gr.ok) {
        this.emit({ type: "gate_passed", phaseId, gate: gr });
      } else {
        this.emit({ type: "gate_advisory", phaseId, gate: gr });
      }
    }

    this.context = { ...this.context, ...result.outputs };
    this.finishPhase(
      phase,
      Object.keys(result.outputs),
      result.model,
      result.usage,
    );

    if (result.approval && !this.autoApprove) {
      this.state = "paused";
      this.pendingApproval = { phaseId, ...result.approval };
      this.emit({
        type: "approval_required",
        phaseId,
        gateId: result.approval.gateId,
        message: result.approval.message,
      });
      this.persistSnapshot();
      return this.snapshot();
    }

    // Queue drained after this phase → complete
    if (this.phaseQueue.length === 0) {
      const finalPhase = this.history[this.history.length - 1] ?? "";
      this.state = "completed";
      this.emit({
        type: "workflow_complete",
        finalPhaseId: finalPhase,
        history: [...this.history],
      });
    }

    this.persistSnapshot();
    return this.snapshot();
  }

  /** Approve the pending user_approval gate and resume execution. */
  async approve(): Promise<WorkflowSnapshot> {
    if (this.state !== "paused" || !this.pendingApproval) {
      throw new Error(`Cannot approve: engine is in '${this.state}' state`);
    }
    this.pendingApproval = null;
    this.state = "running";
    return this.loop();
  }

  /** Reject the pending approval and put the engine in error state. */
  async reject(reason?: string): Promise<WorkflowSnapshot> {
    if (this.state !== "paused" || !this.pendingApproval) {
      throw new Error(`Cannot reject: engine is in '${this.state}' state`);
    }
    const phaseId = this.pendingApproval.phaseId;
    this.pendingApproval = null;
    this.state = "error";
    const msg = reason ?? "User rejected approval";
    this.emit({ type: "workflow_error", phaseId, error: msg });
    return { ...this.snapshot(), error: msg };
  }

  // ─── Internal loop ──────────────────────────────────────────────────────

  private async loop(): Promise<WorkflowSnapshot> {
    while (this.phaseQueue.length > 0) {
      const phaseId = this.phaseQueue.shift()!;
      if (this.executed.has(phaseId)) continue;

      const phase = this.phaseMap.get(phaseId);
      if (!phase) {
        this.state = "error";
        const msg = `Unknown phase: ${phaseId}`;
        this.emit({ type: "workflow_error", phaseId, error: msg });
        return { ...this.snapshot(), error: msg };
      }

      this.emit({
        type: "phase_start",
        phaseId,
        label: phase.label,
        model: phase.model,
      });

      // Execute the phase (gates + agent)
      const result = await executePhase(
        phase,
        this.context,
        this.runner,
        this.gateOptions,
        this.emit,
      );

      // ── Blocked by gate ─────────────────────────────────────────────
      if (result.blocked) {
        this.state = "blocked";
        this.emit({ type: "gate_blocked", phaseId, gate: result.blocked });
        this.persistSnapshot();
        return {
          ...this.snapshot(),
          blockedGate: {
            phaseId,
            gateId: result.blocked.gateId,
            reason: result.blocked.reason,
          },
        };
      }

      // ── Collect advisory warnings ───────────────────────────────────
      for (const gr of result.gateResults) {
        if (gr.ok) {
          this.emit({ type: "gate_passed", phaseId, gate: gr });
        } else {
          this.emit({ type: "gate_advisory", phaseId, gate: gr });
        }
      }

      // ── Merge outputs (agent already ran, even if approval pending) ─
      this.context = { ...this.context, ...result.outputs };
      this.finishPhase(
        phase,
        Object.keys(result.outputs),
        result.model,
        result.usage,
      );

      // ── Approval required → pause ───────────────────────────────────
      if (result.approval && !this.autoApprove) {
        this.state = "paused";
        this.pendingApproval = { phaseId, ...result.approval };
        this.emit({
          type: "approval_required",
          phaseId,
          gateId: result.approval.gateId,
          message: result.approval.message,
        });
        this.persistSnapshot();
        return this.snapshot();
      }
    }

    // Queue empty — workflow complete
    const finalPhase = this.history[this.history.length - 1] ?? "";
    this.state = "completed";
    this.emit({
      type: "workflow_complete",
      finalPhaseId: finalPhase,
      history: [...this.history],
    });
    this.persistSnapshot();
    return this.snapshot();
  }

  /**
   * Mark a phase as done, queue its successors, and evaluate routing.
   */
  private finishPhase(
    phase: PhaseDef,
    outputKeys: string[],
    model?: string,
    usage?: TokenUsage,
  ): void {
    this.history.push(phase.id);
    this.executed.add(phase.id);
    // Persist BEFORE emitting so snapshot is on disk when onEvent fires
    this.persistSnapshot();
    this.emit({
      type: "phase_complete",
      phaseId: phase.id,
      outputKeys,
      model,
      usage,
    });

    // Terminal phase — don't queue anything further
    if (phase.terminal) return;

    // Evaluate routing conditions (only after the designated checkpoint phase)
    const routingAfter = this.workflow.meta.routing_after;
    if (routingAfter && phase.id !== routingAfter) {
      // Not at the routing checkpoint yet — follow default next
      if (
        phase.next &&
        !this.executed.has(phase.next) &&
        !this.phaseQueue.includes(phase.next)
      ) {
        this.phaseQueue.push(phase.next);
      }
      return;
    }

    const routing = evaluateRouting(
      this.workflow.routing,
      this.context,
      this.routingFired,
    );
    if (routing) {
      this.routingFired.add(routing.index);
      this.emit({
        type: "routing_fork",
        condition: this.workflow.routing[routing.index].condition,
        targets: routing.fork,
        stopAfterFork: routing.stopAfterFork,
      });
      // Replace queue with fork targets (skip already-executed ones)
      this.phaseQueue = routing.fork.filter((id) => !this.executed.has(id));
      return;
    }

    // Default: follow the phase's next pointer
    if (
      phase.next &&
      !this.executed.has(phase.next) &&
      !this.phaseQueue.includes(phase.next)
    ) {
      this.phaseQueue.push(phase.next);
    }
  }
}
