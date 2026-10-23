# AGENT_LOG

Shared handoff log for ChatGPT, Claude, and future maintainers working on Astel Social Engine.

## Logging rule

After every closed implementation block or merged PR, append a new entry to the end of this file. Do not rewrite older entries except to correct a factual error.

A task is not considered fully closed until both the technical work/verification and the corresponding `AGENT_LOG.md` entry are complete. "Implemented" or "deployed" without a handoff entry is still an incomplete process state.

Use this format:

```md
## YYYY-MM-DD — Block X.Y — <name>

**Status:** DONE / IN PROGRESS / BLOCKED

**Done:**
- item

**Commits/PRs:** #NN (main), #NN (ru-bot)

**Regression:** N/N tests pass

**Changed files/services:** short summary only

**Open questions / external verification:**
- explicitly list anything that still needs external verification
```

Never put access tokens, secrets, passwords, private connection strings, or other credentials in this file.

---

## 2026-09-13 — Block 0 — Architecture Shell

**Status:** DONE

**Done:**
- Added account configuration boundary, SocialProvider contract, account-scoped ProviderRegistry, ThreadsProvider compatibility wrapper, and application composition root.
- Preserved existing Threads Reply Engine behavior and safety pipeline.
- Ported the exact tested architecture tree to `ru-bot` without merging divergent history.

**Commits/PRs:** #22 (main), #23 (ru-bot)

**Regression:** 77/77 tests pass

**Changed files/services:** `app/accounts/*`, `app/providers/*`, `app/composition/*`, architecture tests, minimal `server.js` integration; EN/RU Railway deploys.

**Open questions / external verification:**
- None for Block 0.

---

## 2026-09-13 — Block 1 — Meta Provider Layer and Unified Cutover

**Status:** DONE

**Done:**
- Pinned deterministic Node/npm build path and lockfile.
- Added InstagramProvider and FacebookProvider with normalized SocialEvent and fail-closed reply mutation semantics.
- Added unified Meta webhook router and account-scoped multi-platform composition.
- Added unified `server-meta.js` production entrypoint while preserving legacy rollback via `server.js`.
- Instagram/Facebook remain disabled/dry-run until real Meta assets, permissions, tokens, webhook subscriptions, App Review/Business Verification and Live-mode requirements are completed.

**Commits/PRs:** #24/#25 (build reproducibility), #26/#27 (Instagram), #28/#29 (Facebook), #30/#31 (Meta router), #32/#33 (production cutover)

**Regression:** 107/107 tests pass at Block 1 closure

**Changed files/services:** Meta adapters/providers, normalized event layer, webhook router, account config, community runtime, `server-meta.js`, EN/RU Railway app services.

**Open questions / external verification:**
- Meta onboarding remains externally blocked/paused: IG/FB asset IDs, permissions, tokens, webhook subscriptions, Live mode and verification are not yet active.
- Do not set IG/FB dry-run off until real webhook traffic is verified account-by-account.

---

## 2026-09-13 — Block 2 — Fail-Safe Publish Engine / Scheduler

**Status:** DONE

**Done:**
- Added platform-neutral publish job model, Redis-backed scheduler/queue, dedupe, claims and leases.
- Added fail-safe `AMBIGUOUS_HOLD`; unknown external publish outcomes are never blindly retried.
- Added official two-step Threads text publishing flow.
- Kept production publishing disabled and dry-run by default.

**Commits/PRs:** #34 (main), #35 (ru-bot)

**Regression:** 116/116 tests pass

**Changed files/services:** `app/publishing/*`, `adapters/threadsPostPublisher.js`, Threads provider capability wiring, `server-meta.js`, EN/RU Railway deployments.

**Open questions / external verification:**
- `PUBLISH_ENGINE_ENABLED=false` and `PUBLISH_ENGINE_DRY_RUN=true` remain intentional production defaults until a controlled live publishing test is approved.

---

## 2026-09-13 — Block 3 — PostgreSQL Durable Data Layer

**Status:** DONE

**Done:**
- Added persistent PostgreSQL durable store and migrations.
- Added durable schema/repositories for brands, social accounts, posts, drafts, publish runs, comments, replies, analytics snapshots, content briefs, agent runs, experiments and approvals.
- Kept Redis as HOT state for locks/leases/cooldowns/dedupe/queues; PostgreSQL is DURABLE state.
- Added durable Meta event and publish projections without storing credentials.
- Provisioned separate persistent PostgreSQL services for EN and RU.
- Set `DATABASE_REQUIRED=true` in production.

