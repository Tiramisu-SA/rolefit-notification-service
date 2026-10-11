CREATE TABLE notification_deliveries (
 event_id uuid PRIMARY KEY, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 lease_token uuid, last_error text, received_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries(next_attempt_at) WHERE status IN ('pending','sending');
