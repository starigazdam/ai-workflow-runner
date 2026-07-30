import { z } from "zod";

// --- Gate definition within a phase ---
// `check` is required for expression-based gates but optional for user_approval / wrap_up_gate kinds
export const GateDefSchema = z.object({
  id: z.string(),
  type: z.enum(["blocking", "advisory"]),
  kind: z.enum(["user_approval", "wrap_up_gate", "script"]).optional(),
  check: z.string().optional(),
  message: z.string(),
  remediation: z.string().optional(),
});
export type GateDef = z.infer<typeof GateDefSchema>;

// --- Output definition within a phase ---
export const OutputDefSchema = z.object({
  key: z.string(),
  schema: z.unknown().optional(), // schema is informational, not validated at runtime
});
export type OutputDef = z.infer<typeof OutputDefSchema>;

// --- Per-iteration block for looping phases ---
export const PerIterationSchema = z.object({
  input: z.string(),
  outputs: z.array(OutputDefSchema).optional(),
  gates: z.array(GateDefSchema).optional(),
});
export type PerIteration = z.infer<typeof PerIterationSchema>;

// --- Parallel agent spec (for bug-parallel style phases) ---
export const ParallelAgentSchema = z.object({
  agent: z.string(),
  outputs: z.array(z.string()).optional(),
});

// --- Routing condition (fork) ---
export const RoutingConditionSchema = z.object({
  condition: z.string(),
  fork: z.array(z.string()),
  stop_after_fork: z.boolean().optional(),
});
export type RoutingCondition = z.infer<typeof RoutingConditionSchema>;

// --- Phase definition ---
export const PhaseDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  agent: z.string().nullable(),
  model: z.string().optional(),
  retry_limit: z.number().int().min(0).optional(),
  required_inputs: z.array(z.string()),
  outputs: z.array(OutputDefSchema).default([]),
  optional_inputs: z.array(z.string()).optional(),
  gates: z.array(GateDefSchema).default([]),
  next: z.string().nullable().optional(), // null for terminal or parallel-consumed phases
  terminal: z.boolean().optional(),
  loop: z.boolean().optional(),
  per_iteration: PerIterationSchema.optional(),
  parallel_with: z.string().optional(),
});
export type PhaseDef = z.infer<typeof PhaseDefSchema>;

// --- Meta section ---
export const MetaSchema = z.object({
  version: z.string(),
  context_file: z.string(),
  audit_dir: z.string(),
  artifacts_schema: z.string(),
  routing_after: z.string().optional(), // phase id after which routing rules are evaluated
});
export type Meta = z.infer<typeof MetaSchema>;

// --- Cross-cutting hook definition ---
export const HookDefSchema = z.object({
  id: z.string(),
  description: z.string(),
  blocks: z.boolean(),
  source: z.string(),
  node_equivalent: z.string().nullable(),
});
export type HookDef = z.infer<typeof HookDefSchema>;

// --- Context schema entry ---
export const ContextSchemaEntrySchema = z.string(); // just the type name

// --- Top-level workflow definition ---
export const WorkflowDefSchema = z.object({
  meta: MetaSchema,
  routing: z.array(RoutingConditionSchema),
  phases: z.array(PhaseDefSchema),
  hooks: z.record(z.string(), z.array(HookDefSchema)).optional(),
  context_schema: z.record(z.string(), ContextSchemaEntrySchema).optional(),
});
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;
