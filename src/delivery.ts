import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { StatusEvent } from "./event";
import { isPermanent } from "./email";
export const RETRY_SECONDS = [10, 30, 60] as const;
export function retryDelay(attempt: number, permanent: boolean): number | null {
  return permanent || attempt >= 4
    ? null
    : (RETRY_SECONDS[attempt - 1] ?? null);
}

export async function deliverNext(
  pool: Pool,
  send: (event: StatusEvent) => Promise<void>,
): Promise<boolean> {
  // An interrupted fourth send may have succeeded. Retain failure instead of making a fifth send.
  await pool.query(
    "UPDATE notification_deliveries SET status='failed',lease_until=NULL,lease_token=NULL,last_error='Attempt limit reached after interrupted send' WHERE status='sending' AND lease_until<=now() AND attempts>=4",
  );
  const token = randomUUID();
  const { rows } = await pool.query(
    `UPDATE notification_deliveries SET status='sending',attempts=attempts+1,
   lease_until=now()+interval '60 seconds',lease_token=$1
   WHERE event_id=(SELECT event_id FROM notification_deliveries WHERE
     (status='pending' AND next_attempt_at<=now() AND attempts<4) OR (status='sending' AND lease_until<=now() AND attempts<4)
     ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
    [token],
  );
  const job = rows[0];
  if (!job) return false;
  try {
    await send(job.payload);
  } catch (error) {
    const wait = retryDelay(job.attempts, isPermanent(error));
    // Store only a safe category, never raw provider text that may contain credentials/recipient data.
    const category = isPermanent(error)
      ? "SMTP permanently rejected message"
      : "SMTP delivery attempt failed";
    await pool.query(
      `UPDATE notification_deliveries SET status=$3,next_attempt_at=now()+($4*interval '1 second'),
    lease_until=NULL,lease_token=NULL,last_error=$5 WHERE event_id=$1 AND lease_token=$2`,
      [
        job.event_id,
        token,
        wait === null ? "failed" : "pending",
        wait || 0,
        category,
      ],
    );
    console.error(
      `Notification ${job.event_id}: ${wait === null ? "failed" : "retry scheduled"}`,
    );
    return true;
  }
  // A recording failure leaves the lease intact for restart recovery. SMTP may already have accepted the email.
  await pool.query(
    "UPDATE notification_deliveries SET status='sent',sent_at=now(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE event_id=$1 AND lease_token=$2",
    [job.event_id, token],
  );
  console.log(`Notification ${job.event_id}: SMTP accepted`);
  return true;
}
