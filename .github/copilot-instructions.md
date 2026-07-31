# Copilot Instructions for `ai-workflow-runner`

## Build, test, and validation commands

Use Node 18+ and install deps first:

```bash
npm install
```

Primary project commands (from `package.json`):

```bash
npm run typecheck
npm test
npm run validate-workflow-yaml
npm run mock-run
npm run mcp-server
```

Run a single test file (Vitest):

```bash
npx vitest run tests/workflow/WorkflowEngine.test.ts
```

Run a single test case by name:

```bash
npx vitest run tests/workflow/WorkflowEngine.test.ts -t "restores from snapshot"
```

## Technology baseline and freshness

- Prefer **current stable runtimes/tools** when making changes (Node.js current active LTS or newer stable, latest stable TypeScript/Vitest ecosystem versions compatible with the repo).
- For new code, use modern Node ESM + standard APIs already used in this repo (`node:` imports, `async/await`, strict typing), and avoid introducing legacy patterns.
- When changing dependency versions, prefer targeted updates to currently maintained stable releases and keep `package.json` + lockfile consistent.

## High-level architecture

This repository is a YAML-driven workflow engine that executes multi-phase AI flows with gates, routing, persistence, and multiple LLM backends.

### Core flow

1. `src/main.ts` parses CLI flags, resolves `repoRoot`/workflow path, selects a runner, and starts the engine.
2. `src/workflow/WorkflowLoader.ts` + `src/types/workflow.ts` load/validate workflow YAML with Zod schemas.
3. `src/workflow/WorkflowEngine.ts` runs the state machine:
   - queue-based phase execution
   - routing forks (`routing_after` checkpoint + routing rules)
   - pause/approve/reject state transitions
   - snapshot persistence (`snapshot.json`) for resume/recovery
4. `src/workflow/PhaseExecutor.ts` executes one phase:
   - pre-gate artifact check (`required_inputs`)
   - agent invocation via `AgentRunner`
   - post-gate evaluation + retry loop (`retry_limit`)
   - approval-gate detection
5. `src/gates/*` contains gate implementations and expression evaluation.
6. `src/context/ContextStore.ts` persists ticket context files in `.github/tmp/context-<ticket>.json`.

### Runner abstraction

`src/agent/AgentRunner.ts` defines the interface used by the engine. Implementations:

- `CopilotSdkRunner` (default CLI runner)
- `OpenAiRunner`
- `AnthropicRunner`
- `MockAgentRunner` (fixture-based)

The engine should remain backend-agnostic; provider behavior belongs in runner classes.

### MCP server integration

`src/mcp/server.ts` exposes the engine as MCP tools (`workflow_run`, `workflow_step`, `workflow_status`, `workflow_approve`, `workflow_reject`), keeps in-memory engine registry, and restores snapshots via `.github/tmp/active-<ticket>.json` pointers.

## Key repository-specific conventions

- **Repo root contract is important:** runtime inputs/outputs are relative to the operated repo (`--repo-root` or `WORKFLOW_REPO_ROOT`), especially:
  - agent prompts: `<repoRoot>/.github/agents/*.md`
  - persisted context: `<repoRoot>/.github/tmp/context-<ticket>.json`
- **Phase semantics are split intentionally:**
  - pre-gate checks ensure prerequisites before agent call
  - post-gates validate agent outputs and can trigger retries
- **User approval is modeled as a gate kind** (`kind: user_approval`) but pause/resume behavior is handled by `WorkflowEngine`, not by gate evaluators.
- **Routing is checkpointed**, not continuously applied: routing rules are evaluated after `meta.routing_after` phase.
- **State persistence is best-effort:** snapshot/run artifact writes should not crash workflow execution.
- **Audit artifacts are first-class outputs:** runs write `SUMMARY.md`, `events.json`, `context-final.json`, `snapshot.json`, plus per-phase staged diffs in `runs/<ticket>-<timestamp>/`.
- **Tests are organized by subsystem** (`tests/workflow`, `tests/gates`, `tests/agent`, `tests/context`, `tests/batch`) and mirror source module boundaries.
