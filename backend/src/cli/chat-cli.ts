import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PERSONA_NAME } from "../modules/persona/persona.data.js";
import { ChatTurnResult } from "../common/types.js";
import type { MetricsSummary } from "../modules/observability/metrics.repository.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000/api";

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

class ChatCliClient {
  private sessionId: string | null = null;

  async resumeSession(): Promise<void> {
    const res = await fetch(`${API_BASE}/session/resume`, { method: "POST" });
    const data = (await res.json()) as { sessionId: string };
    this.sessionId = data.sessionId;
  }

  /** Streams tokens via onToken as they arrive; resolves with the full turn result once done. */
  async sendStreaming(message: string, onToken: (chunk: string) => void): Promise<ChatTurnResult> {
    if (!this.sessionId) throw new Error("Session not started");
    const res = await fetch(`${API_BASE}/message/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, message }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`Request failed (${res.status}): ${body}`);
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

  async getMetrics(): Promise<MetricsSummary> {
    const res = await fetch(`${API_BASE}/metrics/summary`);
    if (!res.ok) throw new Error(`Failed to fetch metrics: ${res.status}`);
    return res.json() as Promise<MetricsSummary>;
  }
}

function printStats(summary: MetricsSummary): void {
  const { totals, byType, cacheHitRate } = summary;
  console.log(
    `\n${totals.calls} LLM calls · ${totals.totalTokens.toLocaleString()} tokens ` +
      `(${totals.promptTokens.toLocaleString()} prompt / ${totals.completionTokens.toLocaleString()} completion) · ` +
      `cache hit rate ${cacheHitRate === null ? "—" : `${Math.round(cacheHitRate * 100)}%`}`
  );
  for (const t of byType) {
    console.log(
      `  ${t.type.padEnd(9)} calls=${t.calls}  tokens=${t.totalTokens}  avg=${t.avgLatencyMs}ms` +
        (t.errors > 0 ? `  errors=${t.errors}` : "")
    );
  }
  console.log();
}

async function main() {
  const client = new ChatCliClient();
  console.log(`Connecting to ${PERSONA_NAME}...`);
  try {
    await client.resumeSession();
  } catch (err) {
    console.error(`Could not reach the backend at ${API_BASE}. Is "npm run server" running?`);
    console.error(err);
    process.exit(1);
  }
  console.log(
    `${PERSONA_NAME} is here. Type your message and press enter (Ctrl+C to quit, /stats for token usage).\n`
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let userText: string;
    try {
      userText = await rl.question("you> ");
    } catch {
      break; // stdin closed (Ctrl+D, or piped input ran out)
    }
    if (!userText.trim()) continue;
    if (userText.trim() === "/stats") {
      try {
        printStats(await client.getMetrics());
      } catch (err) {
        console.error("Could not fetch metrics:", err);
      }
      continue;
    }
    try {
      process.stdout.write(`${PERSONA_NAME}> `);
      const result = await client.sendStreaming(userText, (token) => process.stdout.write(token));
      process.stdout.write("\n");
      if (result.cacheHit) console.log("  (⚡ served from semantic cache)");
      if (result.personaCheck.correctionApplied) {
        console.log(`  (persona check caught a contradiction with "${result.personaCheck.conflictingFact}" and self-corrected)`);
      }
      console.log();
    } catch (err) {
      console.error("\nSomething went wrong talking to the backend:", err);
    }
  }
}

main();
