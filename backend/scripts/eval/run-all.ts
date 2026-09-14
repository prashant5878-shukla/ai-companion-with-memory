import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalClient } from "./client.js";
import { ServerControl } from "./server-control.js";
import { connectEvalDb, resetUserMemoryAndSessions, resetPersonaDrift } from "./db-reset.js";
import { runPersistenceEval, printPersistenceReport } from "./run-persistence.js";
import { runRetrievalEval, printRetrievalReport } from "./run-retrieval.js";
import { runReconciliationEval, printReconciliationReport } from "./run-reconciliation.js";
import { runBaselineComparison, printBaselineReport } from "./run-baseline.js";
import { runPersonaEval, printPersonaReport } from "./run-persona.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, "..", "..");

type Suite = "persistence" | "retrieval" | "reconciliation" | "baseline" | "persona";
const ALL_SUITES: Suite[] = ["persistence", "retrieval", "reconciliation", "baseline", "persona"];

interface CliArgs {
  turns: number;
  runs: number;
  skipServerManagement: boolean;
  only: Set<Suite> | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: number) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? Number(args[idx + 1]) : fallback;
  };
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx !== -1 ? new Set(args[onlyIdx + 1].split(",") as Suite[]) : null;
  return {
    turns: get("--turns", 50),
    runs: get("--runs", 3),
    skipServerManagement: args.includes("--no-server-management"),
    only,
  };
}

async function main() {
  const { turns, runs, skipServerManagement, only } = parseArgs();
  const suites = only ?? new Set(ALL_SUITES);
  const client = new EvalClient();
  const serverControl = new ServerControl();

  await connectEvalDb();

  const alreadyUp = await client.health();
  if (!alreadyUp && !skipServerManagement) {
    console.log("Starting backend server for eval run...");
    await serverControl.start(BACKEND_ROOT);
  } else if (!alreadyUp) {
    throw new Error("Server not reachable and --no-server-management was passed");
  }

  console.log(`\nCompanion-AI Evaluation Harness`);
  console.log(`Params: suites=${[...suites].join(",")}; persona eval = ${turns} turns x ${runs} runs\n`);

  const startedAt = new Date();

  // Order matters: persistence first (it owns the one process restart), then suites that need
  // a clean fact store, resetting between each so results aren't cross-contaminated by an
  // architecture that deliberately doesn't scope memory per session (see db-reset.ts).
  const persistence = suites.has("persistence")
    ? await runPersistenceEval(client, serverControl, BACKEND_ROOT)
    : null;
  if (persistence) printPersistenceReport(persistence);

  let retrieval = null;
  if (suites.has("retrieval")) {
    await resetUserMemoryAndSessions();
    retrieval = await runRetrievalEval(client);
    printRetrievalReport(retrieval);
  }

  let reconciliation = null;
  if (suites.has("reconciliation")) {
    await resetUserMemoryAndSessions();
    reconciliation = await runReconciliationEval(client, resetUserMemoryAndSessions);
    printReconciliationReport(reconciliation);
  }

  let baseline = null;
  if (suites.has("baseline")) {
    await resetUserMemoryAndSessions();
    baseline = await runBaselineComparison(client);
    printBaselineReport(baseline);
  }

  let persona = null;
  if (suites.has("persona")) {
    await resetUserMemoryAndSessions();
    await resetPersonaDrift();
    persona = await runPersonaEval(client, turns, runs, async () => {
      await resetUserMemoryAndSessions();
      await resetPersonaDrift();
    });
    printPersonaReport(persona);
  }

  const finishedAt = new Date();

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    params: { suites: [...suites], personaTurns: turns, personaRuns: runs },
    persistence,
    retrieval,
    reconciliation,
    baseline,
    persona,
  };

  const outDir = join(BACKEND_ROOT, "eval-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `eval-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Full report written to ${outPath}`);
  console.log(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);

  if (!skipServerManagement) await serverControl.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