**Commits/PRs:** #36 (main), #37 (ru-bot)

**Regression:** 121/121 tests pass

**Changed files/services:** `app/db/*`, `db/migrations/001_core.sql`, durable publish wrapper, `server-meta.js`, EN Postgres, RU Postgres.

**Open questions / external verification:**
- None blocking Block 4. Runtime/startup fail-closed behavior was subsequently hardened and explicitly tested in the pre-Block 4 entry below.

---

## 2026-09-13 — Pre-Block 4 — Railway and PostgreSQL Hardening

**Status:** DONE

**Done:**
- Added explicit regression coverage for required Postgres startup failure and runtime pool failure.
- Confirmed startup failure is fatal/fail-closed and runtime pool failure marks the DB unhealthy.
- Added repository-owned Railway service policy/runbook instead of relying on deprecated `railway.json` behavior.
- Explicitly aligned EN/RU app services to pre-deploy `npm test`, `/health`, 30s health timeout, `ON_FAILURE`, max retries 3.
- Confirmed EN and RU production deploys succeeded with identical hardening tree.
- Staged deletion of obsolete `threads-bot-LdTD` and `verify-threads-bot` services.

**Commits/PRs:** #38 (main); exact tested tree ported to `ru-bot`

**Regression:** 123/123 tests pass

**Changed files/services:** `docs/railway-hardening.md`, `infra/railway-service-policy.json`, `tests/postgresDataLayer.test.js`, EN/RU Railway app config.

**Open questions / external verification:**
- Deletion of `threads-bot-LdTD` and `verify-threads-bot` is staged but requires manual Railway 2FA Apply from the dashboard.
- `npm audit` reported 2 moderate vulnerabilities; backlog, not a Block 4 blocker.
- RU still supports the legacy typo `THREDS_ACCESS_TOKEN` intentionally for backward compatibility.

---

## 2026-09-13 — Block 4 — Analytics Engine

**Status:** DONE

**Done:**
- Added read-only Threads account insights, post insights, and recent-post discovery behind the provider capability boundary.
- Added normalized metrics, derived interactions/engagement rate, and per-entity snapshot deltas/rates.
- Persisted account/post analytics snapshots and discovered posts in PostgreSQL using the existing durable layer.
- Added a capability-driven analytics scheduler with account/post failure isolation and `/health` visibility.
- Enabled production analytics on a 6-hour interval with 25-post/30-day bounds; Publish Engine remains disabled/dry-run and analytics performs no Meta mutations.
- EN live gate passed: 1 account snapshot, 17 recent posts, 17 post snapshots, 0 failures.
- RU live gate passed: 1 account snapshot, 14 recent posts, 14 post snapshots, 0 failures.
- Instagram/Facebook insights remain capability-disabled until their real Meta assets/permissions/tokens are onboarded and verified.

**Commits/PRs:** #39 (main), #40 (ru-bot)

**Regression:** 129/129 tests pass

**Changed files/services:** `adapters/threadsInsightsAdapter.js`, `app/analytics/*`, `app/providers/threadsProvider.js`, `server-meta.js`, `.env.example`, Block 4 docs/tests; EN/RU Railway analytics runtime variables.

**Open questions / external verification:**
- Instagram/Facebook Meta onboarding remains pending; their analytics capabilities must not be enabled until live permissions/assets are verified.
- Deletion of obsolete EN Railway services `threads-bot-LdTD` and `verify-threads-bot` remains staged pending manual 2FA Apply.
- `npm audit` still reports 2 moderate vulnerabilities in the dependency tree; backlog, not a Block 5 blocker.

---

## 2026-09-13 — Block 5A — Approval-gated Content Workflow Core

**Status:** DONE

**Done:**
- Added a durable content workflow repository over the existing `content_briefs`, `drafts`, and `approvals` PostgreSQL tables.
- Added the core `Research/Brief → Draft → Review → Human Approval → Schedule` state machine.
- Enforced confirmed human approval before a draft can enter the existing Publish Engine; scheduling uses a draft-scoped dedupe key and records approval provenance.
- Added fail-closed repository behavior and regression coverage for PASS/REVISE/REJECT, human approval/rejection, and exactly-once enqueue intent.
- Kept runtime behavior unchanged: no new HTTP/admin route, no autonomous content run, no new Meta mutation, and production Publish Engine flags remain disabled/dry-run.
- Ported the exact tested main tree to `ru-bot` without merging divergent histories; EN and RU Railway deployments both succeeded.
- Confirmed the previously obsolete EN Railway services are now deleted; only the app, Redis, and Postgres remain in the EN production project.

