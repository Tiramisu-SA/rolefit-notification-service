import { test } from "node:test";
import assert from "node:assert/strict";
import { email, isPermanent } from "../src/email";
import { retryDelay } from "../src/delivery";
import { handleMessage } from "../src/consumer";
import type { StatusEvent } from "../src/event";
const event: StatusEvent = {
  eventId: "26ec5af5-7cef-434b-9fe9-dc4f37e00455",
  schemaVersion: 1,
  eventType: "application.status.changed.v1",
  occurredAt: "2026-10-11T00:00:00Z",
  applicationId: "a",
  jobId: "j",
  candidateId: "u",
  recipient: { name: "<Candidate & Co>", email: "sample@example.test" },
  jobTitle: "<script>alert(1)</script>",
  previousStatus: "Submitted",
  newStatus: "Offer",
};
test("email has both bodies, correct recipient, escaped HTML, stable message ID", () => {
  const mail = email(event, "notifications@rolefit.test");
  assert.equal(mail.to.address, event.recipient.email);
  assert.ok(mail.text.includes("Submitted to Offer"));
  assert.ok(mail.html.includes("&lt;script&gt;"));
  assert.ok(!mail.html.includes("<script>"));
  assert.ok(mail.html.includes("&amp;"));
  assert.equal(mail.messageId, `<${event.eventId}@rolefit.local>`);
});
test("SMTP retry schedule and permanent rejection", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => retryDelay(n, false)),
    [10, 30, 60, null],
  );
  assert.equal(retryDelay(1, true), null);
  assert.equal(isPermanent({ responseCode: 550 }), true);
  assert.equal(isPermanent({ responseCode: 451 }), false);
  assert.equal(isPermanent(new Error("timeout")), false);
});
test("consumer acknowledges only after durable insert and does not acknowledge database failure", async () => {
  const order: string[] = [];
  const pool = {
    query: async () => {
      order.push("persist");
    },
  };
  const ch = { ack: () => order.push("ack"), nack: () => order.push("nack") };
  const msg = { content: Buffer.from(JSON.stringify(event)) };
  await handleMessage(pool as any, ch as any, msg as any);
  assert.deepEqual(order, ["persist", "ack"]);
  order.length = 0;
  await assert.rejects(
    handleMessage(
      {
        query: async () => {
          throw new Error("offline");
        },
      } as any,
      ch as any,
      msg as any,
    ),
  );
  assert.deepEqual(order, []);
});
test("consumer dead-letters malformed JSON, extra sensitive fields, and no-op events", async () => {
  let invalid = 0;
  const ch = {
    ack: () => assert.fail("Unexpected ack"),
    nack: (_m: any, _multiple: boolean, requeue: boolean) => {
      assert.equal(requeue, false);
      invalid++;
    },
  };
  for (const body of [
    "{",
    JSON.stringify({ ...event, note: "private" }),
    JSON.stringify({ ...event, newStatus: event.previousStatus }),
  ])
    await handleMessage(
      { query: () => assert.fail("Unexpected insert") } as any,
      ch as any,
      { content: Buffer.from(body) } as any,
    );
  assert.equal(invalid, 3);
});
