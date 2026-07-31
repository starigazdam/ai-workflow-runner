import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ZodError } from "zod";
import yaml from "js-yaml";
import {
  loadWorkflow,
  buildPhaseMap,
} from "../../src/workflow/WorkflowLoader.js";
import { WorkflowDefSchema } from "../../src/types/workflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(__dirname, "..", "..", "examples", "example-workflow.yaml");

describe("WorkflowLoader", () => {
  it("loads workflow.yaml without error", () => {
    const def = loadWorkflow(yamlPath);
    expect(def.meta.version).toBeDefined();
    expect(def.phases.length).toBeGreaterThan(0);
  });

  it("every phase has a unique id", () => {
    const def = loadWorkflow(yamlPath);
    const ids = def.phases.map((p) => p.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it("buildPhaseMap returns all phase ids", () => {
    const def = loadWorkflow(yamlPath);
    const map = buildPhaseMap(def);
    for (const phase of def.phases) {
      expect(map.has(phase.id)).toBe(true);
    }
    expect(map.size).toBe(def.phases.length);
  });

  it("routing fork targets reference existing phases", () => {
    const def = loadWorkflow(yamlPath);
    const map = buildPhaseMap(def);
    for (const rule of def.routing) {
      for (const target of rule.fork) {
        expect(map.has(target)).toBe(true);
      }
    }
  });

  it("phase.next references a valid phase id or is null/undefined", () => {
    const def = loadWorkflow(yamlPath);
    const map = buildPhaseMap(def);
    for (const phase of def.phases) {
      if (phase.next != null) {
        expect(
          map.has(phase.next),
          `Phase "${phase.id}" has next="${phase.next}" not in phase map`,
        ).toBe(true);
      }
    }
  });

  it("cross-checks agents against artifacts.json (skipped if file absent)", () => {
    // This test is intentionally skipped when artifacts.json is not present.
    // To enable it, provide an artifacts.json next to the workflow YAML that maps
    // agent IDs to their expected output schemas.
    const artifactsPath = resolve(
      __dirname,
      "..",
      "..",
      "examples",
      "example-artifacts.json",
    );
    let artifacts: Record<string, unknown>;
    try {
      artifacts = JSON.parse(readFileSync(artifactsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // artifacts.json not present — skip
      return;
    }
    const def = loadWorkflow(yamlPath);

    // Every agent referenced in phases should exist in artifacts.json
    for (const phase of def.phases) {
      if (phase.agent) {
        expect(
          artifacts,
          `Agent "${phase.agent}" from phase "${phase.id}" not in artifacts.json`,
        ).toHaveProperty(phase.agent);
      }
    }
  });

  it("rejects YAML missing required meta fields", () => {
    const bad = yaml.dump({
      meta: { version: "1.0.0" }, // missing context_file, audit_dir, artifacts_schema
      routing: [],
      phases: [],
    });

    expect(() => {
      WorkflowDefSchema.parse(yaml.load(bad));
    }).toThrow(ZodError);
  });

  it("rejects a phase with unknown gate type", () => {
    const bad = yaml.dump({
      meta: {
        version: "1",
        context_file: "x",
        audit_dir: "y",
        artifacts_schema: "z",
      },
      routing: [],
      phases: [
        {
          id: "test",
          label: "test",
          agent: null,
          required_inputs: [],
          outputs: [],
          gates: [
            { id: "g1", type: "nonexistent", check: "true", message: "m" },
          ],
        },
      ],
    });

    expect(() => {
      WorkflowDefSchema.parse(yaml.load(bad));
    }).toThrow(ZodError);
  });

  it("Zod errors include readable paths", () => {
    const bad = yaml.dump({
      meta: {
        version: "1",
        context_file: "x",
        audit_dir: "y",
        artifacts_schema: "z",
      },
      routing: [],
      phases: [
        {
          // missing id, label, agent, required_inputs
        },
      ],
    });

    try {
      WorkflowDefSchema.parse(yaml.load(bad));
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const zodErr = err as ZodError;
      // Should reference phases.0.id in the path
      const paths = zodErr.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.startsWith("phases.0"))).toBe(true);
    }
  });
});
