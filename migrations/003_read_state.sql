ALTER TABLE notification_deliveries ADD COLUMN read_at timestamptz;
CREATE INDEX notification_deliveries_candidate_idx ON notification_deliveries ((payload->>'candidateId'), received_at DESC);