**Commits/PRs:** #41 (main); exact tested tree port commit `527436e77a8c9bb37f24fd9fbcdd991b68ac5467` (`ru-bot`)

**Regression:** 137/137 tests pass

**Changed files/services:** `app/content/contentRepository.js`, `app/content/contentPipeline.js`, `tests/contentPipeline.test.js`; EN/RU Railway app deployments.

**Open questions / external verification:**
- Runtime composition/admin boundary for the Content Pipeline is intentionally deferred to the next Block 5 slice.
- `PUBLISH_ENGINE_ENABLED=false` and dry-run protections remain intentional; Block 5A introduced no real scheduled or external publish.
- `astel.us` Meta asset/webhook onboarding remains externally pending and will resume through the authenticated Meta DevTools MCP/Codex audit.
- `npm audit` still reports 2 moderate vulnerabilities in the dependency tree; backlog, not a Block 5 blocker.

---

## 2026-09-13 — Block 5B — Shared AI Gateway, Routing and Budgets

**Status:** DONE

**Done:**
- Added task-aware cheap/standard/reasoning model routing without introducing a second provider boundary.
- Added fail-closed, account-scoped AI token/cost budgets and explicit pricing requirements.
- Added a token-safe OpenAI JSON client and shared AI gateway for brief creation, post generation, and content review.
- Persisted model, token, cost, latency, success/failure and budget-block telemetry to durable `agent_runs`; generated content is withheld if durable telemetry cannot be recorded.
- Kept the layer disconnected from autonomous runtime execution and preserved all publishing/Meta mutation gates.

**Commits/PRs:** #42 (main); exact tested tree subsequently ported to `ru-bot`

**Regression:** 145/145 tests pass

**Changed files/services:** shared content AI gateway/router, budget manager/quota boundary, durable agent telemetry integration, AI gateway regression tests.

**Open questions / external verification:**
- None blocking Block 5C. Production publishing remains disabled/dry-run.

---

## 2026-09-13 — Block 5C — Gated Content Runtime Composition

**Status:** DONE

**Done:**
- Composed the durable content repository, shared AI gateway, approval-gated pipeline, dedicated Redis quota store, and Publish Engine boundary in the production composition root.
- Added `CONTENT_PIPELINE_ENABLED=false` as the disabled-by-default runtime gate.
- Enabled runtime fails closed unless PostgreSQL, Redis quota state, OpenAI configuration, and explicit pricing are ready.
- Scheduling refuses to enqueue while Publish Engine is disabled and a second `CONTENT_ALLOW_LIVE_SCHEDULING` gate protects live scheduling.
- Added content runtime state to `/health` without adding any public/admin mutation route.
- EN and RU production deployments of the tested 5C tree succeeded before Block 5D work began.

**Commits/PRs:** #43 (main); exact tested tree subsequently ported to `ru-bot`

**Regression:** 153/153 tests pass

**Changed files/services:** `app/content/contentRuntime.js`, dedicated AI quota state, `server-meta.js`, `.env.example`, content runtime regression tests; EN/RU Railway app deployments.

**Open questions / external verification:**
- Private operator mutation boundary intentionally deferred to Block 5D.
- `CONTENT_PIPELINE_ENABLED=false`, `PUBLISH_ENGINE_ENABLED=false`, dry-run protections and no-live-scheduling remain intentional.

---

## 2026-09-13 — Block 5D — Private Content Control Plane

**Status:** DONE

**Done:**
- Added a private `/internal/content/*` operator boundary that is mounted only when explicitly enabled.
- Added bearer-token authentication with timing-safe comparison and a minimum 32-byte secret requirement.
- Added mandatory `Idempotency-Key` handling with Redis-backed PROCESSING/COMPLETED/FAILED records, replay of completed operations, and fail-closed handling for duplicate/in-progress/ambiguous state.
- Added private operations for AI brief generation, AI draft generation, AI review, human approval/rejection, and schedule handoff.
- Control startup requires the gated content runtime to already be ready; arbitrary internal errors are not exposed to callers.
- PR #44 passed CI and was merged to `main`; EN Railway deployment and `/health` gate passed.
- Ported the final tested tree to `ru-bot` without merging divergent histories; RU deployment is verified separately as part of Block 5D closure.
- Preserved safety posture: private Content Control API off by default, Content Pipeline off by default, Publish Engine disabled and dry-run, live scheduling blocked, and no new Content Pipeline / Publish Engine Meta mutation was enabled.

