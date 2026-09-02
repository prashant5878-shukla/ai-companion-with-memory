import mongoose, { Schema, type InferSchemaType } from "mongoose";

export const LLM_CALL_TYPES = ["chat", "extract", "classify", "embed", "cache_hit"] as const;
export type LlmCallType = (typeof LLM_CALL_TYPES)[number];

const llmCallSchema = new Schema(
  {
    type: { type: String, enum: LLM_CALL_TYPES, required: true, index: true },
    model: { type: String, required: true },
    sessionId: { type: String, default: null, index: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    latencyMs: { type: Number, required: true },
    ok: { type: Boolean, required: true, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export type LlmCallDoc = InferSchemaType<typeof llmCallSchema>;
export const LlmCallModel = mongoose.model("LlmCall", llmCallSchema, "llm_calls");
