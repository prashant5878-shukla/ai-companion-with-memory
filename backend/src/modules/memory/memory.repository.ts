import type { Model, Types } from "mongoose";
import type { FactDoc } from "./fact.model.js";
import { ExtractedFactInput } from "../../common/types.js";

export interface StoredFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  category: FactDoc["category"];
  confidence: number;
  status: FactDoc["status"];
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
    confidence: doc.confidence,
    status: doc.status,
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
    sourceMessageId?: string
  ): Promise<StoredFact> {
    const doc = await this.model.create({
      ...fact,
      embedding,
      status: "active",
      sourceMessageId: sourceMessageId ?? null,
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

  async updateFact(id: string, object: string, confidence: number): Promise<void> {
    await this.model.updateOne({ _id: id }, { object, confidence });
  }

  async listAll(): Promise<StoredFact[]> {
    const docs = await this.model.find({}).sort({ createdAt: 1 }).lean();
    return docs.map(toStoredFact);
  }
}
