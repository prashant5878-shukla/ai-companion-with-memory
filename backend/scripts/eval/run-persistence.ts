import { EvalClient } from "./client.js";
import { ServerControl } from "./server-control.js";

export interface PersistenceEvalReport {
  suite: "persistence";
  crossSessionHit: boolean;
  crossProcessRestartHit: boolean;
  crossProcessReply: string;
}

const SEED_MESSAGE = "For the record: my dog's name is Biscuit and he's a very good boy.";
const PROBE_MESSAGE = "What's my dog's name again?";

/**
 * Issue #1/#11 "Persistence: Cross-session recall". Two checks:
 * 1. A fact stored in session A is retrievable from session B (memory isn't session-scoped —
 *    it's the durable store, not the transcript).
 * 2. The fact survives an actual process restart of the backend server — the strongest
 *    available proof that memory lives in Mongo, not in-process state. This literally kills
 *    and respawns the server child process mid-test.
 */
export async function runPersistenceEval(
  client: EvalClient,
  serverControl: ServerControl,
  backendCwd: string
): Promise<PersistenceEvalReport> {
  const sessionA = await client.newSession();
  await client.send(sessionA, SEED_MESSAGE);

  const sessionB = await client.newSession();
  const crossSessionResult = await client.send(sessionB, PROBE_MESSAGE);
  const crossSessionHit = crossSessionResult.reply.toLowerCase().includes("biscuit");

  await serverControl.restart(backendCwd);

  const sessionC = await client.newSession();
  const crossProcessResult = await client.send(sessionC, PROBE_MESSAGE);
  const crossProcessRestartHit = crossProcessResult.reply.toLowerCase().includes("biscuit");

  return {
    suite: "persistence",
    crossSessionHit,
    crossProcessRestartHit,
    crossProcessReply: crossProcessResult.reply,
  };
}

export function printPersistenceReport(report: PersistenceEvalReport): void {
  console.log("\n=== Persistence (issue #1: cross-session recall) ===");
  console.log(`Cross-session recall (session A -> session B): ${report.crossSessionHit ? "PASS" : "FAIL"}`);
  console.log(
    `Cross-process recall (survives server restart):        ${report.crossProcessRestartHit ? "PASS" : "FAIL"}`
  );
  if (!report.crossProcessRestartHit) {
    console.log(`  reply after restart: "${report.crossProcessReply}"`);
  }
}
