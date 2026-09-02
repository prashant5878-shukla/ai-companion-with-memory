import { MetricsRepository, LlmCallEntry, MetricsSummary, RecentCall } from "./metrics.repository.js";
import { Logger } from "../../common/logger.js";

/**
 * Records one row per LLM call (and one per cache hit, with zero tokens) to Mongo's
 * `llm_calls` collection, and serves aggregated summaries over it. Never throws —
 * a metrics write failing should never take down a chat turn.
 */
export class MetricsService {
  private readonly logger = new Logger("MetricsService");

  constructor(private readonly repo: MetricsRepository) {}

  async record(entry: LlmCallEntry): Promise<void> {
    try {
      await this.repo.record(entry);
    } catch (err) {
      this.logger.warn("Failed to record metrics entry (non-fatal)", err);
    }
  }

  async recordCacheHit(model: string, sessionId?: string): Promise<void> {
    await this.record({ type: "cache_hit", model, sessionId, latencyMs: 0 });
  }

  async getSummary(): Promise<MetricsSummary> {
    return this.repo.summary();
  }

  async getRecentCalls(limit = 20): Promise<RecentCall[]> {
    return this.repo.recentCalls(limit);
  }
}
