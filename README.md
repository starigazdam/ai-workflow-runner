# ai-workflow-runner

A TypeScript workflow engine that drives AI agents (GitHub Copilot, OpenAI, Anthropic) through structured, YAML-defined multi-phase workflows. Each phase invokes an LLM agent, runs configurable gate checks, and writes context to disk for resume/audit.

## Features

- **Structured workflows** — define phases, gates, routing forks, and agent assignments in a single `workflow.yaml`
- **Multiple runner backends** — GitHub Copilot SDK (default), OpenAI-compatible, Anthropic
- **Gate system** — blocking / advisory gates with expression evaluation, user-approval pauses, and artifact validation
- **Batch runner** — autonomous overnight execution with circuit breaker, per-ticket timeout, and iteration (Ralph loop)
- **MCP server** — expose the engine as MCP tools so any MCP client can run/step/approve workflows
- **Mock runner** — execute any workflow against fixture data without real LLM calls
- **Run artifacts** — every run writes `SUMMARY.md`, `events.json`, `context-final.json`, and per-phase diffs

## Prerequisites

- Node.js ≥ 18
- `npm install`

## Quick Start

```bash
# Validate the example workflow YAML
npm run validate-workflow-yaml

# Run a mock scenario (no LLM needed)
npm run mock-run
npm run mock-run -- --scenario analysis
npm run mock-run -- --scenario bug

# Start the MCP server
npm run mcp-server
```

## CLI — `src/main.ts`

```
npx tsx src/main.ts [options]

Options:
  --ticket <id>           Jira/ticket ID (e.g. PROJ-1234)
  --workflow <path>       Path to workflow.yaml  [default: examples/example-workflow.yaml]
  --repo-root <path>      Root of the repo the runner operates on.
                          The runner reads agent .md files from <repo-root>/.github/agents/
                          and stores context in <repo-root>/.github/tmp/.
                          Fallback: WORKFLOW_REPO_ROOT env var, then process.cwd().
  --runner <type>         copilot-sdk | openai | anthropic | mock  [default: copilot-sdk]
  --dry-run               Show phase transitions without calling LLMs
  --auto-approve          Skip all user_approval pauses
  --mock                  Use mock runner (alias for --runner mock)
  --scenario <name>       Mock scenario name  [default: story]

  BYOK (copilot-sdk runner):
  --provider-type         openai | azure | anthropic
  --provider-url          Base URL for the provider
  --provider-key          API key

Env vars:
  WORKFLOW_REPO_ROOT      Fallback repo root (overridden by --repo-root)
  LLM_BASE_URL            Base URL for OpenAI-compatible runner
  LLM_API_KEY             API key for OpenAI-compatible runner
  LLM_MODEL               Model name
  ANTHROPIC_API_KEY       API key for Anthropic runner
```

### Examples

```bash
# Real run against a ticket using GitHub Copilot (default)
npx tsx src/main.ts --ticket PROJ-1234 --repo-root /path/to/your/repo

# Use OpenAI directly
npx tsx src/main.ts --ticket PROJ-1234 --runner openai --repo-root /path/to/your/repo

# Dry run — see what would happen without calling any LLM
npx tsx src/main.ts --ticket PROJ-1234 --dry-run --repo-root /path/to/your/repo

# Mock run with the example story scenario
npx tsx src/main.ts --mock --scenario story
```

## Batch Runner — `src/batch.ts`

Runs multiple tickets sequentially with `autoApprove=true`. Supports per-ticket timeouts, iteration (Ralph loop), and a circuit breaker.

```
npx tsx src/batch.ts [options]

Options:
  --tickets <t1,t2,...>      Comma-separated ticket IDs
  --tickets-file <path>      Path to a file with one ticket ID per line
  --max-iterations <n>       Re-run each ticket N times (Ralph loop)  [default: 1]
  --timeout-per-ticket <m>   Kill a ticket run after M minutes  [default: no timeout]
  --circuit-breaker <n>      Halt batch after N consecutive failures  [default: 5]
  --runner <type>            openai | anthropic | mock  [default: openai]
  --repo-root <path>         Repo root (same as CLI above)
  --workflow <path>          Path to workflow.yaml
  --dry-run                  Skip LLM calls
  --mock / --scenario        Mock mode
```

### Example