**Commits/PRs:** #44 (main); exact tested tree ported to `ru-bot`

**Regression:** 164/164 tests pass

**Changed files/services:** `app/content/contentControl.js`, `app/content/contentControlRouter.js`, `app/content/contentControlStore.js`, `server-meta.js`, `.env.example`, content-control regression tests; EN/RU Railway app deployments.

**Open questions / external verification:**
- None blocking Block 5E. Keep all production mutation gates disabled while Block 5E is developed and tested end-to-end in dry-run.

---

## 2026-09-13 — Block 5E — End-to-End Dry-Run and Operator Read-Side

**Status:** DONE

**Done:**
- Added the complete `Research → AI Brief → AI Draft → AI Review → explicit Human Approval → Scheduler → SIMULATED publish` verification path.
- E2E execution fails closed unless Publish Engine is explicitly enabled in the isolated run and remains `dryRun=true`; the production Publish Engine stays disabled.
- The E2E runner targets only its workflow-specific publish job and never calls a generic scheduler tick that could process unrelated jobs.
- Added authenticated private operator read-side for brief, draft and joined workflow state (brief → draft → latest human approval → publish job).
- Added an idempotent one-shot private E2E dry-run operation plus a complete operator runbook.
- Regression proves the provider `publishPost` mutation boundary is never invoked by the E2E dry-run.
- GitHub CI and EN Railway pre-deploy both passed 171/171 tests; EN `/health` deployment gate passed.
- Production safety remained unchanged: Content Pipeline OFF, Content Control API OFF, Publish Engine OFF + dry-run, live content scheduling OFF, no content-pipeline Meta mutations.
- The exact final tested tree is ported to `ru-bot` without merging divergent histories and verified through the RU Railway health gate as the final closure step.
- Block 5 Content Pipeline is formally complete; Block 6 Hyper Crew Orchestrator may build on these boundaries but must not bypass human approval, idempotency, budgets, or Publish Engine safety gates.

**Commits/PRs:** #46 (main); exact final tested tree ported to `ru-bot`

**Regression:** 171/171 tests pass

**Changed files/services:** `app/content/contentDryRun.js`, `app/content/contentReadModel.js`, Content Runtime/Control/Router, Publish Engine read API, Block 5E tests, `docs/content-pipeline-runbook.md`; EN/RU Railway app deployments.

**Open questions / external verification:**
- None blocking Block 6. Keep production content/control/publish mutation gates unchanged until a separately approved live-content rollout.

---

## 2026-09-13 — Block 6A — Hyper Crew Orchestrator Shell

**Status:** DONE

**Done:**
- Added an immutable `Research → Content Strategist → Copywriter → Content Reviewer → Human Approval` crew graph.
- Human approval is a non-autonomous hard gate and the crew graph rejects any node that claims external mutation ownership.
- Added a disabled-by-default orchestrator over the existing Content Runtime; no second LLM client, model router, budget counter, or AI telemetry stack was introduced.
- The orchestrator delegates brief/draft/review work through Content Runtime and stops at `AWAITING_HUMAN_APPROVAL`; it has no auto-approval, auto-schedule, or publish path.
- Persisted top-level orchestration state through the existing durable `agent_runs` boundary and fail-closed when durable orchestration telemetry cannot be written.
- Added `/health` visibility and `HYPER_CREW_ENABLED=false` as the production gate.
- GitHub CI and EN Railway pre-deploy passed 178/178 tests; EN `/health` deployment gate passed.
- EN production startup verified `hyperCrewEnabled=false`, `contentEnabled=false`, `contentControlEnabled=false`, `publishEnabled=false`, `publishDryRun=true`; Hyper Crew startup was skipped with `HYPER_CREW_DISABLED`.
- Exact final tested tree is ported to `ru-bot` without merging divergent histories and verified through the RU Railway health gate as the closure step.
- No Content Pipeline live publishing or new Meta mutation was enabled.

**Commits/PRs:** #47 (main); exact final tested tree ported to `ru-bot`

**Regression:** 178/178 tests pass

**Changed files/services:** `app/orchestration/*`, `server-meta.js`, `.env.example`, `tests/hyperCrewOrchestrator.test.js`, `docs/hyper-crew-orchestrator.md`; EN/RU Railway app deployments.

