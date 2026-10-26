# ADR-0001: modular monolith and a separate execution worker

Status: accepted for the initial product, 24 October 2026.

## Context

The product needs a responsive editor and API, long-running workflows, inspectable state, and future AI/connector extensions. A single synchronous API process would tie execution latency to request capacity. Multiple independently deployed business services would add operational and transactional complexity before usage justifies it.

## Decision

Use a TypeScript monorepo with one Express API, one BullMQ worker process, PostgreSQL as the authoritative store, Redis as dispatch transport, a versioned node registry, and immutable published workflow graphs. Keep node contracts independent of React and AI providers. Invoke LangGraph inside agent nodes when those arrive; retain workflow scheduling in the general engine.

## Consequences

The API can scale independently from workers. Runs are traceable to exact graph versions. Postgres and Redis must both be monitored. A database write followed by an enqueue is not atomic, so the production engine needs an outbox/reconciler. Side-effecting nodes need action idempotency keys and ambiguous-outcome handling. Third-party connector code needs sandboxing before public installation is enabled.

## Rejected alternatives

- **Synchronous execution inside Express:** simpler initially, but pauses and provider latency would consume request capacity and complicate recovery.
- **LangGraph as the only workflow engine:** good for agent state, but ordinary triggers, approvals, external side effects, and connector retries need explicit automation semantics.
- **Microservices by feature:** adds deployment and consistency overhead before scale or team boundaries require it.

See [BLUEPRINT.md](BLUEPRINT.md) for the data model, APIs, diagrams, failure behavior, and phase gates.
