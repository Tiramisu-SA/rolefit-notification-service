import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { toNotification } from "../src/notifications";

interface Row {
  event_id: string;
  payload: Record<string, any>;
  received_at: Date;
  read_at: Date | null;
}

const status = (id: string, user: string, at: string, extra = {}): Row => ({
  event_id: id,
  received_at: new Date(at),
  read_at: null,
  payload: {
    eventType: "application.status.changed.v1",
    candidateId: user,
    jobId: "j1",
    recipient: { name: "Pim", email: "pim.private@example.test" },
    jobTitle: "Developer",
    previousStatus: "Submitted",
    newStatus: "Offer",
    ...extra,
  },
});
const reminder = (id: string, user: string, at: string): Row => ({
  event_id: id,
  received_at: new Date(at),
  read_at: null,
  payload: {
    eventType: "job.deadline.reminder.v1",
    candidateId: user,
    jobId: "job-9",
    recipient: { name: "Pim", email: "pim.private@example.test" },
    jobTitle: "Designer",
    deadline: "2026-12-05T23:59:00Z",
  },
});

function fakeDb(rows: Row[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const mine = rows.filter((r) => r.payload.candidateId === params[0]);
      if (/^\s*SELECT\s+count/i.test(sql))
        return {
          rows: [{ count: String(mine.filter((r) => !r.read_at).length) }],
        };
      if (/^\s*SELECT/i.test(sql))
        return {
          rows: mine
            .sort((a, b) => +b.received_at - +a.received_at)
            .slice(0, 20),
        };
      if (/^\s*UPDATE/i.test(sql)) {
        for (const r of mine) r.read_at ??= new Date();
        return { rows: [], rowCount: mine.length };
      }
      throw new Error("unexpected sql");
    },
  };
}

async function withApp<T>(
  db: ReturnType<typeof fakeDb>,
  fn: (url: string) => Promise<T>,
) {
  const app = createApp(db, () => true);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
  } finally {
    server.close();
  }
}

test("maps a status event", () => {
  const n = toNotification(status("e1", "u", "2026-11-01T10:00:00Z"));
  assert.deepEqual(n, {
    id: "e1",
    type: "application.status.changed",
    title: "Application update",
    body: "Your application for Developer moved from Submitted to Offer.",
    link: "/seeker/applications",
    createdAt: "2026-11-01T10:00:00.000Z",
    read: false,
  });
});

test("maps a reminder event with a UTC date", () => {
  const n = toNotification({
    ...reminder("e2", "u", "2026-11-02T10:00:00Z"),
    read_at: new Date(),
  });
  assert.equal(n.type, "job.deadline.reminder");
  assert.equal(n.title, "Deadline reminder");
  assert.equal(
    n.body,
    "Designer closes on 5 December 2026. You prepared a resume but have not applied yet.",
  );
  assert.equal(n.link, "/seeker/jobs/job-9");
  assert.equal(n.read, true);
});

test("lists only the caller's rows, newest first, with unread count and no email", async () => {
  const rows = [
    status("a", "u", "2026-11-01T10:00:00Z"),
    reminder("b", "u", "2026-11-03T10:00:00Z"),
    status("c", "other", "2026-11-04T10:00:00Z"),
  ];
  rows[0].read_at = new Date();
  await withApp(fakeDb(rows), async (url) => {
    const res = await fetch(`${url}/api/notifications/mine`, {
      headers: { "x-user-id": "u" },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(
      body.notifications.map((n: any) => n.id),
      ["b", "a"],
    );
    assert.equal(body.unreadCount, 1);
    assert.equal(body.notifications[1].read, true);
    assert.ok(!text.includes("example.test"));
    assert.ok(!text.includes("candidateId"));
  });
});

test("unread count covers more than the 20 listed", async () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    status(`e${i}`, "u", `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`),
  );
  await withApp(fakeDb(rows), async (url) => {
    const body: any = await (
      await fetch(`${url}/api/notifications/mine`, {
        headers: { "x-user-id": "u" },
      })
    ).json();
    assert.equal(body.notifications.length, 20);
    assert.equal(body.unreadCount, 25);
  });
});

test("mark read returns 204 and only affects the caller", async () => {
  const rows = [
    status("a", "u", "2026-11-01T10:00:00Z"),
    status("c", "other", "2026-11-04T10:00:00Z"),
  ];
  await withApp(fakeDb(rows), async (url) => {
    const res = await fetch(`${url}/api/notifications/mine/read`, {
      method: "POST",
      headers: { "x-user-id": "u" },
    });
    assert.equal(res.status, 204);
    assert.ok(rows[0].read_at);
    assert.equal(rows[1].read_at, null);
  });
});

test("missing x-user-id gives 401 UNAUTHENTICATED and no query", async () => {
  const db = fakeDb([]);
  await withApp(db, async (url) => {
    for (const [method, path] of [
      ["GET", "/api/notifications/mine"],
      ["POST", "/api/notifications/mine/read"],
    ]) {
      const res = await fetch(url + path, { method });
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as any).error.code, "UNAUTHENTICATED");
    }
    assert.equal(db.calls.length, 0);
  });
});

test("storage failure gives 503 without details", async () => {
  const db = {
    query: async () => {
      throw new Error("secret connection string");
    },
  };
  const app = createApp(db as never, () => true);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notifications/mine`,
      { headers: { "x-user-id": "u" } },
    );
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(!text.includes("secret"));
    assert.equal(JSON.parse(text).error.code, "SERVICE_UNAVAILABLE");
  } finally {
    server.close();
  }
});

test("unknown routes still 404 and health works", async () => {
  await withApp(fakeDb([]), async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const res = await fetch(`${url}/nope`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).error.code, "ROUTE_NOT_FOUND");
  });
});
