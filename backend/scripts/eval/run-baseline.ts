import { EvalClient } from "./client.js";
import { BASELINE_SCENARIOS } from "./baseline-scenarios.js";
import { mean, pct } from "./metrics.js";

interface ModeResult {
  scenarioId: string;
  reply: string;
  hit: boolean;
}

export interface BaselineEvalReport {
  suite: "baseline_comparison";
  full: ModeResult[];
  baseline: ModeResult[];
  summary: { fullRecall: number; baselineRecall: number; improvement: number };
}

async function runScenarios(client: EvalClient, useBaseline: boolean): Promise<ModeResult[]> {
  const results: ModeResult[] = [];
  for (const scenario of BASELINE_SCENARIOS) {
    const sessionId = await client.newSession();
    await client.send(sessionId, scenario.seedMessage, useBaseline);
    for (const filler of scenario.fillerMessages) {
      await client.send(sessionId, filler, useBaseline);
    }
    const probe = await client.send(sessionId, scenario.probeQuestion, useBaseline);
    const lower = probe.reply.toLowerCase();
    const hit = scenario.expectedKeywords.some((kw) => lower.includes(kw.toLowerCase()));
    results.push({ scenarioId: scenario.id, reply: probe.reply, hit });
  }
  return results;
}

export async function runBaselineComparison(client: EvalClient): Promise<BaselineEvalReport> {
  const full = await runScenarios(client, false);
  const baseline = await runScenarios(client, true);
  const fullRecall = mean(full.map((r) => (r.hit ? 1 : 0)));
  const baselineRecall = mean(baseline.map((r) => (r.hit ? 1 : 0)));
  return {
    suite: "baseline_comparison",
    full,
    baseline,
    summary: { fullRecall, baselineRecall, improvement: fullRecall - baselineRecall },
  };
}

export function printBaselineReport(report: BaselineEvalReport): void {
  console.log("\n=== Full System vs Baseline (issue #12) ===");
  console.log(`Full-system recall after topic gap:  ${pct(report.summary.fullRecall)}`);
  console.log(`Baseline (recent-history-only) recall: ${pct(report.summary.baselineRecall)}`);
  console.log(`Improvement: +${pct(report.summary.improvement)}`);
  for (let i = 0; i < report.full.length; i++) {
    const f = report.full[i];
    const b = report.baseline[i];
    console.log(`  [${f.scenarioId}] full=${f.hit ? "HIT" : "MISS"} baseline=${b.hit ? "HIT" : "MISS"}`);
    if (!f.hit) console.log(`    full reply: "${f.reply}"`);
    if (!b.hit) console.log(`    baseline reply: "${b.reply}"`);
  }
}
