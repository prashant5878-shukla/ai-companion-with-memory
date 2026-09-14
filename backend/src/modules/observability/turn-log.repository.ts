import { TurnLogModel } from "./turn-log.model.js";
import { ChatTurnResult } from "../../common/types.js";

export interface TurnLogRecord {
  id: string;
  sessionId: string;
  mode: "full" | "baseline";
  userMessage: string;
  reply: string;
  cacheHit: boolean;
  retrievedUserFacts: ChatTurnResult["retrievedFacts"];
  retrievedPersonaFacts: ChatTurnResult["retrievedPersonaFacts"];
  reconciliation: ChatTurnResult["reconciliation"];
  personaCheck: ChatTurnResult["personaCheck"];
  createdAt: Date;
}

export class TurnLogRepository {
  async record(sessionId: string, userMessage: string, result: ChatTurnResult): Promise<void> {
    await TurnLogModel.create({
      sessionId,
      mode: result.mode,
      userMessage,
      reply: result.reply,
      cacheHit: result.cacheHit,
      retrievedUserFacts: result.retrievedFacts,
      retrievedPersonaFacts: result.retrievedPersonaFacts,
      reconciliation: result.reconciliation.map((r) => ({
        subject: r.fact.subject,
        predicate: r.fact.predicate,
        object: r.fact.object,
        temporalType: r.fact.temporalType,
        relation: r.relation,
        supersededFactId: r.supersededFactId ?? null,
      })),
      personaCheck: result.personaCheck,
    });
  }

  async findBySession(sessionId: string, limit = 200): Promise<TurnLogRecord[]> {
    const docs = await TurnLogModel.find({ sessionId }).sort({ createdAt: 1 }).limit(limit).lean();
    return docs.map((d: any) => ({
      id: d._id.toString(),
      sessionId: d.sessionId,
      mode: d.mode,
      userMessage: d.userMessage,
      reply: d.reply,
      cacheHit: d.cacheHit,
      retrievedUserFacts: d.retrievedUserFacts,
      retrievedPersonaFacts: d.retrievedPersonaFacts,
      reconciliation: d.reconciliation,
      personaCheck: d.personaCheck,
      createdAt: d.createdAt,
    }));
  }
}
