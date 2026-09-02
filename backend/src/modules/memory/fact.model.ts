import mongoose, { Schema, type InferSchemaType } from "mongoose";
import { FactCategory, FactStatus } from "../../common/types.js";

const CATEGORIES: FactCategory[] = [
  "relationship",
  "work",
  "preference",
  "plan",
  "opinion",
  "event",
  "trait",
  "other",
];
const STATUSES: FactStatus[] = ["active", "superseded"];

const factSchemaDefinition = {
  subject: { type: String, required: true, index: true },
  predicate: { type: String, required: true, index: true },
  object: { type: String, required: true },
  category: { type: String, enum: CATEGORIES, required: true, index: true },
  confidence: { type: Number, required: true, default: 0.7 },
  status: { type: String, enum: STATUSES, required: true, default: "active", index: true },
  supersededBy: { type: Schema.Types.ObjectId, default: null },
  sourceMessageId: { type: Schema.Types.ObjectId, default: null },
  embedding: { type: [Number], required: true },
} as const;

const factSchema = new Schema(factSchemaDefinition, { timestamps: true });
export type FactDoc = InferSchemaType<typeof factSchema>;

/** User-memory facts. */
export const FactModel = mongoose.model("Fact", factSchema, "facts");

/** Companion's own backstory/opinions — same shape, reconciled the same way. */
export const PersonaFactModel = mongoose.model("PersonaFact", factSchema, "persona_facts");
