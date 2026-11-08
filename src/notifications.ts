export interface NotificationRow {
  event_id: string;
  payload: Record<string, any>;
  received_at: Date;
  read_at: Date | null;
}

export interface AppNotification {
  id: string;
  type: "application.status.changed" | "job.deadline.reminder";
  title: string;
  body: string;
  link: string;
  createdAt: string;
  read: boolean;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function utcDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Only whitelisted fields are copied; the recipient email never leaves the payload. */
export function toNotification(row: NotificationRow): AppNotification {
  const p = row.payload;
  const common = {
    id: row.event_id,
    createdAt: new Date(row.received_at).toISOString(),
    read: row.read_at != null,
  };
  if (p.eventType === "job.deadline.reminder.v1")
    return {
      ...common,
      type: "job.deadline.reminder",
      title: "Deadline reminder",
      body: `${p.jobTitle} closes on ${utcDate(p.deadline)}. You prepared a resume but have not applied yet.`,
      link: `/seeker/jobs/${p.jobId}`,
    };
  return {
    ...common,
    type: "application.status.changed",
    title: "Application update",
    body: `Your application for ${p.jobTitle} moved from ${p.previousStatus} to ${p.newStatus}.`,
    link: "/seeker/applications",
  };
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function listMine(db: Queryable, userId: string) {
  const list = await db.query(
    `SELECT event_id, payload, received_at, read_at FROM notification_deliveries
     WHERE payload->>'candidateId' = $1 ORDER BY received_at DESC LIMIT 20`,
    [userId],
  );
  const unread = await db.query(
    `SELECT count(*) AS count FROM notification_deliveries
     WHERE payload->>'candidateId' = $1 AND read_at IS NULL`,
    [userId],
  );
  return {
    notifications: list.rows.map(toNotification),
    unreadCount: Number(unread.rows[0]?.count ?? 0),
  };
}

export async function markAllRead(db: Queryable, userId: string) {
  const res = await db.query(
    `UPDATE notification_deliveries SET read_at = now()
     WHERE payload->>'candidateId' = $1 AND read_at IS NULL`,
    [userId],
  );
  return (res as { rowCount?: number }).rowCount ?? 0;
}