```bash
npx tsx src/batch.ts \
  --tickets PROJ-1234,PROJ-5678 \
  --repo-root /path/to/your/repo \
  --runner anthropic \
  --max-iterations 2 \
  --timeout-per-ticket 30
```

## MCP Server — `src/mcp/server.ts`

Exposes the workflow engine as MCP tools over stdio. Configure in your MCP host (`mcp.json`):

```json
{
  "servers": {
    "ai-workflow-runner": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/path/to/ai-workflow-runner/src/mcp/server.ts"],
      "env": {
        "WORKFLOW_REPO_ROOT": "/path/to/your/repo"
      }
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `workflow_run` | Start a workflow for a ticket; runs to completion, pause, or block |
| `workflow_step` | Execute exactly one phase and pause (phase-by-phase control) |
| `workflow_status` | Get current snapshot of a running workflow |
| `workflow_approve` | Approve a pending `user_approval` gate |
| `workflow_reject` | Reject a pending approval and stop the workflow |

All tools accept an optional `repo_root` parameter (overrides `WORKFLOW_REPO_ROOT`).

## Workflow YAML Format

See [`examples/example-workflow.yaml`](examples/example-workflow.yaml) for a full annotated example.

Key sections:

```yaml
meta:
  version: "1.0.0"
  context_file: ".github/tmp/context-{ticket_id}.json"

routing:
  - condition: "jira_data.status contains 'Analysis'"
    fork: [analysis]
    stop_after_fork: true

phases:
  - id: intake
    label: "Phase 0 — Ticket Intake"
    agent: "05-intake"           # reads <repo-root>/.github/agents/05-intake.md
    required_inputs: []
    outputs:
      - key: jira_data
        schema: { ... }
    gates:
      - id: gate_intake_jira
        type: blocking           # or "advisory"
        check: "jira_data != null"
        message: "Jira fetch failed."
    next: repo_resolver
```

### Agent files

Agent `.md` files live in `<repo-root>/.github/agents/`. The runner passes the file content as the agent's system prompt.

### Gate types

| Type | Behaviour |
|------|-----------|
| `blocking` | Throws `GateError`; engine stops the phase |
| `advisory` | Emits `gate_advisory` event; workflow continues |
| `user_approval` | Pauses for interactive confirmation (or auto-approved with `--auto-approve`) |

## Run Artifacts

Each run writes to `runs/<ticket-id>-<timestamp>/`:

```
runs/PROJ-1234-2026-07-30T09-00-00/
├── SUMMARY.md          # token usage, cost, gate results
├── context-final.json  # full context snapshot
├── events.json         # all workflow events
├── snapshot.json       # engine state (for resume)
└── diffs/
    └── <phase-id>.diff # staged git diff after each phase
```

## Bring Your Own Workflow

1. Copy `examples/example-workflow.yaml` as a starting point
2. Define your phases, agents, gates, and routing
3. Place agent `.md` files in `<your-repo>/.github/agents/`
4. Run with `--workflow path/to/your-workflow.yaml --repo-root path/to/your-repo`

## Project Structure

```
src/
├── main.ts              # CLI entry point
├── batch.ts             # Batch runner
├── mock-run.ts          # Mock run helper
├── validate.ts          # workflow.yaml validator
├── agent/               # Runner backends
│   ├── AgentRunner.ts   # Interface + event types
│   ├── CopilotSdkRunner.ts
│   ├── OpenAiRunner.ts
│   ├── AnthropicRunner.ts
│   ├── MockAgentRunner.ts
│   └── pricing.ts
├── workflow/            # State machine
│   ├── WorkflowEngine.ts
│   ├── WorkflowLoader.ts
│   ├── PhaseExecutor.ts
│   └── routing.ts
├── gates/               # Gate evaluation
│   ├── GateRunner.ts
│   ├── expression-eval.ts
│   ├── artifact-gate.ts
│   ├── self-review-gate.ts
│   └── wrapup-gate.ts
├── context/
│   └── ContextStore.ts  # Persist context between runs
├── mcp/
│   └── server.ts        # MCP server
└── types/
    └── workflow.ts      # Zod schemas

examples/
├── example-workflow.yaml   # Full example workflow definition
└── example-mock-data.yaml  # Mock data for example workflow scenarios

tests/                   # Vitest test suite
runs/                    # Run artifacts (gitignored)
```

## License

See [LICENSE](LICENSE).
