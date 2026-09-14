import { EvalClient } from "./client.js";
import { buildPersonaConversation, PERSONA_PROBES } from "./persona-scenarios.js";
import { mean, stddev, pct } from "./metrics.js";

interface ProbeOutcome {
  runIndex: number;
  turnIndex: number;
  probeId: string;
  question: string;
  reply: string;
  consistent: boolean;
  contradicted: boolean;
  ambiguous: boolean;
  correctionApplied: boolean;
}

export interface PersonaEvalReport {
  suite: "persona";
  turnsPerRun: number;
  runs: number;
  outcomes: ProbeOutcome[];
  summary: {
    contradictionRate: number;
    ambiguousRate: number;
    contradictionsPerRun: number[];
    contradictionRateVariance: number;
    correctionRecoveryRate: number; // of contradictions, how many the post-gen checker caught
  };
  failures: ProbeOutcome[];
}

function judgeProbe(reply: string, probe: (typeof PERSONA_PROBES)[number]): "consistent" | "contradicted" | "ambiguous" {
  const lower = reply.toLowerCase();
  const contradicted = probe.contradictsIf.some((kw) => lower.includes(kw.toLowerCase()));
  if (contradicted) return "contradicted";
  const expected = probe.expectContains.some((kw) => lower.includes(kw.toLowerCase()));
  return expected ? "consistent" : "ambiguous";
}

export async function runPersonaEval(
  client: EvalClient,
  turnsPerRun: number,
  runs: number,
  resetBetweenRuns?: () => Promise<void>
): Promise<PersonaEvalReport> {
  const outcomes: ProbeOutcome[] = [];

  for (let runIndex = 0; runIndex < runs; runIndex++) {
    // Each run must be independent — memory here is global, not session-scoped (see
    // db-reset.ts), so without this a fact/opinion picked up in run 1 would bias run 2.
    if (runIndex > 0) await resetBetweenRuns?.();
    const sessionId = await client.newSession();
    const conversation = buildPersonaConversation(turnsPerRun);

    for (let turnIndex = 0; turnIndex < conversation.length; turnIndex++) {
      const turn = conversation[turnIndex];
      const result = await client.send(sessionId, turn.text);
      if (!turn.probeId) continue;

      const probe = PERSONA_PROBES.find((p) => p.id === turn.probeId)!;
      const judgment = judgeProbe(result.reply, probe);
      outcomes.push({
        runIndex,
        turnIndex,
        probeId: probe.id,
        question: turn.text,
        reply: result.reply,
        consistent: judgment === "consistent",
        contradicted: judgment === "contradicted",
        ambiguous: judgment === "ambiguous",
        correctionApplied: result.personaCheck.correctionApplied,
      });
    }
  }

  const contradictionsPerRun = Array.from({ length: runs }, (_, r) =>
    outcomes.filter((o) => o.runIndex === r && o.contradicted).length
  );
  const contradictions = outcomes.filter((o) => o.contradicted);
  const caughtByChecker = contradictions.filter((o) => o.correctionApplied).length;

  const summary = {
    contradictionRate: mean(outcomes.map((o) => (o.contradicted ? 1 : 0))),
    ambiguousRate: mean(outcomes.map((o) => (o.ambiguous ? 1 : 0))),
    contradictionsPerRun,
    contradictionRateVariance: stddev(contradictionsPerRun) ** 2,
    correctionRecoveryRate: contradictions.length > 0 ? caughtByChecker / contradictions.length : 1,
  };

  return { suite: "persona", turnsPerRun, runs, outcomes, summary, failures: contradictions };
}

export function printPersonaReport(report: PersonaEvalReport): void {
  console.log(`\n=== Persona Consistency over ${report.turnsPerRun} turns x ${report.runs} runs (issue #2) ===`);
  console.log(`Contradiction rate: ${pct(report.summary.contradictionRate)} (of ${report.outcomes.length} probes)`);
  console.log(`Ambiguous/soft-answer rate: ${pct(report.summary.ambiguousRate)}`);
  console.log(
    `Contradictions per run: [${report.summary.contradictionsPerRun.join(", ")}] (variance=${report.summary.contradictionRateVariance.toFixed(3)})`
  );
  console.log(
    `Post-generation checker recovery rate: ${pct(report.summary.correctionRecoveryRate)} of contradictions were caught & corrected`
  );
  if (report.failures.length > 0) {
    console.log(`Contradictions found:`);
    for (const f of report.failures) {
      console.log(
        `  run ${f.runIndex} turn ${f.turnIndex} [${f.probeId}] Q:"${f.question}" A:"${f.reply}" (corrected=${f.correctionApplied})`
      );
    }
  }
}
