import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "../../src/context/ContextStore.js";

const TEST_DIR = join(tmpdir(), "workflow-test-ctx-" + process.pid);

describe("ContextStore", () => {
  let store: ContextStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new ContextStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("read returns empty object for non-existent ticket", () => {
    const ctx = store.read("PROJ-9999");
    expect(ctx).toEqual({});
  });

  it("write creates file and read returns it", () => {
    store.write("PROJ-1000", { jira_data: { key: "PROJ-1000" } });
    const ctx = store.read("PROJ-1000");
    expect(ctx.jira_data).toEqual({ key: "PROJ-1000" });
  });

  it("write merges with existing context", () => {
    store.write("PROJ-1000", { jira_data: { key: "X" } });
    store.write("PROJ-1000", { repo_context: [{ name: "repo-a" }] });
    const ctx = store.read("PROJ-1000");
    expect(ctx.jira_data).toEqual({ key: "X" });
    expect(ctx.repo_context).toEqual([{ name: "repo-a" }]);
  });

  it("write overwrites existing keys", () => {
    store.write("PROJ-1000", { plan: { v: 1 } });
    store.write("PROJ-1000", { plan: { v: 2 } });
    const ctx = store.read("PROJ-1000");
    expect(ctx.plan).toEqual({ v: 2 });
  });

  it("exists returns false for missing ticket", () => {
    expect(store.exists("PROJ-NOPE")).toBe(false);
  });

  it("exists returns true after write", () => {
    store.write("PROJ-2000", { ticket_id: "PROJ-2000" });
    expect(store.exists("PROJ-2000")).toBe(true);
  });

  it("findLatest returns null on empty dir", () => {
    expect(store.findLatest()).toBeNull();
  });

  it("findLatest returns a ticket id when files exist", () => {
    store.write("PROJ-1000", { ticket_id: "PROJ-1000" });
    store.write("PROJ-2000", { ticket_id: "PROJ-2000" });
    const latest = store.findLatest();
    expect(latest).not.toBeNull();
    // Lexicographic sort — 2000 > 1000
    expect(latest).toBe("PROJ-2000");
  });

  it("writes valid JSON to disk", () => {
    store.write("PROJ-3000", { self_review_completed: true });
    const raw = readFileSync(
      join(TEST_DIR, "context-PROJ-3000.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.self_review_completed).toBe(true);
  });
});
