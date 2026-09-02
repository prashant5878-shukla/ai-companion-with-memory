import { Router } from "express";
import { MemoryController } from "./memory.controller.js";

export function memoryRoutes(controller: MemoryController): Router {
  const router = Router();
  router.get("/facts", controller.listAll);
  return router;
}
