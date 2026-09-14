export type FactCategory =
  | "relationship"
  | "work"
  | "preference"
  | "plan"
  | "opinion"
  | "event"
  | "trait"
  | "other";

export type TemporalType = "permanent" | "ongoing" | "temporary" | "event";

export interface RetrievedFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  category: FactCategory;
  temporalType: TemporalType;
  score: number;
  updatedAt: string;
}

export interface StoredFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  category: FactCategory;
  temporalType: TemporalType;
  confidence: number;
  status: "active" | "superseded" | "expired";
  createdAt: string;
  updatedAt: string;
}

export interface PersonaConsistencyResult {
  checked: boolean;
  consistent: boolean;
  conflictingFact?: string;
  reason?: string;
  correctionApplied: boolean;
}

export interface ChatTurnResult {
  reply: string;
  retrievedFacts: RetrievedFact[];
  retrievedPersonaFacts: RetrievedFact[];
  newFacts: Array<{
    subject: string;
    predicate: string;
    object: string;
    category: FactCategory;
    temporalType: TemporalType;
    confidence: number;
  }>;
  reconciliation: Array<{
    fact: { subject: string; predicate: string; object: string };
    relation: "same" | "refines" | "contradicts" | "unrelated" | "inserted";
    supersededFactId?: string;
  }>;
  cacheHit: boolean;
  personaCheck: PersonaConsistencyResult;
  mode: "full" | "baseline";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cacheHit?: boolean;
}

export type LlmCallType = "chat" | "extract" | "classify" | "embed" | "cache_hit" | "persona_check" | "correction";

export interface TypeBreakdown {
  type: LlmCallType;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  errors: number;
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
  createdAt: string;
}

export interface MetricsSummary {
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
  byType: TypeBreakdown[];
  cacheHitRate: number | null;
  recentCalls: RecentCall[];
}
