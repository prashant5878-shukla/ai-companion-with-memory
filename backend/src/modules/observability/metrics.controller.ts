import type { Request, Response } from "express";
import { MetricsService } from "./metrics.service.js";

export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  getSummary = async (_req: Request, res: Response): Promise<void> => {
    const [summary, recentCalls] = await Promise.all([
      this.metrics.getSummary(),
      this.metrics.getRecentCalls(20),
    ]);
    res.json({ ...summary, recentCalls });
  };
}
