import type { ChatTurnResult, RetrievedFact } from "../../src/common/types.js";

const API_BASE = process.env.EVAL_API_BASE ?? "http://localhost:4000/api";

export interface StoredFactLike {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  category: string;
  temporalType: string;
  status: "active" | "superseded" | "expired";
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnLogRecord {
  id: string;
  sessionId: string;
  mode: "full" | "baseline";
  userMessage: string;
  reply: string;
  cacheHit: boolean;
  retrievedUserFacts: RetrievedFact[];
  retrievedPersonaFacts: RetrievedFact[];
  reconciliation: ChatTurnResult["reconciliation"];
  personaCheck: ChatTurnResult["personaCheck"];
  createdAt: string;
}

/** Thin black-box HTTP client the eval harness uses to exercise the real running backend. */
export class EvalClient {
  constructor(private readonly base = API_BASE) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base.replace(/\/api$/, "")}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async newSession(): Promise<string> {
    const res = await fetch(`${this.base}/session/new`, { method: "POST" });
    if (!res.ok) throw new Error(`newSession failed: ${res.status}`);
    return ((await res.json()) as { sessionId: string }).sessionId;
  }

  async send(sessionId: string, message: string, baseline = false): Promise<ChatTurnResult> {
    const res = await fetch(`${this.base}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message, baseline }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`send failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ChatTurnResult>;
  }

  async listFacts(): Promise<{ userFacts: StoredFactLike[]; personaFacts: StoredFactLike[] }> {
    const res = await fetch(`${this.base}/memory/facts`);
    if (!res.ok) throw new Error(`listFacts failed: ${res.status}`);
    return res.json() as Promise<{ userFacts: StoredFactLike[]; personaFacts: StoredFactLike[] }>;
  }

  async turnLogs(sessionId: string): Promise<TurnLogRecord[]> {
    const res = await fetch(`${this.base}/turn-logs?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`turnLogs failed: ${res.status}`);
    return ((await res.json()) as { logs: TurnLogRecord[] }).logs;
  }
}
