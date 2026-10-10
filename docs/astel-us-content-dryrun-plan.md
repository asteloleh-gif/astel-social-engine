# Astel US Copilot — Content Pipeline safe initialization

Scope: ONLY Astel US Copilot (`@astel.us`). Preserve both existing Threads and Instagram comment auto-reply pipelines. Do not enable Facebook or alter the three Meta apps' Development Mode.

## Current confirmed code boundaries

- `app/content/contentPipeline.js`: text-only draft normalization; AI brief, draft, review, human approval and scheduling.
- `app/content/contentRuntime.js`: runtime wiring for content.
- `app/publishing/publishEngine.js`: scheduler, job lease and publishing orchestration.
- `adapters/threadsPostPublisher.js`: Threads text posts.
- `app/providers/instagramProvider.js`: `publishPosts: false` — Instagram posts/Reels are **not** ready.
- `docs/content-pipeline-runbook.md`: current operator workflow and isolated dry-run test path.

## Safety invariants

Production remains fail-closed:
```env
CONTENT_PIPELINE_ENABLED=false
CONTENT_CONTROL_API_ENABLED=false
PUBLISH_ENGINE_ENABLED=false
PUBLISH_ENGINE_DRY_RUN=true
CONTENT_ALLOW_LIVE_SCHEDULING=false
```
These are **required intended values**, not verified runtime values: Railway OAuth returns variable names only. Do not assume they are already set to these values or change them blindly.

Never modify `BOT_ENABLED`, `BOT_DRY_RUN`, `THREADS_*`, `INSTAGRAM_ENABLED`, `INSTAGRAM_POLLING_*`, `FACEBOOK_*`, existing tokens, webhook routes, or provider comment-reply behavior as part of dry-run testing.

## Isolated acceptance test

1. Use a test-only injected/in-memory runtime, never production credentials or Meta write APIs.
2. Exercise `Research → AI Brief → AI Draft → AI Review PASS → Human Approval APPROVED → Schedule → Publish Engine dry-run → SIMULATED`.
3. Verify every transition, account isolation, idempotency and durable event recording.
4. Confirm `publishPost` was never invoked, no real Threads or Instagram content was created, and the workflow ends in `SIMULATED`.
5. Verify negative paths: no approval, rejected review, disabled engine, unsupported Instagram publishing, ambiguous provider outcome and retry safety.
6. Run `npm test` in isolated CI; no live deployments.
7. Before production enablement, independently read the actual flag values via an authorized operator. A named human must approve any real publishing canary.

## Subsequent development

A. Implement Instagram photo/video/Reels publisher behind `publishPosts: false` until permissions, readiness polling, idempotency, and contract tests pass.
B. Add a human-approved scheduling interface (Airtable or private Content API), with explicit `accountKey`, platform, content type, timezone, and media ownership.
C. Do not activate the live publish engine until one approved, observable end-to-end canary succeeds for each supported platform.

## Verification and ownership

Source repository: `asteloleh-gif/astel-social-engine`, branch `main` for Astel US.
Railway project: `astel-us-copilot`, service: `copilot-astel-us`.
Only three live services are expected in this project: Copilot, Redis, PostgreSQL.
