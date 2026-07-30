/**
 * Routing condition evaluator for workflow.yaml routing rules.
 *
 * Supported expressions:
 *   - path.to.value contains 'string'
 *   - path.to.value == 'string'
 *   - expr or expr   (disjunction)
 */
import type { Context } from "../context/ContextStore.js";
import type { RoutingCondition } from "../types/workflow.js";

/**
 * Resolve a dot-path (e.g. "jira_data.status") against a context object.
 */
function resolvePath(context: Readonly<Context>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single atomic condition (no connectives).
 * Supports: `path contains 'value'` and `path == 'value'`
 */
function evaluateAtom(expr: string, context: Readonly<Context>): boolean {
  // path contains 'value'
  const containsMatch = expr.match(/^(.+?)\s+contains\s+'([^']+)'$/);
  if (containsMatch) {
    const val = resolvePath(context, containsMatch[1].trim());
    if (typeof val !== "string") return false;
    return val.includes(containsMatch[2]);
  }

  // path == 'value'
  const eqMatch = expr.match(/^(.+?)\s*==\s*'([^']+)'$/);
  if (eqMatch) {
    const val = resolvePath(context, eqMatch[1].trim());
    return val === eqMatch[2];
  }

  // Unknown expression form — treat as false
  return false;
}

/**
 * Evaluate a condition expression. Supports `or` connective.
 */
export function evaluateCondition(
  condition: string,
  context: Readonly<Context>,
): boolean {
  const parts = condition.split(/\s+or\s+/);
  return parts.some((part) => evaluateAtom(part.trim(), context));
}

/**
 * Evaluate all routing rules and return the first matching fork, or null.
 * `alreadyFired` tracks rule indices that have already been applied (prevents re-firing).
 */
export function evaluateRouting(
  rules: readonly RoutingCondition[],
  context: Readonly<Context>,
  alreadyFired: ReadonlySet<number>,
): { index: number; fork: string[]; stopAfterFork: boolean } | null {
  for (let i = 0; i < rules.length; i++) {
    if (alreadyFired.has(i)) continue;
    if (evaluateCondition(rules[i].condition, context)) {
      return {
        index: i,
        fork: [...rules[i].fork],
        stopAfterFork: rules[i].stop_after_fork ?? false,
      };
    }
  }
  return null;
}
