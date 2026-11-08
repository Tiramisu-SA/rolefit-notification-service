import express from "express";
import { logger } from "./logger";
import { listMine, markAllRead, type Queryable } from "./notifications";

function sendError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
) {
  res.status(status).json({ error: { code, message } });
}

export function createApp(db: Queryable, brokerReady: () => boolean) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: "notification" }),
  );
  app.get("/ready", async (_req, res) => {
    let database = true;
    try {
      await db.query("SELECT 1");
    } catch {
      database = false;
    }
    const broker = brokerReady();
    res.status(database && broker ? 200 : 503).json({
      status: database && broker ? "ready" : "unavailable",
      database,
      broker,
    });
  });

  const handler =
    (
      run: (
        userId: string,
        requestId: string | undefined,
        res: express.Response,
      ) => Promise<void>,
    ) =>
    async (req: express.Request, res: express.Response) => {
      const userId = req.get("x-user-id")?.trim();
      if (!userId)
        return sendError(
          res,
          401,
          "UNAUTHENTICATED",
          "Authentication is required",
        );
      try {
        await run(userId, req.get("x-request-id") ?? undefined, res);
      } catch {
        logger.error("Notification storage failed", {
          requestId: req.get("x-request-id") ?? undefined,
        });
        sendError(
          res,
          503,
          "SERVICE_UNAVAILABLE",
          "Notification storage is unavailable",
        );
      }
    };

  app.get(
    "/api/notifications/mine",
    handler(async (userId, requestId, res) => {
      const result = await listMine(db, userId);
      logger.info("notifications listed", {
        requestId,
        count: result.notifications.length,
        unreadCount: result.unreadCount,
      });
      res.json(result);
    }),
  );
  app.post(
    "/api/notifications/mine/read",
    handler(async (userId, requestId, res) => {
      const count = await markAllRead(db, userId);
      logger.info("notifications marked read", { requestId, count });
      res.status(204).end();
    }),
  );

  app.use((_req, res) =>
    sendError(res, 404, "ROUTE_NOT_FOUND", "Route not found"),
  );
  return app;
}
