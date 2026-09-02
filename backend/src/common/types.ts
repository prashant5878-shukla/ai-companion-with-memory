export type FactCategory =
  | "relationship"
  | "work"
  | "preference"
  | "plan"
  | "opinion"
  | "event"
  | "trait"
  | "other";

export type FactStatus = "active" | "superseded";

export interface ExtractedFactInput {
  subject: string;
  predicate: string;
  object: string;
  category: FactCategory;
  confidence: number;
}

export type FactRelation = "same" | "refines" | "contradicts" | "unrelated";

export interface RetrievedFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  category: FactCategory;
  score: number;
}

export interface ChatTurnResult {
  reply: string;
  retrievedFacts: RetrievedFact[];
  newFacts: ExtractedFactInput[];
  reconciliation: Array<{
    fact: ExtractedFactInput;
    relation: FactRelation | "inserted";
    supersededFactId?: string;
  }>;
  cacheHit: boolean;
}

export interface ChatMessageRecord {
  role: "user" | "assistant";
  content: string;
}
