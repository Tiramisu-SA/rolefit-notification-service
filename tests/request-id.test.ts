import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/consumer";
import { deliverNext } from "../src/delivery";
import type { StatusEvent } from "../src/event";
import { logger } from "../src/logger";
import { withCapturedLogs } from "./capture-logs";

const event: StatusEvent = {
  eventId: "26ec5af5-7cef-434b-9fe9-dc4f37e00455",
  schemaVersion: 1,
  eventType: "application.status.changed.v1",
  occurredAt: "2026-10-11T00:00:00Z",
  applicationId: "a",
  jobId: "j",
  candidateId: "u",
  recipient: { name: "Pim", email: "pim.private@example.test" },
  jobTitle: "Developer",
  previousStatus: "Submitted",
  newStatus: "Offer",
};

function message(content: string, correlationId?: unknown) {
  return {
    content: Buffer.from(content),
    properties: { correlationId, messageId: event.eventId },
  } as never;
}

function fakeConsumer() {
  const inserts: unknown[][] = [];
  const acks: string[] = [];
  return {
    inserts,
    acks,
    pool: {
      query: async (_sql: string, params: unknown[]) => {
        inserts.push(params);
      },
    } as never,
    channel: {
      ack: () => acks.push("ack"),
      nack: () => acks.push("nack"),
    } as never,
  };
}

test("a received event stores the correlation id as the request id and logs it", async () => {
  const consumer = fakeConsumer();
  await withCapturedLogs(async (logs) => {
    await handleMessage(
      consumer.pool,
      consumer.channel,
      message(JSON.stringify(event), "req-status_1.2"),
    );
    const line = await logs.waitFor((l) => l.message === "event received");
    assert.equal(line.requestId, "req-status_1.2");
    assert.equal(line.eventId, event.eventId);
    assert.equal(line.service, "notification");
  });
  assert.equal(consumer.inserts[0][2], "req-status_1.2");
  assert.deepEqual(consumer.acks, ["ack"]);
});

test("an event from an older publisher, without a correlation id, is still accepted", async () => {
  const consumer = fakeConsumer();
  await withCapturedLogs(async () => {
    await handleMessage(
      consumer.pool,
      consumer.channel,
      message(JSON.stringify(event)),
    );
  });
  assert.equal(consumer.inserts[0][2], null);
  assert.deepEqual(consumer.acks, ["ack"]);
});

test("an unsafe correlation id is dropped, so a message cannot inject log content", async () => {
  for (const unsafe of ["has spaces", "x".repeat(129), 'a"}\n{"forged":"1', 42]) {
    const consumer = fakeConsumer();
    await withCapturedLogs(async (logs) => {
      await handleMessage(
        consumer.pool,
        consumer.channel,
        message(JSON.stringify(event), unsafe),
      );
      const line = await logs.waitFor((l) => l.message === "event received");
      assert.equal(line.requestId, undefined);
    });
    assert.equal(consumer.inserts[0][2], null, `unsafe: ${String(unsafe)}`);
    assert.deepEqual(consumer.acks, ["ack"]);
  }
});

test("a dead-lettered message is logged with its request id", async () => {
  const consumer = fakeConsumer();
  await withCapturedLogs(async (logs) => {
    await handleMessage(
      consumer.pool,
      consumer.channel,
      message("{not json", "req-invalid"),
    );
    const line = await logs.waitFor((l) => l.level === "error");
    assert.equal(line.requestId, "req-invalid");
  });
  assert.deepEqual(consumer.acks, ["nack"]);
});

function fakeDelivery(job: Record<string, unknown> | undefined) {
  return {
    query: async (sql: string) =>
      sql.includes("RETURNING") && job ? { rows: [job] } : { rows: [] },
  } as never;
}
const job = {
  event_id: event.eventId,
  payload: event,
  attempts: 1,
  request_id: "req-status",
};

test("a sent email is logged with the request id and the event id, but not the recipient", async () => {
  await withCapturedLogs(async (logs) => {
    assert.equal(await deliverNext(fakeDelivery(job), async () => {}), true);
    const line = await logs.waitFor((l) => l.message === "email accepted by SMTP");
    assert.equal(line.requestId, "req-status");
    assert.equal(line.eventId, event.eventId);
    assert.ok(!JSON.stringify(logs.lines()).includes("pim.private"));
  });
});

test("a failed delivery is logged with the request id, and says whether it will retry", async () => {
  const failing = async () => {
    throw new Error("timeout for pim.private@example.test");
  };
  await withCapturedLogs(async (logs) => {
    await deliverNext(fakeDelivery(job), failing);
    const retry = await logs.waitFor((l) => l.message === "email delivery will retry");
    assert.equal(retry.requestId, "req-status");
    assert.equal(retry.level, "error");

    await deliverNext(fakeDelivery({ ...job, attempts: 4 }), failing);
    const failed = await logs.waitFor((l) => l.message === "email delivery failed");
    assert.equal(failed.requestId, "req-status");
    assert.ok(!JSON.stringify(logs.lines()).includes("pim.private"));
  });
});

test("a delivery stored before this change is sent and logged without a request id", async () => {
  await withCapturedLogs(async (logs) => {
    await deliverNext(fakeDelivery({ ...job, request_id: null }), async () => {});
    const line = await logs.waitFor((l) => l.message === "email accepted by SMTP");
    assert.equal(line.requestId, undefined);
  });
});

test("the logger writes an Error as JSON and survives values JSON cannot represent", async () => {
  await withCapturedLogs(async (logs) => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.error("It failed", new TypeError("bad input"));
    logger.error("Circular detail", circular);
    const error = (await logs.waitFor((l) => l.message === "It failed"))
      .error as { name: string; message: string };
    assert.equal(error.name, "TypeError");
    assert.equal(error.message, "bad input");
    await logs.waitFor((l) => l.message === "Circular detail");
  });
});
