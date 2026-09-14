import { EvalClient } from "./client.js";
import { RETRIEVAL_SCENARIOS } from "./retrieval-scenarios.js";
import { mean, firstRelevantIndex, reciprocalRank, pct } from "./metrics.js";
import type { RetrievedFact } from "../../src/common/types.js";

interface QueryResult {
  scenarioId: string;
  queryId: string;
  kind: string;
  text: string;
  hit: boolean;
  precisionAtK: number;
  reciprocalRank: number;
  retrieved: Array<{ predicate: string; object: string; score: number }>;
}

export interface RetrievalEvalReport {
  suite: "retrieval";
  queries: QueryResult[];
  summary: {
    recallAtK: number;
    meanPrecisionAtK: number;
    mrr: number;
    byKind: Record<string, { recallAtK: number; count: number }>;
  };
  failures: QueryResult[];
}

function isRelevant(fact: RetrievedFact, keywords: string[]): boolean {
  const obj = fact.object.toLowerCase();
  return keywords.some((kw) => obj.includes(kw.toLowerCase()));
}

export async function runRetrievalEval(client: EvalClient): Promise<RetrievalEvalReport> {
  const queries: QueryResult[] = [];

  for (const scenario of RETRIEVAL_SCENARIOS) {
    const sessionId = await client.newSession();
    for (const msg of scenario.seedMessages) {
      await client.send(sessionId, msg);
    }
    // A couple of neutral turns so retrieval has to actually discriminate on topic, not just
    // "most recent thing said".
    await client.send(sessionId, "Anyway, how's your day going?");

    for (const query of scenario.queries) {
      const result = await client.send(sessionId, query.text);
      const retrieved = result.retrievedFacts;
      const idx = firstRelevantIndex(retrieved, (f) => isRelevant(f, query.expectedKeywords));
      const relevantCount = retrieved.filter((f) => isRelevant(f, query.expectedKeywords)).length;

      queries.push({
        scenarioId: scenario.id,
        queryId: query.id,
        kind: query.kind,
        text: query.text,
        hit: idx !== -1,
        precisionAtK: retrieved.length > 0 ? relevantCount / retrieved.length : 0,
        reciprocalRank: reciprocalRank(idx),
        retrieved: retrieved.map((f) => ({ predicate: f.predicate, object: f.object, score: f.score })),
      });
    }
  }

  const byKind: Record<string, { recallAtK: number; count: number }> = {};
  for (const kind of new Set(queries.map((q) => q.kind))) {
    const subset = queries.filter((q) => q.kind === kind);
    byKind[kind] = { recallAtK: mean(subset.map((q) => (q.hit ? 1 : 0))), count: subset.length };
  }

  const summary = {
    recallAtK: mean(queries.map((q) => (q.hit ? 1 : 0))),
    meanPrecisionAtK: mean(queries.map((q) => q.precisionAtK)),
    mrr: mean(queries.map((q) => q.reciprocalRank)),
    byKind,
  };

  return { suite: "retrieval", queries, summary, failures: queries.filter((q) => !q.hit) };
}

export function printRetrievalReport(report: RetrievalEvalReport): void {
  console.log("\n=== Retrieval Quality (issue #3) ===");
  console.log(`Recall@K:        ${pct(report.summary.recallAtK)}`);
  console.log(`Mean Precision@K: ${pct(report.summary.meanPrecisionAtK)}`);
  console.log(`MRR:             ${report.summary.mrr.toFixed(3)}`);
  for (const [kind, s] of Object.entries(report.summary.byKind)) {
    console.log(`  ${kind.padEnd(18)} recall@K=${pct(s.recallAtK)} (n=${s.count})`);
  }
  if (report.failures.length > 0) {
    console.log(`Failures (${report.failures.length}):`);
    for (const f of report.failures) {
      console.log(`  [${f.scenarioId}/${f.queryId}] "${f.text}" -> retrieved: ${JSON.stringify(f.retrieved)}`);
    }
  }
}
