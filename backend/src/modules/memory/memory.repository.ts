import type { Model, Types } from "mongoose";
import type { FactDoc } from "./fact.model.js";
import { ExtractedFactInput, TemporalType } from "../../common/types.js";

export interface StoredFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  category: FactDoc["category"];
  temporalType: TemporalType;
  confidence: number;
  status: FactDoc["status"];
  supersededBy: string | null;
  supersedes: string | null;
  sourceMessageId: string | null;
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

function toStoredFact(doc: any): StoredFact {
  return {
    id: doc._id.toString(),
    subject: doc.subject,
    predicate: doc.predicate,
    object: doc.object,
    category: doc.category,
    temporalType: doc.temporalType ?? "ongoing",
    confidence: doc.confidence,
    status: doc.status,
    supersededBy: doc.supersededBy ? doc.supersededBy.toString() : null,
    supersedes: doc.supersedes ? doc.supersedes.toString() : null,
    sourceMessageId: doc.sourceMessageId ? doc.sourceMessageId.toString() : null,
    embedding: doc.embedding,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Generic CRUD over a fact collection (works for both user facts and persona facts). */
export class MemoryRepository {
  constructor(private readonly model: Model<any>) {}

  async insert(
    fact: ExtractedFactInput,
    embedding: number[],
    sourceMessageId?: string,
    supersedes?: string
  ): Promise<StoredFact> {
    const doc = await this.model.create({
      ...fact,
      embedding,
      status: "active",
      sourceMessageId: sourceMessageId ?? null,
      supersedes: supersedes ?? null,
    });
    return toStoredFact(doc);
  }

  async findActiveCandidates(subject: string, category: string, limit = 20): Promise<StoredFact[]> {
    const docs = await this.model
      .find({ subject, category, status: "active" })
      .limit(limit)
      .lean();
    return docs.map(toStoredFact);
  }

  async findAllActive(): Promise<StoredFact[]> {
    const docs = await this.model.find({ status: "active" }).lean();
    return docs.map(toStoredFact);
  }

  async markSuperseded(id: string, supersededBy: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { status: "superseded", supersededBy });
  }

  async updateFact(id: string, object: string, confidence: number, temporalType?: TemporalType): Promise<void> {
    const update: Record<string, unknown> = { object, confidence };
    if (temporalType) update.temporalType = temporalType;
    await this.model.updateOne({ _id: id }, update);
  }

  /**
   * Bulk-expire `temporary` facts past their validity window (independent of `superseded`,
   * which only fires on an explicit contradicting statement). A temporary fact that nobody
   * ever contradicts should still stop surfacing once it's stale — see ARCHITECTURE.md §4.
   */
  async expireStaleTemporary(maxAgeDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const result = await this.model.updateMany(
      { status: "active", temporalType: "temporary", updatedAt: { $lt: cutoff } },
      { status: "expired" }
    );
    return result.modifiedCount ?? 0;
  }

  async listAll(): Promise<StoredFact[]> {
    const docs = await this.model.find({}).sort({ createdAt: 1 }).lean();
    return docs.map(toStoredFact);
  }
}
