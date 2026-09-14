import type { Request, Response } from "express";
import { TurnLogRepository } from "./turn-log.repository.js";

export class TurnLogController {
  constructor(private readonly repo: TurnLogRepository) {}

  listForSession = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId query param is required" });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const logs = await this.repo.findBySession(sessionId, limit);
    res.json({ logs });
  };
}
