import { SessionRepository } from "./session.repository.js";
import { ChatMessageRecord } from "../../common/types.js";

export class SessionService {
  constructor(private readonly repo: SessionRepository) {}

  /** Resume the most recent session, or start a new one if none exists yet. */
  async resumeOrCreateSession(): Promise<string> {
    const latest = await this.repo.getLatestSession();
    if (latest) return latest;
    return this.repo.createSession();
  }

  async startNewSession(): Promise<string> {
    return this.repo.createSession();
  }

  async addUserMessage(sessionId: string, text: string): Promise<string> {
    return this.repo.addMessage(sessionId, "user", text);
  }

  async addAssistantMessage(sessionId: string, text: string): Promise<string> {
    return this.repo.addMessage(sessionId, "assistant", text);
  }

  async getRecentMessages(sessionId: string, limit = 8): Promise<ChatMessageRecord[]> {
    return this.repo.getRecentMessages(sessionId, limit);
  }
}
