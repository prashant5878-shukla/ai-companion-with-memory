import { Router } from "express";
import { TurnLogController } from "./turn-log.controller.js";

export function turnLogRoutes(controller: TurnLogController): Router {
  const router = Router();
  router.get("/", controller.listForSession);
  return router;
}
