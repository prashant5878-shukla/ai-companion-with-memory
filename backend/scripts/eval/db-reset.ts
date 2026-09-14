import { Database } from "../../src/config/database.js";
import { FactModel, PersonaFactModel } from "../../src/modules/memory/fact.model.js";
import { SessionModel, MessageModel } from "../../src/modules/session/message.model.js";
import { TurnLogModel } from "../../src/modules/observability/turn-log.model.js";

/**
 * Test isolation between eval suites (and between independent persona-eval runs). Memory in
 * this system is deliberately NOT session-scoped (single-user, per ARCHITECTURE.md) — which
 * means without an explicit reset, facts planted by one suite/run leak into candidate lookup
 * and retrieval for the next one, contaminating the numbers. Persona seed facts
 * (`sourceMessageId: null`) are preserved; anything extracted during a run is cleared.
 */
export async function connectEvalDb(): Promise<void> {
  await Database.connect();
}

export async function resetUserMemoryAndSessions(): Promise<void> {
  await Promise.all([
    FactModel.deleteMany({}),
    SessionModel.deleteMany({}),
    MessageModel.deleteMany({}),
    TurnLogModel.deleteMany({}),
  ]);
}

export async function resetPersonaDrift(): Promise<void> {
  await PersonaFactModel.deleteMany({ sourceMessageId: { $ne: null } });
}
