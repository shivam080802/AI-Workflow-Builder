# Product audit and revised delivery plan

Updated 24 October 2026. This records the actual implementation, rather than presenting planned capabilities as shipped.

## Product and design direction

Traverse uses a restrained operations UI: warm neutral canvas, deep teal navigation, compact typography, clear step shapes, a persistent configuration panel, and visible execution state. The editor keeps the whole graph on screen while the selected node is configured. The dashboard, connection vault, run inspection, review inbox, and workspace settings form the operational shell. The responsive layout was checked in the browser at narrow and desktop widths.

This direction follows the discoverability of [Zapier's visual editor](https://help.zapier.com/hc/en-us/articles/16722578092429-Use-the-editor-to-build-and-view-your-Zap-workflows) and [Activepieces' workflow builder](https://www.activepieces.com/product/workflow-builder), while keeping the canvas, selected-step settings, and run data visually distinct. Separate True and Otherwise ports use [XYFlow custom handles](https://reactflow.dev/learn/customization/handles). These are design references, not claims about comparative usability; usability testing with real users is still needed.

## Implemented now

| Area | Working behavior |
| --- | --- |
| Identity | Registration, password login, HTTP-only sessions, logout, login throttling, workspaces and workspace switching, owner/editor/viewer roles, membership management. |
| Isolation | Workspace-scoped workflows, runs, credentials, approvals, and role checks. |
| Editor | Drag/click palette, canvas wiring, zoom/minimap, inspector, graph validation, immutable published versions. |
| Triggers | Manual execution, HMAC-signed webhook with replay window and delivery deduplication, fixed-interval schedule. |
| Logic | Conditions with equals/contains/exists/greater-than and separate paths; skipped branch steps recorded. |
| Actions | Text/uppercase, HTTPS request, Slack post, GitHub issue. Encrypted connection secrets and public-address-only HTTP egress. |
| Local AI | AI text node with deterministic Mock and LangChain Ollama adapter; installed-model discovery in the editor. Mock is smoke tested; Ollama live inference awaits a local model. |
| Review | Durable approval pause, approve/reject inbox, deadline timeout to Otherwise, worker resume, expired-approval recovery sweep. |
| Operations | Queue-backed runs, per-step checkpoints, bounded retries, run history/detail, SSE projection, audit entries for key changes. |
| Local operation | Docker Compose PostgreSQL/Redis, migrations, setup script, build/type/unit/integration smoke commands. |

## Remaining gaps, in dependency order

1. **Execution correctness and recovery.** Add a lease or atomic run claim, reconciliation for queued runs and decisions whose resume enqueue fails, node attempts, explicit cancellation, dead-letter handling, and crash/race drills. An expired-approval sweep exists. Current side-effect crashes move to `needs_review` rather than automatically repeating an ambiguous action. Approval state is durable, but queue/database cross-system commits still need reconciliation.
2. **Structured graph semantics.** Add typed upstream outputs, variable picker, filters, delays, parallel fan-out and merge, explicit bounded loops/subworkflows, import/export, templates, and full validation/error location. The current executor is a single active path through a DAG; the router supports branch selection without merge or parallel work.
3. **AI foundation.** Generalize the current Mock/Ollama text node into provider contracts, usage accounting, structured output validation, and compatible fallback. Verify live Ollama inference with an installed model. Then add LangGraph agent state and pgvector RAG with workspace-scoped retrieval. No agent or retrieval call is shipped yet.
4. **Connector platform.** Add typed connector SDK, OAuth authorization and refresh, service-event subscriptions, Gmail/Jira/Sheets nodes, credential rotation, connector tests, and isolated custom code execution. Current Slack/GitHub use user-supplied tokens; they are not OAuth connections.
5. **Production hardening.** Add comprehensive auth/session controls, CSRF defense, environment validation, production deployment files, CI, observability, retention/redaction, backups, rate limits beyond login, load and recovery tests, accessibility/usability review, and responsive browser regression tests. Local Compose credentials are development-only.

## Next release gates

| Milestone | Acceptance gate |
| --- | --- |
| Durable engine | Kill/restart worker during pure, external, and approval steps; no lost queued run or duplicate committed effect; clear recovery action for ambiguous effects. |
| Data and logic | A multi-branch graph with a merge and bounded loop validates, runs, and shows exact inputs/outputs per step. |
| AI local slice | A workflow classifies text with local Ollama, records model and usage, and runs with no paid key; Mock path already passes smoke. |
| RAG/agents | Ingest, isolate, retrieve, and cite documents within one workspace; pause/resume agent state and test provider errors. |
| Connector catalog | Complete Gmail → classifier → RAG → agent → approval → Jira → Slack flow with local mocks and separately verified live OAuth paths. |
| Release hardening | CI green, backup/restore drill, concurrency and security suites, deployment runbook, and user task study. |

## Architecture decisions

The general workflow engine owns automation state and external effects. LangGraph will own only an agent node's reasoning and checkpointed state. PostgreSQL is authoritative; BullMQ transports and schedules work. Drafts may change while runs point to immutable versions. Credentials are encrypted outside graph JSON. Each feature crosses contracts, persistence, API, worker, UI, and integration tests before it is considered delivered.
