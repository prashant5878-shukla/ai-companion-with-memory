import type { Request, Response } from "express";
import { ChatService } from "./chat.service.js";
import { Logger } from "../../common/logger.js";

export class ChatController {
  private readonly logger = new Logger("ChatController");

  constructor(private readonly chatService: ChatService) {}

  resumeSession = async (_req: Request, res: Response): Promise<void> => {
    const sessionId = await this.chatService.resumeSession();
    res.json({ sessionId });
  };

  newSession = async (_req: Request, res: Response): Promise<void> => {
    const sessionId = await this.chatService.newSession();
    res.json({ sessionId });
  };

  /** Non-streaming JSON variant — buffers the full reply before responding. */
  sendMessage = async (req: Request, res: Response): Promise<void> => {
    const { sessionId, message, baseline } = req.body as {
      sessionId?: string;
      message?: string;
      baseline?: boolean;
    };
    if (!sessionId || !message) {
      res.status(400).json({ error: "sessionId and message are required" });
      return;
    }
    try {
      const result = await this.chatService.sendMessage(sessionId, message, undefined, { baseline });
      res.json(result);
    } catch (err) {
      this.logger.error("sendMessage failed", err);
      res.status(500).json({ error: "Failed to process message" });
    }
  };

  /**
   * Server-Sent Events variant: emits a "token" event per chunk as the reply is
   * generated (or the whole cached reply in one "token" event on a cache hit), then a
   * single "done" event carrying the full ChatTurnResult, then closes the connection.
   */
  sendMessageStream = async (req: Request, res: Response): Promise<void> => {
    const { sessionId, message, baseline } = req.body as {
      sessionId?: string;
      message?: string;
      baseline?: boolean;
    };
    if (!sessionId || !message) {
      res.status(400).json({ error: "sessionId and message are required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const result = await this.chatService.sendMessage(
        sessionId,
        message,
        (chunk) => {
          res.write(`event: token\ndata: ${JSON.stringify({ token: chunk })}\n\n`);
        },
        { baseline }
      );
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (err) {
      this.logger.error("sendMessageStream failed", err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Failed to process message" })}\n\n`);
    } finally {
      res.end();
    }
  };
}
