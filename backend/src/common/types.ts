export type FactCategory =
  | "relationship"
  | "work"
  | "preference"
  | "plan"
  | "opinion"
  | "event"
  | "trait"
  | "other";

export type FactStatus = "active" | "superseded" | "expired";

/**
 * Temporal semantics of a fact — orthogonal to recency. Recency answers "when was this
 * last touched"; temporalType answers "does age make this less true". A birthday is
 * `permanent` (never decays); a relationship status is `ongoing` (true until explicitly
 * superseded, decays only slowly as a relevance tie-breaker); "feeling stressed this week"
 * is `temporary` (decays fast, may be dropped from retrieval well before it'd be
 * superseded); a scheduled/occurred happening is `event` (relevance peaks near the date).
 */
export type TemporalType = "permanent" | "ongoing" | "temporary" | "event";

export interface ExtractedFactInput {
  subject: string;
  predicate: string;
  object: string;
  category: FactCategory;
  confidence: number;
  temporalType: TemporalType;
}

export type FactRelation = "same" | "refines" | "contradicts" | "unrelated";

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
  newFacts: ExtractedFactInput[];
  reconciliation: Array<{
    fact: ExtractedFactInput;
    relation: FactRelation | "inserted";
    supersededFactId?: string;
  }>;
  cacheHit: boolean;
  personaCheck: PersonaConsistencyResult;
  mode: "full" | "baseline";
}

export interface ChatMessageRecord {
  role: "user" | "assistant";
  content: string;
}
