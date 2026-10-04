# YouTube Community V1: Gate 1–3 only

Issue: https://github.com/asteloleh-gif/threads-bot/issues/71
Baseline: `81338658909d8dc2ada8bea7b999c8348d504c6f` (main, 2026-10-04).

## Release boundary

This build adds read-only ingestion and draft review for **ASAP GTA6**. It cannot publish YouTube replies, posts, or moderation actions. `reply()` and `publishReply()` always return `LIVE_TRANSPORT_DISABLED`; `LIVE_APPROVED`, `YOUTUBE_DRY_RUN=false`, and even a valid approval cannot enable writes. There is no Data API POST/PATCH/DELETE transport. OAuth refresh is the only POST and uses the official token endpoint.

The verified public target is `UCY_Gljo9NHXbXQv-vT_PWTA` / `@ASAPGTA6`. Application composition enforces this target in addition to the configured-channel/OAuth identity comparison. A Family/Meta/vidIQ account cannot substitute. A public or Studio channel identity is not an OAuth Gate 2 pass.

## Additive architecture and safety reuse

- YouTube is a separately named `asap-gta6:youtube` account appended **after** existing Meta brand-isolation checks. Meta defaults and entrypoints remain intact.
- `youtubeProvider` reads official channel/comment endpoints, pins exactly one `channels.list(mine=true)` identity, requires complete response shapes, and exposes sanitized health. Pin mismatch/empty/multiple identities fail closed before comments are read. Token refresh is deduplicated; scopes come from the returned grant, never a claimed environment flag.
- `youtubeCommentPoller` uses channel-wide `commentThreads.list`, full `comments.list(parentId=topLevelCommentId)` hydration when embedded replies are incomplete, and pagination. No search endpoint or comment webhook assumption is used.
- First start primes the entire bounded scan with no handler calls. Partial/malformed hydration never certifies a baseline. Redis seen/known sets have TTL; durable prime metadata and a sentinel ensure missing/expired state causes a safe full re-prime. Historical items are not blasted after restart. Periodic full scans discover replies on older threads; newly discovered items are processed oldest first. Transient failures remain retryable.
- `createYouTubeCommunityRuntime` wraps the existing community engine rather than duplicating reservations, source dedupe, graph/branch leases, cooldown, global cap, bot/self guards, human locks, and ambiguity protection. It forces dry-run and `normalReplyLimit=1`, keys conversation budget by top-level comment, and uses a dedicated channel/account/draft namespace.
- Only new top-level viewer comments can be drafted. Sibling replies always require human review, including siblings in already-answered threads. Creator-answered top-level comments are skipped. No nested reply relationship is inferred.
- The deterministic pre-GPT classifier routes risks/ambiguous comments to review or skip. It is a conservative heuristic, not a complete abuse detector; every produced draft still requires owner review. Content ideas are flagged.
- The ASAP persona is separate from Leo. It matches the comment language, asks for 1–2 sentences/at most one emoji, rejects unsupported facts, and distinguishes theory from verified evidence. Meta KB/persona memory is never loaded. The current server injects **no approved ASAP KB**; factual questions must remain uncertain/clarifying drafts. Connecting a verified ASAP evidence source is a later configuration task.
- Mandatory durable Postgres projection uses existing `comments` and `drafts` tables. Draft text/model/usage/intent/channel/video/source/content-seed/consent/timestamp/retention metadata is persisted before shared Redis dedupe is committed. Deterministic draft IDs preserve candidates across retries. Non-draft decisions use a separate deterministic ID, so a later Redis failure or duplicate cannot erase a pending draft. No secret/raw OAuth response is logged.

## Configuration (all secrets remain in runtime env)

See `.env.example`. Defaults: YouTube disabled; polling disabled; DRAFT_ONLY; 60s interval; 100 items/page; full reconciliation every 10 cycles; 20/day future reply cap; 9000 estimated API units/day. `OFF` disables this account. No configuration changes, new grants, credentials, tokens, or deployments were performed for this implementation.

Required for a controlled operational read/draft session:
1. Existing explicitly authorized ASAP OAuth credentials in `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`; exact `YOUTUBE_CHANNEL_ID` above. Never paste secrets into repository, logs, Airtable, or review artifacts.
2. Healthy Redis and Postgres, plus the existing model route if drafting is requested. Missing stores fail closed.
3. Owner-controlled activation of `YOUTUBE_ENABLED` and, separately, `YOUTUBE_POLLING_ENABLED`. This release does not activate them.
4. Data-retention operation: refresh or delete stored YouTube API data within 30 days. Draft metadata records `refreshOrDeleteBy`; this patch does not install a destructive retention scheduler. Before sustained operation beyond a controlled session, configure the approved refresh/deletion process. Do not retain raw viewer input indefinitely or publish it into the public repository.

