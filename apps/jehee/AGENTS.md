# Jehee Project Rules (`apps/jehee`)

## Upstream Isolation & Mandatory Issue Traceability

- Keep all Jehee product code, docs, tests, and evals strictly inside `apps/jehee/`; do not modify upstream `packages/*` or root `AGENTS.md`.
- Before closing any vertical slice or live eval, record every non-trivial bug, upstream contract pitfall, and failed eval iteration in `apps/jehee/docs/evals/NNNN-*-postmortem.md` (symptom, root cause, fix location, prevention rule) and register it in `apps/jehee/docs/README.md`.

## Verified `pi-durable` & Provider Invariants (Lessons from Slices 5A–5C)

- **Provider session header**: Any direct `models.completeSimple` / `stream` call outside `GenerationTask` (e.g. background consolidation or compaction) must pass a deterministic `sessionId` (required by `opencode-go` `x-opencode-session`) and pass `telemetry: span` (a `TelemetrySpan`, not `TelemetryContext`) when nested under a custom span.
- **`TaskRuntime.commit` return semantics**: Inside `defineTask`, returning any non-undefined object from `runtime.commit(tx => ...)` replaces the task's `TaskState`. When only reading or mutating documents, capture return values via an outer variable and return `undefined`.
- **Transaction overlays**: Never return references to objects obtained from `tx.doc(...)` outside the `commit` callback; deep-clone plain data inside the transaction (`Cannot use a settled overlay`).
- **Durable doc & extension APIs**:
  - `defineDoc` always requires `checkpointWhen` (even with `scope: "session"`).
  - `TaskId` is numeric at runtime; store persisted task IDs as `number`, not `string`.
  - `configure({ extensions: { remove } })` accepts `Extension` objects, not string names.
  - `ToolExecutionResult` uses `output` (not `content`).
  - Manual `JeheeHost` methods must fall back to the host's configured `telemetry` (`this.#telemetry ?? context.telemetry`).
- **Cloudflare Workers `fetch` receiver**: Never store `globalThis.fetch` on a class property/private field and invoke it as `this.#fetch(...)` (`workerd` throws `TypeError: Illegal invocation`). Always wrap both `globalThis.fetch` and injected `fetchImpl` in standalone arrow calls and cover with a strict `this === undefined` unit test.
- **Eval hygiene**: Keep eval dialogue prompts natural and realistic; never embed meta test instructions (e.g. "do not call tools") inside user messages, as downstream summarizers/consolidators will treat them as genuine user intent.
