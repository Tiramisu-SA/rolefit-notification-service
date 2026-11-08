import { createApp } from "./app";
import { setTimeout as delay } from "node:timers/promises";
import { createPool, integer } from "./config";
import { Broker } from "./broker";
import { consume } from "./consumer";
import { createMailer } from "./email";
import { deliverNext } from "./delivery";
import { logger } from "./logger";
const pool = createPool();
const send = createMailer();
const broker = new Broker(
  process.env.RABBITMQ_URL || "amqp://rolefit:rolefit-local@localhost:5672",
  (ch) => consume(pool, ch),
);
const app = createApp(pool, () => broker.ready);
const server = app.listen(
  integer("PORT", 3005),
  process.env.HOST || "0.0.0.0",
  () => logger.info("Notification health HTTP listening"),
);
let stopping = false;
broker.start();
const worker = (async () => {
  while (!stopping) {
    try {
      if (await deliverNext(pool, send)) continue;
    } catch {
      logger.error("Delivery storage unavailable; will retry");
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
