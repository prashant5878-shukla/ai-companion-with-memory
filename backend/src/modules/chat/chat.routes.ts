import { Router } from "express";
import { ChatController } from "./chat.controller.js";

export function chatRoutes(controller: ChatController): Router {
  const router = Router();
  router.post("/session/resume", controller.resumeSession);
  router.post("/session/new", controller.newSession);
  router.post("/message", controller.sendMessage);
  router.post("/message/stream", controller.sendMessageStream);
  return router;
}
