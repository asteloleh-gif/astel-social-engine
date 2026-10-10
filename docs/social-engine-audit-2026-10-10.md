# Astel Social Engine — production audit and service binding map
Audited: 2026-10-10 (America/Chicago). Sources: live Railway service configs/logs, GitHub, Meta Developer, read-only health endpoints. This is a point-in-time operational record, not an E2E guarantee.

## Fixed boundary: one brand per engine

| Brand | Live Threads | Live Instagram | Facebook | Railway app | Git branch | Meta App ID |
| --- | --- | --- | --- | --- | --- | --- |
| astel.u (RU) | Enabled, reply publish failing 400/code 24 | NOT CONFIGURED | NOT CONFIGURED — DO NOT ENABLE | `threads-bot-ru / threads-bot-ru` | `ru-bot` | `1877142033249783` |
| leoakastel (EN) | Enabled, published replies seen | NOT CONFIGURED | NOT CONFIGURED — DO NOT ENABLE | `remarkable-celebration / threads-bot` | `main` | `971694839284344` |
| astel.us (US) | Enabled, polling running | Enabled, polling running (historical production canary verified) | Configured but **intentionally DISABLED** — DO NOT ENABLE | `astel-us / copilot-astel-us` | `main` | `1991615571550659` |

Main repository: `asteloleh-gif/threads-bot`. Current engine architecture is one primary Threads identity and optionally one Instagram and one Facebook account per service, not nine verified live integrations.

**User decision (2026-10-10): Facebook is out of scope, intentionally disabled; do not turn on Facebook accounts, polling, replies, webhooks or publishing. Do not report its intentionally disabled status as a new outage.**

## Confirmed read-only results

- RU `/health` reported `enabled=true`, `dryRun=false`, Redis/Postgres ready, accountKey `astel.u:threads`. Railway logs showed two separate Threads callbacks on Oct 10, AI reply generation and `Threads publish error: 400 24`, then `DEFINITIVE_PUBLISH_FAILURE`. No reply ID was published for those events.
- `leoakastel` `/health` reported enabled with dry-run off; production runtime logs on Oct 9–10 contain concrete published reply IDs. Its Threads polling health reported `enabled=false` (webhook-dependent). Redis timeouts occurred intermittently on Oct 9–10.
- `astel.us` `/health` showed Threads and Instagram providers enabled, dry-run off, configured; its Facebook provider `enabled=false`. Threads polling and Instagram polling health were enabled/primed with recent successful reads and zero new comments. `astel.us` Facebook polling health returned HTTP 503 despite its provider being disabled; fixing the code-level enable gate prevents false failures without switching on Facebook.
- `astel.us` Instagram source-of-truth runbook `docs/instagram-astel-us-live-runbook.md` documents a true live canary on 2026-09-16. It does not prove the current cycle published anything.
- Generic Meta DevTools webhook subscriptions showed `instagram/comments`, `page/feed`, and empty `user` subscription for Astel US; zero generic subscriptions for the RU and Leo Meta apps. This generic query does not establish whether the product-specific Threads webhooks are subscribed; real RU and Leo events arrived in Railway.
- All three Meta apps were in Development mode, not live. Production ingress for US Instagram and Threads uses official Graph polling. Do not alter webhook subscriptions or permissions without an account-identity verification.
- RU production still deploys the old `ru-bot` commit from 2026-09-13; main/US deploys were last published on 2026-09-23. US Railway also has a separate staged patch with 42 changes for a YouTube service, **not** an authorized Social Engine rollout. Do not accept/deploy this patch to fix social replies.

## Repair plan implemented in code, not yet deployed

- Common verified reply publishing helper for both RU and main: uses Bearer auth for publication; on HTTP 400/code 24 reads the exact existing container's status; retries **the same container ID** at most once only after positive state verification; holds any unknown/ambiguous result; logs redacted Meta subcode/error.
- Existing Redis deduplication, branch leases, and human locks remain unchanged. Failed/ambiguous replies are not blindly recreated.
- `server-meta-runtime.js` main branch gates Threads/Instagram/Facebook polling activation by individual account `enabled`. Disabled Facebook remains disabled, with no polling calls.
- CI regressions cover successful posts, same-container controlled retry, unknown/published container hold, permission rejections, network/server errors, token sanitization, and disabled-platform poller.

Proposed PRs:
- Main (Leo + astel.us): https://github.com/asteloleh-gif/threads-bot/pull/72
- RU: https://github.com/asteloleh-gif/threads-bot/pull/73

## Optional Instagram connections, deferred until asset-specific secrets

The old runbook `docs/meta-3-platform-account-onboarding-runbook.md` lists verified business-portfolio Instagram/Page asset pairs for `astel.u`, `leoakastel`, `astel.us`. A historical asset ID is **not** authorization to copy an Astel US Page access token to a different brand. RU and Leo services currently lack `INSTAGRAM_*` env variables. No credentials were transferred, and no missing Instagram is marked live.

To connect each owned Instagram identity: verify professional-account/Page pairing and exact identity with official Graph reads, install brand-specific token in the matching Railway service securely, enable only Instagram polling in dry-run, prime historical comments, send one test external comment, require a `WOULD_REPLY`, then separately confirm one real published reply and the anti-loop guard. Do not enable Facebook as part of this workflow.

## Monitoring semantics

Per-account outcomes must be `NOT_CONFIGURED`, `DISABLED_BY_CHOICE`, `DRY_RUN`, `INGRESS_OK_NO_EVENT`, `AI_GENERATED_NOT_PUBLISHED`, `PUBLISHED_CONFIRMED`, `API_REJECTED`, `AMBIGUOUS_HOLD`, or `INFRA_DOWN`. `/health ok` and `webhook 200` are liveness, **not** successful E2E bot replies. Alert on new errors, not the deliberately disabled Facebook status.

## Production release gate

No production service must be called repaired until CI passes, review is complete, live deployments are updated deliberately, and a fresh external canary produces one published reply ID. No global staging changes, token rotation, Meta App Review, or Facebook activation is part of this patch.