**Open questions / external verification:**
- None blocking Block 6B. Keep `HYPER_CREW_ENABLED=false` and all content/control/publish mutation gates unchanged until separately approved.

---

## 2026-09-13 — Developer Tooling — Codebase Memory MCP

**Status:** DONE

**Done:**
- Added repository-owned bootstrap scripts for Codebase Memory MCP on Windows and macOS/Linux.
- Pinned the reviewed upstream installer source and kept the integration developer-only; it does not run inside the Astel Social Engine production service.
- Added automatic repository indexing/watch configuration and documented Claude Code / Codex CLI integration and local verification steps.
- Confirmed PR #45 was merged but had not been represented in this handoff log; this entry repairs that synchronization gap.
- Strengthened the logging rule above so implementation/deployment alone is not considered a complete handoff state.

**Commits/PRs:** #45 (main); tooling files are present in the exact shared EN/RU tree

**Regression:** Developer-only tooling change; no runtime behavior change. Current shared application tree passes 178/178 tests.

**Changed files/services:** `tools/setup-codebase-memory.ps1`, `tools/setup-codebase-memory.sh`, `docs/CODEBASE_MEMORY.md`, `docs/AGENT_LOG.md`; no production service or Meta configuration change.

**Open questions / external verification:**
- Local workstation installation and `/mcp` verification in Codex/Claude remain pending until a developer machine is available.

## 2026-09-13 — Astel US onboarding foundation (in progress)

**Status:** Phase A audited; isolated US configuration and shared-code hardening prepared. Meta operational validation remains blocked on securely provisioned credentials and development webhook delivery.

**Done:**
- Verified app 1991615571550659 remains in Development; portfolio 1069900484139703. Target IG astel.us 17841473220032439 links to Page Олег Акастелов 656083597578810.
- Confirmed existing main/ru-bot baseline tree equality and healthy deployments. Existing Block 5 is complete; no Hyper Crew expansion.
- Added signed IG/Page webhook ingress, strict target routing, malformed-array handling, account isolation profile, required durable persistence gate, post-mutation ambiguity hold, confirmed reply text persistence and per-account publishing dry-run enforcement.
- Added dedicated US nonsecret environment profile and factual onboarding audit/runbook.
- Created isolated Railway project astel-us (f47f4c43-ff54-49bf-8939-bf18a90554ed), production a77130b6-3bd2-4673-adf9-12fd8697abd0. Service/dependency provisioning follows validated code.

**Regression:** 190/190 local tests pass (baseline 178; 12 added). Local Node24.19.0/npm11.17.0; pinned CI24.20.0/11.19.0 required before merge. New tests use synthetic credentials and mocked Meta mutations; no real replies.

**Commits/PRs:** Feature branch codex/astel-us-onboarding; PR/CI/deployment evidence will be appended after verification.

**Changed services:** New isolated empty US project only at this checkpoint. No existing service config/Meta settings changed; no tokens copied.

**External blockers:** Astel app secret, Page/IG token grants/validity/expiry and OpenAI/brand knowledge configuration must be securely provisioned. No app webhooks currently subscribed. Real inbound dry-run and first approved replies pending. Privacy policy/category/icon, App Review and business legal verification remain incomplete. IG/FB publishing and insights providers remain unsupported.


## RU Instagram comments polling — 2026-10-23

Branch fix/ru-instagram-comments-20261023 is based strictly on deployed ru-bot SHA 83b64f766f7996e82ed46b3de7e7f40c135b324d. Reuses the existing main/Leo Instagram polling and Redis store implementation, without US calendar or Facebook automation. Adds explicit Instagram Login host selection, identity/media/comment reads, polling event normalization, and a thin runtime wrapper around the complete original server-meta startup. Facebook Graph remains the adapter default for existing unspecified flows; RU rollout must set INSTAGRAM_AUTH_MODE=instagram_login.

Original Threads provider and PR75 regression tests are unchanged. Signature verification, safety limits, durable gates and account knowledge context are unchanged. First polling cycle primes prior comments without replying. Publication/calendar engines remain governed by existing disabled settings.

215 isolated tests passed locally on Node20.14.0/npm10.7.0, including shared priming/dedupe/read-failure tests and new account host/identity and full-runtime delegation regressions. Exact Node24.20.0/npm11.19.0 CI remains required before rollout. No production credentials in tests. Rollback baseline is 83b64f766f7996e82ed46b3de7e7f40c135b324d / deployment a11d9ce1-e37a-404a-b15a-eb026e5a390c.