`node scripts/youtube-community-readiness.js` performs only identity + a comment-list read, prints sanitized readiness/counts, and closes its quota connection. It does not start Meta, a model, or polling. Disabled/unconfigured exits 2. This script was run here only with YouTube disabled; no live OAuth/API probe was performed.

`GET /health/youtube-polling` reports providers, sanitized auth/scope/pin/quota state, polling state, and community readiness. Enabled polling is ready only with fresh pinned identity, successful priming, running polling, healthy stores, and no failed latest cycle. Disabled is healthy-disabled, not ready-to-run. Tokens are never included.

## Quota and consent

The shared-project Redis quota ledger reserves before calls, counts every page and failed request, and never refunds an uncertain request. Channels/comment lists cost 1; the future write reservation primitive costs 50 and enforces the cap. Daily boundaries use `America/Los_Angeles`, including DST. No quota sharding across projects/accounts/modes.

Consent validation requires channel, feature, mode, explicit scope, reviewer/source/timestamp, bounded start+expiry, and max replies/day. Missing/expired/mismatched consent yields drafts. Valid consent also yields drafts because transport is hard disabled. No durable approval is created from an SOP or environment string. Gate 4/5 require a separately authorized implementation/release and explicit bounded action approval; this patch deliberately omits live-insert/ambiguous-response/readback integration.

## Gate evidence and limitations (2026-10-04)

| Gate | Result |
| --- | --- |
| 1 | Local code/tests pass; no live write. Baseline 246 tests passed, expanded tests and independent adversarial review were run. See final implementation manifest for exact count/SHA. |
| 2 | **Blocked.** Exact public/browser ASAP identity was observed, but no module OAuth `channels.list(mine=true)` probe/scope verification succeeded. Existing known deployed services had no YouTube variable names at inspection time; this is not a claim that credentials do not exist elsewhere. |
| 3 | **Incomplete.** Only 4 real viewer top-level inputs were available in the observed published inbox; 2 already answered, 2 need contextual human review. Viewer channel IDs/exact timestamps unavailable in browser evidence, so 0 were passed to the module as verified API inputs. No 20-real-reply batch exists; Oleg review is pending. |
| 4/5 | Out of scope and technically disabled. No live replies, pilot, deployment, or activation. |

`docs/fixtures/youtube-community-20-synthetic.json` contains 20 clearly marked authored synthetic examples for local classifier/persona/output-shape QA. They are not real YouTube comments, not model-call results, not owner-reviewed, and do not count toward Gate 3. Real source inputs/review candidates remain private outside this public checkout.

Tests use mocked official-API/Redis/Postgres/model responses; no external state is changed. Existing Meta regressions are included. Available local toolchain was Node 24.19.0 / npm 11.9.0; repository declares Node 24.20.0 / npm 11.19.0. Exact pinned CI remains a separate verification requirement. No full live Redis/Postgres deployment test was run.

## Official references checked 2026-10-04

- [Thread list](https://developers.google.com/youtube/v3/docs/commentThreads/list): channel-wide filter, published moderation filter requires authorized request, quota 1.
- [Reply list](https://developers.google.com/youtube/v3/docs/comments/list): top-level parent, pagination, quota 1.
- [Reply insertion](https://developers.google.com/youtube/v3/docs/comments/insert): future scope `youtube.force-ssl`, quota 50; disabled in this build.
- [Comments implementation](https://developers.google.com/youtube/v3/guides/implementation/comments): hydrate incomplete embedded replies.
- [Server-side OAuth](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps): existing refresh grants only.
- [Quota](https://developers.google.com/youtube/v3/determine_quota_cost): Pacific reset, each request/page counted.
- [Push notifications](https://developers.google.com/youtube/v3/guides/push_notifications): video upload/title/description, not comments.
- [Developer policies](https://developers.google.com/youtube/terms/developer-policies): specific action consent and refresh/delete API data within 30 days.
- [Spam policy](https://support.google.com/youtube/answer/2801973): avoid repetitive/high-volume comment behavior.
