import express from "express";
import { setTimeout as delay } from "node:timers/promises";
import { createPool, integer } from "./config";
import { Broker } from "./broker";
import { consume } from "./consumer";
import { createMailer } from "./email";
import { deliverNext } from "./delivery";
const pool = createPool();
const send = createMailer();
const broker = new Broker(
  process.env.RABBITMQ_URL || "amqp://rolefit:rolefit-local@localhost:5672",
  (ch) => consume(pool, ch),
);
const app = express();
app.disable("x-powered-by");
app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "notification" }),
);
app.get("/ready", async (_req, res) => {
  let database = true;
  try {
    await pool.query("SELECT 1");
  } catch {
    database = false;
  }
  res
    .status(database && broker.ready ? 200 : 503)
    .json({
      status: database && broker.ready ? "ready" : "unavailable",
      database,
      broker: broker.ready,
    });
});
app.use((_req, res) =>
  res
    .status(404)
    .json({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } }),
);
const server = app.listen(
  integer("PORT", 3005),
  process.env.HOST || "0.0.0.0",
  () => console.log("Notification health HTTP listening"),
);
let stopping = false;
broker.start();
const worker = (async () => {
  while (!stopping) {
    try {
      if (await deliverNext(pool, send)) continue;
    } catch {
      console.error("Delivery storage unavailable; will retry");
    }
    await delay(500);
  }
})();
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await broker.stop();
  await worker;
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
