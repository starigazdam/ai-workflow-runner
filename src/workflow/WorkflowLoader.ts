import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  WorkflowDefSchema,
  type WorkflowDef,
  type PhaseDef,
} from "../types/workflow.js";

/**
 * Load and validate a workflow YAML file.
 * Throws a ZodError with human-readable paths on validation failure.
 */
export function loadWorkflow(yamlPath: string): WorkflowDef {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  return WorkflowDefSchema.parse(parsed);
}

/**
 * Build a Map<phaseId, PhaseDef> for O(1) lookup.
 */
export function buildPhaseMap(def: WorkflowDef): Map<string, PhaseDef> {
  const map = new Map<string, PhaseDef>();
  for (const phase of def.phases) {
    map.set(phase.id, phase);
  }
  return map;
}
