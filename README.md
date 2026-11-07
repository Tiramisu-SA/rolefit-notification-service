# RoleFit Notification Service

Consumes application-status events from RabbitMQ, stores an idempotent delivery inbox in its own PostgreSQL database, and sends text/HTML email via configurable SMTP. Mailpit is the default local destination. It has no public notification creation API and does not query Application's database.

## Local setup

Requires Node.js 22+. Place this repo beside `rolefit-application-service` and run `npm ci` in both repos. Start the shared Docker stack from Application's directory with `docker compose up -d --build`; seed applications there with `docker compose exec application node dist/src/seed.js`. Migrations run automatically in each service container.

For host-side Node development, start only infrastructure, stop the container notification service to free port 3005, copy `.env.example` to `.env`, run `npm run migrate`, then `npm run dev`. `npm run build && npm start` runs compiled code. `npm run seed` explains that deliveries must originate from events and intentionally creates no fake delivery jobs.

Read [API.md](API.md) for topology, schemas, and failure behavior. The event JSON Schema is copied verbatim from Application's canonical contract. Do not change it independently.

## Persistence and recovery

An event is acknowledged only after inserting its delivery job. A unique event ID makes replay an insert no-op. A single worker claims pending jobs with a 60-second processing lease and retries transient SMTP failures after 10, 30, and 60 seconds. After four sends or a permanent SMTP 5xx rejection the record stays failed. Expired leases are recovered after restart. One delivery worker is supported for this prototype.

`sent` means SMTP accepted the message, not that the end user opened it or that a real provider placed it in the inbox. Stable Message-ID and inbox deduplication reduce duplicates, but a crash after SMTP acceptance and before database recording can cause a second send. This does not promise exactly-once delivery.

The local stack uses persistent volumes for PostgreSQL, RabbitMQ, and Mailpit. Run `docker compose stop` from Application's repo to stop without erasing data.

## Logs and request id

Logs are JSON, one object per line. The id of the request that caused an event arrives as the AMQP correlation id, is stored in `notification_deliveries.request_id`, and is written as `requestId` on the lines for receiving the event and for each delivery attempt. A missing or unsafe correlation id is dropped and the event is still processed. Logs never contain the recipient or raw SMTP errors.

## SMTP configuration

`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional `SMTP_USER`/`SMTP_PASSWORD`, `SMTP_SECURE`, and `SMTP_REQUIRE_TLS`. `SMTP_SECURE=true` selects implicit TLS (typically port 465); `SMTP_REQUIRE_TLS=true` requires STARTTLS for providers that use it. TLS certificate verification remains enabled. Local Mailpit uses port 1025 without TLS/authentication. Store credentials only in ignored environment files or deployment secrets. Real provider setup, sender/domain verification, and real-recipient delivery testing are future work.

## Hosted PostgreSQL later

Configure a dedicated Notification database/user with `DATABASE_URL`, `DATABASE_SSL=true`, and an optional `DATABASE_CA_FILE`. Run the same migrations; move existing records with an explicit database transfer if desired. Never use Application's private database or share credentials between services.

## Health and checks

HTTP port 3005 exposes `/health` (liveness) and `/ready` (PostgreSQL and RabbitMQ availability). SMTP outages are handled through durable retries and do not block consuming events into the inbox. Read delivery records (`status`, `attempts`, `next_attempt_at`, `lease_until`, `last_error`, `sent_at`) and safe logs to inspect failed jobs/backlogs. No JWTs or raw connection strings are logged.

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run validate:contracts`. The Application repo owns `npm run test:integration` for the complete local stack; install dependencies here before running it. See `VERIFICATION.md` for actual results. GitHub repository: [rolefit-notification-service](https://github.com/Tiramisu-SA/rolefit-notification-service). Clone it beside `rolefit-application-service` for the shared Compose setup.
