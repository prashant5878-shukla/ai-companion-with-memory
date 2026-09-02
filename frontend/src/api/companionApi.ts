import type { ChatTurnResult, MetricsSummary, StoredFact } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000/api";

/** Parses one SSE frame ("event: x\ndata: y\n\n") into { event, data }. */
function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** Thin client for the Express/LangGraph backend. Mirrors backend/src/cli/chat-cli.ts. */
export class CompanionApiClient {
  async resumeSession(): Promise<string> {
    const res = await fetch(`${API_BASE}/session/resume`, { method: "POST" });
    if (!res.ok) throw new Error(`resumeSession failed: ${res.status}`);
    const data = (await res.json()) as { sessionId: string };
    return data.sessionId;
  }

  async newSession(): Promise<string> {
    const res = await fetch(`${API_BASE}/session/new`, { method: "POST" });
    if (!res.ok) throw new Error(`newSession failed: ${res.status}`);
    const data = (await res.json()) as { sessionId: string };
    return data.sessionId;
  }

  async sendMessage(sessionId: string, message: string): Promise<ChatTurnResult> {
    const res = await fetch(`${API_BASE}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`sendMessage failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ChatTurnResult>;
  }

  /** Streams tokens via onToken as they arrive; resolves with the full turn result once done. */
  async sendMessageStream(
    sessionId: string,
    message: string,
    onToken: (chunk: string) => void
  ): Promise<ChatTurnResult> {
    const res = await fetch(`${API_BASE}/message/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`sendMessageStream failed (${res.status}): ${body}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ChatTurnResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === "token") {
          onToken((JSON.parse(parsed.data) as { token: string }).token);
        } else if (parsed.event === "done") {
          result = JSON.parse(parsed.data) as ChatTurnResult;
        } else if (parsed.event === "error") {
          throw new Error((JSON.parse(parsed.data) as { error: string }).error);
        }
      }
    }

    if (!result) throw new Error("Stream ended without a result");
    return result;
  }

  async listFacts(): Promise<{ userFacts: StoredFact[]; personaFacts: StoredFact[] }> {
    const res = await fetch(`${API_BASE}/memory/facts`);
    if (!res.ok) throw new Error(`listFacts failed: ${res.status}`);
    return res.json() as Promise<{ userFacts: StoredFact[]; personaFacts: StoredFact[] }>;
  }

  async getMetrics(): Promise<MetricsSummary> {
    const res = await fetch(`${API_BASE}/metrics/summary`);
    if (!res.ok) throw new Error(`getMetrics failed: ${res.status}`);
    return res.json() as Promise<MetricsSummary>;
  }
}
