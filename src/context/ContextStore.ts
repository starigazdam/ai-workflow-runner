/**
 * Typed read/write for .github/tmp/context-{ticket}.json.
 * Mirrors the context JSON that bash hooks and agents produce/consume.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

/** Loose context type — keys are added progressively by phases. */
export type Context = Record<string, unknown>;

export class ContextStore {
  constructor(private readonly tmpDir: string) {}

  /** Resolve the file path for a ticket's context JSON. */
  private filePath(ticketId: string): string {
    return join(this.tmpDir, `context-${ticketId}.json`);
  }

  /** Read context for a ticket. Returns empty object if file doesn't exist. */
  read(ticketId: string): Context {
    const p = this.filePath(ticketId);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as Context;
  }

  /** Merge a partial update into an existing context file. Creates if missing. */
  write(ticketId: string, partial: Partial<Context>): void {
    const p = this.filePath(ticketId);
    mkdirSync(dirname(p), { recursive: true });
    const existing = this.read(ticketId);
    const merged = { ...existing, ...partial };
    writeFileSync(p, JSON.stringify(merged, null, 2), "utf-8");
  }

  /** Find the most-recent context-*.json file (by mtime). Returns ticket id or null. */
  findLatest(): string | null {
    if (!existsSync(this.tmpDir)) return null;
    const files = readdirSync(this.tmpDir)
      .filter((f) => f.startsWith("context-") && f.endsWith(".json"))
      .map((f) => ({
        name: f,
        ticketId: f.replace("context-", "").replace(".json", ""),
        mtime: existsSync(join(this.tmpDir, f))
          ? readFileSync(join(this.tmpDir, f)).length // just need ordering, stat is slow on drvfs
          : 0,
      }))
      .sort((a, b) => b.name.localeCompare(a.name)); // lexicographic — COPEE2-9999 > COPEE2-9000

    return files.length > 0 ? files[0].ticketId : null;
  }

  /** Check if a context file exists for the given ticket. */
  exists(ticketId: string): boolean {
    return existsSync(this.filePath(ticketId));
  }

  /** Generate next AD-HOC-xx id by scanning existing context files. */
  nextAdHocId(): string {
    if (!existsSync(this.tmpDir)) return "AD-HOC-01";
    const files = readdirSync(this.tmpDir).filter(
      (f) => f.startsWith("context-AD-HOC-") && f.endsWith(".json"),
    );
    const nums = files.map((f) => {
      const m = f.match(/AD-HOC-(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `AD-HOC-${String(next).padStart(2, "0")}`;
  }
}
