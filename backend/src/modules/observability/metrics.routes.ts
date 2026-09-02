import { Router } from "express";
import { MetricsController } from "./metrics.controller.js";

export function metricsRoutes(controller: MetricsController): Router {
  const router = Router();
  router.get("/summary", controller.getSummary);
  return router;
}
