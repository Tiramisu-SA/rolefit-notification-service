import type { Pool } from "pg";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { validateEvent } from "./event";
import { QUEUE } from "./broker";

export async function handleMessage(
  pool: Pool,
  ch: ConfirmChannel,
  msg: ConsumeMessage,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(msg.content.toString("utf8"));
  } catch {
    ch.nack(msg, false, false);
    console.error("Invalid JSON dead-lettered");
    return;
  }
  if (!validateEvent(payload) || payload.previousStatus === payload.newStatus) {
    ch.nack(msg, false, false);
    console.error("Invalid status event dead-lettered");
    return;
  }
  await pool.query(
    "INSERT INTO notification_deliveries(event_id,payload) VALUES ($1,$2) ON CONFLICT(event_id) DO NOTHING",
    [payload.eventId, payload],
  );
  ch.ack(msg); // Accepted durably, not yet delivered by SMTP.
}
export async function consume(pool: Pool, ch: ConfirmChannel): Promise<void> {
  await ch.consume(
    QUEUE,
    (msg) => {
      if (!msg) {
        void ch.close().catch(() => {});
        return;
      }
      void handleMessage(pool, ch, msg).catch(() => {
        console.error("Inbox unavailable; message remains unacknowledged");
        // Closing causes broker redelivery after reconnect; no tight requeue loop.
        void ch.close().catch(() => {});
      });
    },
    { noAck: false },
  );
}
