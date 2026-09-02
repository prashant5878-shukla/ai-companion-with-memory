import mongoose, { Schema, type InferSchemaType } from "mongoose";

const sessionSchema = new Schema({ startedAt: { type: Date, default: Date.now } });
export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const SessionModel = mongoose.model("Session", sessionSchema, "sessions");

const messageSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, required: true, index: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
export type MessageDoc = InferSchemaType<typeof messageSchema>;
export const MessageModel = mongoose.model("Message", messageSchema, "messages");
