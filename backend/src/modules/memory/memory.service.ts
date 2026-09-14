import { GeminiClient } from "../llm/gemini.client.js";
import { MemoryRepository, StoredFact } from "./memory.repository.js";
import { cosineSimilarity } from "../../common/vector.js";
import { ExtractedFactInput, RetrievedFact, TemporalType } from "../../common/types.js";
import { Logger } from "../../common/logger.js";

const SIMILARITY_FLOOR = 0.45; // below this, a fact isn't relevant enough to surface

/**
 * Recency is a relevance tie-breaker, not a validity signal — see ARCHITECTURE.md §4 and
 * FIXES_REPORT.md #5. A `permanent` fact (birthday, hometown) never gets "less true" with
 * age, so its recency term is pinned at 1 regardless of how long ago it was stored.
 * `ongoing` facts (job, relationship status) decay slowly — they stay relevant for a long
 * time because they remain true until an explicit contradiction supersedes them.
 * `temporary` facts (this week's mood, a short-term plan) decay fast and are additionally
 * hard-expired by `MemoryRepository.expireStaleTemporary`. `event` facts sit in between.
 */
const RECENCY_HALF_LIFE_DAYS: Record<TemporalType, number | null> = {
  permanent: null, // null = no decay
  ongoing: 90,
  temporary: 7,
  event: 30,
};

function recencyScore(temporalType: TemporalType, ageDays: number): number {
  const halfLife = RECENCY_HALF_LIFE_DAYS[temporalType] ?? RECENCY_HALF_LIFE_DAYS.ongoing;
  if (halfLife === null) return 1;
  return Math.exp((-Math.LN2 * ageDays) / halfLife);
}

export interface ReconciliationEntry {
  fact: ExtractedFactInput;
  relation: "same" | "refines" | "contradicts" | "unrelated" | "inserted";
  supersededFactId?: string;
}

/**
 * Business logic for one fact collection: retrieval scoring, extraction, and
 * contradiction reconciliation. Instantiated once for user facts and once for
 * persona facts, both sharing this same logic.
 */
export class MemoryService {
  private readonly logger = new Logger("MemoryService");

  constructor(private readonly repo: MemoryRepository, private readonly llm: GeminiClient) {}

  /** Takes a precomputed query embedding (callers embed the query text once and reuse it here). */
  async retrieve(queryEmbedding: number[], topK = 6): Promise<RetrievedFact[]> {
    const allActive = await this.repo.findAllActive();

    const now = Date.now();
    const scored = allActive
      .map((fact) => {
        const similarity = cosineSimilarity(queryEmbedding, fact.embedding);
        const ageDays = (now - new Date(fact.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
        const recency = recencyScore(fact.temporalType, ageDays);
        const score = 0.65 * similarity + 0.2 * recency + 0.15 * fact.confidence;
        return { fact, similarity, score };
      })
      .filter((s) => s.similarity >= SIMILARITY_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map(({ fact, score }) => ({
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      category: fact.category as RetrievedFact["category"],
      temporalType: fact.temporalType,
      score,
      updatedAt: new Date(fact.updatedAt).toISOString(),
    }));
  }

  async extractFacts(turnText: string, speakerHint: "user" | "companion"): Promise<ExtractedFactInput[]> {
    return this.llm.extractFacts(turnText, speakerHint);
  }

  /** Whether any of these candidate facts have existing active facts to reconcile against. */
  async anyHaveCandidates(facts: ExtractedFactInput[]): Promise<boolean> {
    for (const fact of facts) {
      const candidates = await this.repo.findActiveCandidates(fact.subject, fact.category, 1);
      if (candidates.length > 0) return true;
    }
    return false;
  }

  /** Insert every fact directly, no LLM classification — used when nothing exists to reconcile against. */
  async insertAllDirectly(facts: ExtractedFactInput[], sourceMessageId?: string): Promise<ReconciliationEntry[]> {
    const entries: ReconciliationEntry[] = [];
    for (const fact of facts) {
      const embedding = await this.llm.embed(this.factText(fact));
      await this.repo.insert(fact, embedding, sourceMessageId);
      entries.push({ fact, relation: "inserted" });
    }
    return entries;
  }

  async reconcileAll(facts: ExtractedFactInput[], sourceMessageId?: string): Promise<ReconciliationEntry[]> {
    const entries: ReconciliationEntry[] = [];
    for (const fact of facts) {
      entries.push(await this.reconcileOne(fact, sourceMessageId));
    }
    return entries;
  }

  private async reconcileOne(
    fact: ExtractedFactInput,
    sourceMessageId?: string
  ): Promise<ReconciliationEntry> {
    const candidates = await this.repo.findActiveCandidates(fact.subject, fact.category);

    if (candidates.length === 0) {
      const embedding = await this.llm.embed(this.factText(fact));
      await this.repo.insert(fact, embedding, sourceMessageId);
      return { fact, relation: "inserted" };
    }

    const indexed = candidates.map((c, index) => ({ index, subject: c.subject, predicate: c.predicate, object: c.object }));
    const relations = await this.llm.classifyRelations(fact, indexed);

    const embedding = await this.llm.embed(this.factText(fact));

    for (let i = 0; i < candidates.length; i++) {
      const relation = relations.get(i) ?? "unrelated";
      if (relation === "contradicts") {
        const inserted = await this.repo.insert(fact, embedding, sourceMessageId, candidates[i].id);
        await this.repo.markSuperseded(candidates[i].id, inserted.id);
        return { fact, relation: "contradicts", supersededFactId: candidates[i].id };
      }
      if (relation === "same" || relation === "refines") {
        // Refinement consolidates into ONE stronger active fact, in place — it never creates
        // a second row. E.g. "I'm a developer" then "I'm a backend developer at Microsoft"
        // updates the same fact's object rather than superseding or duplicating it. See
        // FIXES_REPORT.md #10 for why this must stay distinct from `contradicts`.
        await this.repo.updateFact(
          candidates[i].id,
          fact.object,
          Math.max(fact.confidence, candidates[i].confidence),
          fact.temporalType
        );
        return { fact, relation };
      }
    }

    // no candidate matched closely enough — treat as a genuinely new fact
    await this.repo.insert(fact, embedding, sourceMessageId);
    return { fact, relation: "unrelated" };
  }

  private factText(fact: ExtractedFactInput): string {
    return `${fact.subject} ${fact.predicate} ${fact.object}`;
  }
}
