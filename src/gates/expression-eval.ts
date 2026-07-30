/**
 * Expression evaluator for workflow.yaml gate check strings.
 *
 * Supported forms:
 *   path.to.value != null
 *   path.to.value == 'literal' | true | false | number
 *   path.to.value != 'literal'
 *   path.to.array.length > N | < N | >= N | <= N | == N
 *   path.to.value matches /regex/
 *   path.to.value in ['A','B','C']
 *   expr && expr  (conjunction)
 */

type Ctx = Readonly<Record<string, unknown>>;

/**
 * Resolve a dot-path against a context object.
 * Supports `.length` on arrays/strings as a terminal segment.
 */
export function resolvePath(context: Ctx, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // .length on arrays/strings
    if (part === "length") {
      if (Array.isArray(current)) return current.length;
      if (typeof current === "string") return current.length;
      return undefined;
    }

    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Parse a literal value from an expression string.
 * Supports: null, true, false, 'string', number.
 */
function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Quoted string
  const quoted = trimmed.match(/^'([^']*)'$/);
  if (quoted) return quoted[1];
  // Number
  const num = Number(trimmed);
  if (!Number.isNaN(num)) return num;
  return trimmed; // fallback — treat as raw string
}

/**
 * Evaluate a single atomic expression (no && connective).
 */
function evaluateAtom(expr: string, context: Ctx): boolean {
  const trimmed = expr.trim();

  // path != null
  const neqNull = trimmed.match(/^(.+?)\s*!=\s*null$/);
  if (neqNull) {
    const val = resolvePath(context, neqNull[1].trim());
    return val !== undefined && val !== null && val !== "";
  }

  // path == null
  const eqNull = trimmed.match(/^(.+?)\s*==\s*null$/);
  if (eqNull) {
    const val = resolvePath(context, eqNull[1].trim());
    return val === undefined || val === null || val === "";
  }

  // path matches /regex/
  const matchesRegex = trimmed.match(/^(.+?)\s+matches\s+\/(.+)\/$/);
  if (matchesRegex) {
    const val = resolvePath(context, matchesRegex[1].trim());
    if (typeof val !== "string") return false;
    try {
      const re = new RegExp(matchesRegex[2]);
      return re.test(val);
    } catch {
      return false;
    }
  }

  // path in ['A','B','C']
  const inMatch = trimmed.match(/^(.+?)\s+in\s+\[(.+)\]$/);
  if (inMatch) {
    const val = resolvePath(context, inMatch[1].trim());
    const items = inMatch[2].split(",").map((s) => {
      const q = s.trim().match(/^'([^']*)'$/);
      return q ? q[1] : s.trim();
    });
    return items.includes(val as string);
  }

  // Comparison operators: == != > < >= <=
  // Must check multi-char operators before single-char
  const cmpMatch = trimmed.match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const left = resolvePath(context, cmpMatch[1].trim());
    const op = cmpMatch[2];
    const rightRaw = cmpMatch[3].trim();
    const right = parseLiteral(rightRaw);

    // Numeric comparison when both sides are numbers
    const leftNum = typeof left === "number" ? left : Number(left);
    const rightNum = typeof right === "number" ? right : Number(right);
    const bothNumeric =
      typeof left === "number" &&
      (typeof right === "number" || !Number.isNaN(Number(rightRaw)));

    switch (op) {
      case "==":
        // Boolean comparison: path == true/false
        if (right === true || right === false) return left === right;
        if (bothNumeric) return leftNum === rightNum;
        return left === right;
      case "!=":
        if (bothNumeric) return leftNum !== rightNum;
        return left !== right;
      case ">":
        return bothNumeric ? leftNum > rightNum : false;
      case "<":
        return bothNumeric ? leftNum < rightNum : false;
      case ">=":
        return bothNumeric ? leftNum >= rightNum : false;
      case "<=":
        return bothNumeric ? leftNum <= rightNum : false;
    }
  }

  // Unrecognized expression — return false (safe default: gate blocks)
  return false;
}

/**
 * Evaluate a gate check expression against a context object.
 * Supports `&&` conjunction at the top level.
 */
export function evaluateExpression(expr: string, context: Ctx): boolean {
  // Split on && (top-level conjunction)
  const parts = expr.split(/\s*&&\s*/);
  return parts.every((part) => evaluateAtom(part.trim(), context));
}
