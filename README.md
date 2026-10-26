# Traverse — visual workflow builder

A local-first workflow app with a canvas editor, versioned publishing, queued execution, secure connections, local AI text, human approvals, and run inspection. It uses Yarn Workspaces/Turborepo, React/TypeScript/Vite, XYFlow, Zustand, TanStack Query, Express/Zod, PostgreSQL/Prisma, Redis/BullMQ, and LangChain's Ollama adapter.

## Start locally

Requires Node 20+, Yarn 1.22, and Docker Compose. No paid service or API key is needed for the built-in workflows.

```bash
yarn install
yarn setup
docker compose up -d
yarn db:generate
yarn db:migrate
yarn dev
```

Open [localhost:5173](http://localhost:5173). Register to create a workspace. The API health check is [localhost:4000/health](http://localhost:4000/health). `yarn setup` creates a local `.env` with a random encryption key; keep that file private.

## Build a workflow

1. Create a workflow. Select Manual, Webhook, or Schedule on the trigger.
2. Add Text, Uppercase, Condition, Approval, AI text, HTTP request, Slack message, or GitHub issue nodes. Drag from the palette or click a step, then connect handles. Conditions and approvals have separate True and Otherwise outputs.
3. Select a node to configure it. Store HTTP bearer, Slack, or GitHub tokens on the Connections page and select them in app actions.
4. Save, publish, and start a test run. A published version is immutable; editing a draft does not change in-flight runs.
5. Inspect steps on the Runs page. Paused runs appear in Approvals; editors and owners can approve or reject. Rejection and timeout follow Otherwise.

Webhook workflows require a signed JSON request with timestamp and delivery ID. The editor shows the URL and signing secret after publishing. Schedule triggers start after publishing and stop when a later published version uses another trigger.

AI text has a deterministic Mock provider for testing. For real local inference, install [Ollama](https://ollama.com/), pull a model, start Ollama, and select that model in the node inspector. The API reads the locally installed model list. An Ollama model was not available in the test environment, so live inference needs verification with an installed model.

## Verification

```bash
yarn build
yarn typecheck
yarn test
yarn test:smoke
```

The smoke test needs the local API, worker, PostgreSQL, and Redis running. It creates disposable test accounts and checks authentication, tenant isolation, credentials, both condition paths, signed webhook deduplication, schedule activation/removal, local AI Mock, and both approval decisions.

## Architecture and status

- `apps/web`: canvas, workspace, connections, approvals, run inspection.
- `apps/api`: authentication, RBAC, validation, workflow versions, webhook intake, schedule management, and scoped REST/SSE.
- `apps/worker`: queued execution, branch selection, checkpoints, external actions, approval pause/resume.
- `packages/contracts`, `engine`, `security`, `db`: shared schemas, execution helpers, network/secret safeguards, Prisma.

[Product blueprint](docs/BLUEPRINT.md) describes the target architecture. [Current gap audit](docs/GAP_AUDIT.md) lists what is implemented, what is missing, and the next dependent milestones. This is a functional local product slice; the full AI/RAG, OAuth connector catalog, and production reliability program remain in the roadmap.
