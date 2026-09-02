import { SessionModel, MessageModel } from "./message.model.js";
import { ChatMessageRecord } from "../../common/types.js";

export class SessionRepository {
  async createSession(): Promise<string> {
    const doc = await SessionModel.create({ startedAt: new Date() });
    return doc._id.toString();
  }

  async getLatestSession(): Promise<string | null> {
    const doc = await SessionModel.findOne().sort({ startedAt: -1 }).lean();
    return doc ? doc._id.toString() : null;
  }

  async addMessage(sessionId: string, role: "user" | "assistant", content: string): Promise<string> {
    const doc = await MessageModel.create({ sessionId, role, content });
    return doc._id.toString();
  }

  async getRecentMessages(sessionId: string, limit = 8): Promise<ChatMessageRecord[]> {
    const docs = await MessageModel.find({ sessionId }).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.reverse().map((d) => ({ role: d.role as "user" | "assistant", content: d.content }));
  }
}
