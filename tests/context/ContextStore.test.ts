import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "../../src/context/ContextStore.js";

const TEST_DIR = join(tmpdir(), "peon-test-ctx-" + process.pid);

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
    const ctx = store.read("COPEE2-9999");
    expect(ctx).toEqual({});
  });

  it("write creates file and read returns it", () => {
    store.write("COPEE2-1000", { jira_data: { key: "COPEE2-1000" } });
    const ctx = store.read("COPEE2-1000");
    expect(ctx.jira_data).toEqual({ key: "COPEE2-1000" });
  });

  it("write merges with existing context", () => {
    store.write("COPEE2-1000", { jira_data: { key: "X" } });
    store.write("COPEE2-1000", { repo_context: [{ name: "repo-a" }] });
    const ctx = store.read("COPEE2-1000");
    expect(ctx.jira_data).toEqual({ key: "X" });
    expect(ctx.repo_context).toEqual([{ name: "repo-a" }]);
  });

  it("write overwrites existing keys", () => {
    store.write("COPEE2-1000", { plan: { v: 1 } });
    store.write("COPEE2-1000", { plan: { v: 2 } });
    const ctx = store.read("COPEE2-1000");
    expect(ctx.plan).toEqual({ v: 2 });
  });

  it("exists returns false for missing ticket", () => {
    expect(store.exists("COPEE2-NOPE")).toBe(false);
  });

  it("exists returns true after write", () => {
    store.write("COPEE2-2000", { ticket_id: "COPEE2-2000" });
    expect(store.exists("COPEE2-2000")).toBe(true);
  });

  it("findLatest returns null on empty dir", () => {
    expect(store.findLatest()).toBeNull();
  });

  it("findLatest returns a ticket id when files exist", () => {
    store.write("COPEE2-1000", { ticket_id: "COPEE2-1000" });
    store.write("COPEE2-2000", { ticket_id: "COPEE2-2000" });
    const latest = store.findLatest();
    expect(latest).not.toBeNull();
    // Lexicographic sort — 2000 > 1000
    expect(latest).toBe("COPEE2-2000");
  });

  it("writes valid JSON to disk", () => {
    store.write("COPEE2-3000", { self_review_completed: true });
    const raw = readFileSync(
      join(TEST_DIR, "context-COPEE2-3000.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.self_review_completed).toBe(true);
  });
});
