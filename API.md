# Notification Service Events

Local internal health address: `http://localhost:3005`. SMTP destination by default: Mailpit (`localhost:1025`, inbox `http://localhost:8025`). Source of truth: `contracts/application.status.changed.v1.schema.json`; the canonical copy lives in Application Service. Health endpoints are documented in `openapi.yaml`. GitHub repository: [rolefit-notification-service](https://github.com/Tiramisu-SA/rolefit-notification-service).

## Responsibility

Receive application status-change events, persist delivery jobs, and send candidate emails. Only application status changes are supported. No deadline scheduler, in-app notification UI, resume/matching calls, public send endpoint, or real email provider integration is included.

The gateway calls Application Service. It does not call Notification to trigger status email; Application publishes the event after committing the business change. Notification never reads Application's private database.

## RabbitMQ topology

| Resource             | Name / settings                                                     |
| -------------------- | ------------------------------------------------------------------- |
| Event exchange       | `rolefit.events`, durable topic                                     |
| Routing key          | `application.status.changed.v1`                                     |
| Consumer queue       | `notification.application-status.v1`, durable                       |
| Dead-letter exchange | `rolefit.deadletters`, durable direct                               |
| Invalid-event queue  | `notification.invalid.v1`, durable, bound with the same routing key |
| Message properties   | Persistent, `application/json`, `messageId` equal to event ID       |
| Consumer             | Manual acknowledgement, prefetch 1                                  |

Both services declare the same topology idempotently. Malformed JSON, schema-invalid events, and events whose previous/new statuses are equal are rejected without requeue and dead-lettered. This single-node development topology is not a highly available broker deployment. Classic-queue dead-letter forwarding does not provide a separate publisher-confirm guarantee during broker failures.

## Event payload

All listed properties are required, no additional properties are allowed:

| Field                                   | Meaning                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `eventId`                               | UUID, immutable deduplication key                                |
| `schemaVersion`                         | Integer `1`                                                      |
| `eventType`                             | Exactly `application.status.changed.v1`                          |
| `occurredAt`                            | ISO-8601 UTC date-time                                           |
| `applicationId`, `jobId`, `candidateId` | Nonempty identifiers, max 200 characters each                    |
| `recipient.name`                        | Candidate display name, 1–200 characters                         |
| `recipient.email`                       | Valid email address, max 254 characters                          |
| `jobTitle`                              | 1–200 characters                                                 |
| `previousStatus`, `newStatus`           | `Submitted`, `Under review`, `Interview`, `Offer`, or `Rejected` |

The event intentionally excludes resume files/references, match details, JWTs, and recruiter notes. The sender determines recipient/job details from the stored application; callers cannot specify a destination in the status-update request. Changing the schema requires coordinated producer/consumer updates; breaking changes need a new version/routing key.

Illustrative example (not a claim of live production data):

```json
{
  "eventId": "26ec5af5-7cef-434b-9fe9-dc4f37e00455",
  "schemaVersion": 1,
  "eventType": "application.status.changed.v1",
  "occurredAt": "2026-10-11T00:00:00Z",
  "applicationId": "app_demo_brightline",
  "jobId": "job_seed_frontend",
  "candidateId": "seeker-demo",
  "recipient": {
    "name": "Sample candidate",
    "email": "seeker-demo@example.test"
  },
  "jobTitle": "Frontend Engineer (sample)",
  "previousStatus": "Submitted",
  "newStatus": "Under review"
}
```

## Acceptance, delivery, and retries

1. Validate the event, then insert a delivery record keyed by `eventId`. A duplicate preserves the existing record, including its state and original payload.
2. Acknowledge RabbitMQ only after PostgreSQL accepts the insert. On storage failure, close the consumer channel so unacknowledged events are redelivered after reconnect.
3. A single worker leases a pending job for 60 seconds, increments its attempt count, and sends both text and escaped HTML email. The subject identifies the job; the body shows the previous/new status and application ID.
4. Mark `sent` only after SMTP accepts the recipient. Transient failures are retried after 10, 30, and 60 seconds (four total send attempts). SMTP 5xx rejection fails immediately. Failed records remain stored for inspection; automated failed-job replay is not included.
5. Recover expired in-progress leases after restart. A stable Message-ID is used, but SMTP is not transactional with PostgreSQL: a crash between acceptance and recording may cause duplicates. Delivery is not exactly once.

Broker confirmation, inbox acceptance, and email acceptance are distinct stages. `notificationQueued` in Application's response means only that its outbox transaction committed. A `sent` delivery record means SMTP acceptance, not guaranteed inbox placement by a future real provider.

## Internal health HTTP

| Endpoint      | Meaning                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health` | 200 with `{ status: "ok", service: "notification" }` while the process runs                                                     |
| `GET /ready`  | 200/ready only when PostgreSQL and RabbitMQ are available; otherwise 503/unavailable; includes `database` and `broker` booleans |

No caller identity is needed for these internal health checks. Other paths return 404 with the standard error envelope. The gateway should not expose this service publicly. SMTP downtime does not prevent inbox acceptance; inspect failed/pending records and logs for delivery problems.

## Configuration and ownership

`DATABASE_URL` points to Notification's own database. `DATABASE_SSL=true` enables certificate verification; `DATABASE_CA_FILE` can supply the provider CA. `RABBITMQ_URL` supplies broker connection settings. SMTP settings are listed in `.env.example` and README. Cloud accounts, sender/domain verification, hosted database provisioning, and real email delivery are not part of this local implementation.

## Verification

Unit checks cover HTML escaping, retry policy, durable acknowledgement ordering, and invalid-event rejection. Shared integration checks in Application's repository exercise real PostgreSQL, RabbitMQ, SMTP/Mailpit, dependency outages, replay, routing failure, dead-lettering, and restart persistence. Retry exhaustion/permanent rejection are injected sender errors against real durable records. None of these checks exercise Supabase authentication through the gateway.
