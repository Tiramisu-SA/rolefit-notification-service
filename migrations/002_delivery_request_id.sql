-- The request that caused this event, read from the AMQP correlation id, so delivery logs
-- written later by the worker can be traced back to it. Kept outside the payload: the event
-- contract forbids extra fields.
ALTER TABLE notification_deliveries ADD COLUMN request_id text;
