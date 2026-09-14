import mongoose, { Schema, type InferSchemaType } from "mongoose";

/**
 * One row per chat turn, capturing everything needed to diagnose a failure after the fact
 * (issue #11): what was retrieved and with what score, what memory changes happened, whether
 * the persona check fired, and the final response actually shown to the user. This is
 * deliberately separate from `llm_calls` (which is per-*Gemini-call*, not per-turn) and from
 * `messages` (raw transcript only, no scoring/decision detail).
 */
const retrievedFactLogSchema = new Schema(
  {
    id: String,
    predicate: String,
    object: String,
    category: String,
    temporalType: String,
    score: Number,
  },
  { _id: false }
);

const reconciliationLogSchema = new Schema(
  {
    subject: String,
    predicate: String,
    object: String,
    temporalType: String,
    relation: String,
    supersededFactId: { type: String, default: null },
  },
  { _id: false }
);

const turnLogSchema = new Schema(
  {
    sessionId: { type: String, required: true, index: true },
    mode: { type: String, enum: ["full", "baseline"], required: true, default: "full" },
    userMessage: { type: String, required: true },
    reply: { type: String, required: true },
    cacheHit: { type: Boolean, required: true, default: false },
    retrievedUserFacts: { type: [retrievedFactLogSchema], default: [] },
    retrievedPersonaFacts: { type: [retrievedFactLogSchema], default: [] },
    reconciliation: { type: [reconciliationLogSchema], default: [] },
    personaCheck: {
      checked: { type: Boolean, default: false },
      consistent: { type: Boolean, default: true },
      conflictingFact: { type: String, default: null },
      reason: { type: String, default: null },
      correctionApplied: { type: Boolean, default: false },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export type TurnLogDoc = InferSchemaType<typeof turnLogSchema>;
export const TurnLogModel = mongoose.model("TurnLog", turnLogSchema, "turn_logs");
