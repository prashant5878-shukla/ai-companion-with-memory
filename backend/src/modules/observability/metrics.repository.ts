import { LlmCallModel, LlmCallType } from "./llm-call.model.js";

export interface LlmCallEntry {
  type: LlmCallType;
  model: string;
  sessionId?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  ok?: boolean;
}

export interface TypeBreakdown {
  type: LlmCallType;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  errors: number;
}

export interface MetricsSummary {
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
  byType: TypeBreakdown[];
  cacheHitRate: number | null; // null when there's no chat/cache_hit history yet
}

export interface RecentCall {
  type: LlmCallType;
  model: string;
  sessionId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  ok: boolean;
  createdAt: Date;
}

export class MetricsRepository {
  async record(entry: LlmCallEntry): Promise<void> {
    await LlmCallModel.create({
      type: entry.type,
      model: entry.model,
      sessionId: entry.sessionId ?? null,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      totalTokens: entry.totalTokens ?? 0,
      latencyMs: entry.latencyMs,
      ok: entry.ok ?? true,
    });
  }

  async summary(): Promise<MetricsSummary> {
    const rows = await LlmCallModel.aggregate<{
      _id: LlmCallType;
      calls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      avgLatencyMs: number;
      errors: number;
    }>([
      {
        $group: {
          _id: "$type",
          calls: { $sum: 1 },
          promptTokens: { $sum: "$promptTokens" },
          completionTokens: { $sum: "$completionTokens" },
          totalTokens: { $sum: "$totalTokens" },
          avgLatencyMs: { $avg: "$latencyMs" },
          errors: { $sum: { $cond: [{ $eq: ["$ok", false] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const byType: TypeBreakdown[] = rows.map((r) => ({
      type: r._id,
      calls: r.calls,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      avgLatencyMs: Math.round(r.avgLatencyMs),
      errors: r.errors,
    }));

    const totals = byType.reduce(
      (acc, t) => ({
        calls: acc.calls + t.calls,
        promptTokens: acc.promptTokens + t.promptTokens,
        completionTokens: acc.completionTokens + t.completionTokens,
        totalTokens: acc.totalTokens + t.totalTokens,
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );

    const chatCalls = byType.find((t) => t.type === "chat")?.calls ?? 0;
    const cacheHits = byType.find((t) => t.type === "cache_hit")?.calls ?? 0;
    const cacheEligible = chatCalls + cacheHits;
    const cacheHitRate = cacheEligible > 0 ? cacheHits / cacheEligible : null;

    return { totals, byType, cacheHitRate };
  }

  async recentCalls(limit = 20): Promise<RecentCall[]> {
    const docs = await LlmCallModel.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map((d) => ({
      type: d.type as LlmCallType,
      model: d.model,
      sessionId: d.sessionId ?? null,
      promptTokens: d.promptTokens ?? 0,
      completionTokens: d.completionTokens ?? 0,
      totalTokens: d.totalTokens ?? 0,
      latencyMs: d.latencyMs,
      ok: d.ok,
      createdAt: d.createdAt as Date,
    }));
  }
}
