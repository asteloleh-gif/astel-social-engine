# Astel US Copilot — publication calendar

This module adds a publishing calendar to the existing Astel US service. It does not replace or disable Threads/Instagram comment auto-replies. Facebook automation and Meta Development Mode are unchanged.

## Operator interface

Airtable base `Astel US — Social Copilot` now has a separate `Publication Calendar` table and `Astel US Copilot — Publishing` interface. Existing knowledge, settings and comment tables are not changed.

- Calendar page: https://airtable.com/app7IZzXzjJaPE7bL/paghHjeFb1PplWRUe
- Queue/editor: https://airtable.com/app7IZzXzjJaPE7bL/pag9udjOqZZFSmkaQ

One row is one publication to one platform. Use separate rows for cross-posting. Fill Title, Platform, Format, Caption, Scheduled At, Delivery Mode, Revision (start at 1). Instagram additionally requires a public direct media URL. Times display in `America/Chicago`; scheduling is stored as UTC instants. The first release is **simulation-only**.

1. Select `Request review` in Approval. Railway validates the payload and stores its immutable fingerprint in PostgreSQL.
2. Wait for `AWAITING_APPROVAL`. Inspect the content/time/mode, enter Reviewer and select `Approved`.
3. A future job becomes `SCHEDULED`; a due Simulation job becomes `SIMULATED`. It must have no Published ID.
4. `Cancelled` withdraws pending approval. Edits after review invalidate it: request review again.
5. To intentionally create another version after terminal completion, increment Revision and request a new review. Never clear IDs or statuses to force a retry.

`Result`, `Review Hash`, `Job ID`, `Published ID`, `Published URL`, `Error`, and `Last Checked` are engine-owned evidence, not input controls. The database, not editable Airtable status text, owns delivery state.

## Supported publishing contracts

- Threads: text-only posts, conservative 500 UTF-8-byte limit.
- Instagram: one JPEG image or one MP4 Reel and caption; no text-only Instagram, carousels, Stories or Facebook.
- Instagram media must be publicly accessible directly when Meta processes it. Google Drive preview/share links are not media URLs. This module does not render/generate video or supply permanent media hosting.
- The calendar accepts prepared text/media. It does not automatically run AI generation; the older AI Brief/Draft/Review pipeline remains separate and unchanged.

## Runtime

New server module `app/calendar/runtime.js` runs in `server-meta-runtime.js`, after the existing comment pollers start. It reuses the existing connected PostgreSQL store and credential configuration, but has independent switches, publishing provider wrappers and one new table `astel_calendar_jobs_v1`.

Only the following new variables are required for Astel US:

```env
CALENDAR_ENABLED=true
CALENDAR_BRAND=astel.us
CALENDAR_LIVE_ENABLED=false
CALENDAR_AIRTABLE_BASE_ID=app7IZzXzjJaPE7bL
CALENDAR_AIRTABLE_TABLE_ID=tblUwybtXXAT8IRoF
CALENDAR_POLL_INTERVAL_MS=60000
```

Keep all existing `BOT_*`, `THREADS_*`, `INSTAGRAM_*`, `FACEBOOK_*`, `CONTENT_*` and `PUBLISH_*` flags unchanged. Do not copy tokens into code, issues, Airtable records or logs. Existing `AIRTABLE_API_KEY` must have read/write permission for the new table. Calendar initialization errors are reported independently rather than crashing comment auto-replies.

A disabled Calendar does no work. Runtime activation is restricted to the exact `astel.us` brand and its two existing usernames. Changing a record to `Live` does **not** enable publishing: a simulation-only runtime reports `BLOCKED_LIVE_RELEASE`.

## Durability and delivery safety

The same tested Publish Engine orchestrates jobs; a new PostgreSQL repository provides immutable reviewed versions, explicit approval, due-time checks, atomic claims, leases, durable container checkpoints and terminal result storage. Airtable is the editor/calendar, not the delivery lock.

Before dispatch and immediately before external mutation, the worker re-reads the exact approved row and verifies content hash, reviewer, schedule and lease. A job over one hour late is held for review instead of flushing historical content. A Simulation job remains a simulation even after a later runtime live release.

Meta account ID/username and current quota are checked before a live operation. Creation ID and publish intent are persisted before publishing. Media container readiness is polled with bounded waits. Unknown network/5xx/429 publish outcomes and expired processing leases become `AMBIGUOUS_HOLD` and are never automatically republished. A result writeback error retries only the Airtable result, not the post.

The source of truth for completed deliveries is PostgreSQL. `PUBLISHED` requires a Meta ID. Media readback is a separate confirmation; its failure cannot trigger a duplicate. Exactly-once semantics across arbitrary network failures are not promised: uncertain outcomes are quarantined.

## Diagnostics and tests

Read-only endpoint: `/health/publication-calendar`. It shows mode, initialization, store readiness, cycle timestamps, errors, counts and separate read-only Meta identity/quota probe outcomes. A successful read-only probe is **not** proof of the `instagram_content_publish` grant or a successful post.

```sh
npm test
# Additional real PostgreSQL integration requires a disposable LOCAL database only:
CALENDAR_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/calendar_test npm test
```

CI provisions disposable PostgreSQL and runs the complete regression suite. Contract tests mock all Meta mutations. Production canaries initially use Simulation rows only, so they validate Airtable → review → approval → due queue → durable simulation → writeback without sending content to Meta.

## Release and rollback

Deploy a tested commit to the existing Astel US service only, not shared `main` consumers. Preserve the previous deployment for rollback. Leave `CALENDAR_LIVE_ENABLED=false` until the owner approves exact first-post content, account/media ownership and the live test. Check actual publishing scopes with the account's authorization flow if Meta rejects them; do not rotate working comment credentials blindly or switch apps to Live Mode.

Calendar-only stop: set `CALENDAR_ENABLED=false` and deploy the same tested build. This is separate from comment auto-reply switches. Do not drop its PostgreSQL table or clear history/leases. Reverting to the previous service deployment is the code rollback and leaves the additive table intact.
