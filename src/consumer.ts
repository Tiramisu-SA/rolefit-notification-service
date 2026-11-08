import type { Pool } from "pg";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { validateNotificationEvent } from "./event";
import { QUEUE } from "./broker";
import { logger } from "./logger";

// Letters, digits, ".", "_", "-" only, so a message cannot inject log lines. Same rule as the gateway.
export const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The id of the request that caused this event; undefined if the publisher sent none or an unsafe one. */
function requestIdOf(msg: ConsumeMessage): string | undefined {
  const id: unknown = msg.properties?.correlationId;
  return typeof id === "string" && SAFE_ID.test(id) ? id : undefined;
}

export async function handleMessage(
  pool: Pool,
  ch: ConfirmChannel,
  msg: ConsumeMessage,
): Promise<void> {
  const requestId = requestIdOf(msg);
  let payload: unknown;
  try {
    payload = JSON.parse(msg.content.toString("utf8"));
  } catch {
    ch.nack(msg, false, false);
    logger.error("Invalid JSON dead-lettered", { requestId });
    return;
  }
  if (!validateNotificationEvent(payload)) {
    ch.nack(msg, false, false);
    logger.error("Invalid notification event dead-lettered", { requestId });
    return;
  }
  await pool.query(
    "INSERT INTO notification_deliveries(event_id,payload,request_id) VALUES ($1,$2,$3) ON CONFLICT(event_id) DO NOTHING",
    [payload.eventId, payload, requestId ?? null],
  );
  ch.ack(msg); // Accepted durably, not yet delivered by SMTP.
  logger.info("event received", { requestId, eventId: payload.eventId });
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
        logger.error("Inbox unavailable; message remains unacknowledged", {
          requestId: requestIdOf(msg),
        });
        // Closing causes broker redelivery after reconnect; no tight requeue loop.
        void ch.close().catch(() => {});
      });
    },
    { noAck: false },
  );
}
