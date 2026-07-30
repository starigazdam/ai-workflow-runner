import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadWorkflow, buildPhaseMap } from "./workflow/WorkflowLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(__dirname, "..", "examples", "peon-workflow.yaml");

try {
  const def = loadWorkflow(yamlPath);
  const phaseMap = buildPhaseMap(def);

  console.log(`✅ workflow.yaml is valid (v${def.meta.version})`);
  console.log(
    `   ${def.phases.length} phases, ${def.routing.length} routing rules`,
  );
  console.log(`   Phase ids: ${[...phaseMap.keys()].join(", ")}`);

  // Check for duplicate phase ids
  const ids = def.phases.map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    console.error(`❌ Duplicate phase ids: ${dupes.join(", ")}`);
    process.exit(1);
  }

  // Check routing targets reference valid phase ids
  for (const rule of def.routing) {
    for (const target of rule.fork) {
      if (!phaseMap.has(target)) {
        console.error(
          `❌ Routing fork target "${target}" is not a valid phase id`,
        );
        process.exit(1);
      }
    }
  }

  // Check phase.next references valid phase ids or null
  for (const phase of def.phases) {
    if (phase.next && phase.next !== "null" && !phaseMap.has(phase.next)) {
      console.error(
        `❌ Phase "${phase.id}" has next="${phase.next}" which is not a valid phase id`,
      );
      process.exit(1);
    }
  }

  console.log("   All routing targets and next-pointers are valid.");
  process.exit(0);
} catch (err) {
  if (err instanceof ZodError) {
    console.error("❌ workflow.yaml validation failed:\n");
    for (const issue of err.issues) {
      console.error(`  ${issue.path.join(".")} — ${issue.message}`);
    }
  } else {
    console.error("❌ Failed to load workflow.yaml:", err);
  }
  process.exit(1);
}
