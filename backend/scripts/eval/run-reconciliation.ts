import { EvalClient } from "./client.js";
import { RECONCILIATION_SCENARIOS } from "./reconciliation-scenarios.js";
import { mean, pct } from "./metrics.js";

interface ScenarioResult {
  scenarioId: string;
  description: string;
  expectedRelation: "refines" | "contradicts";
  observedRelation: string | null;
  relationCorrect: boolean;
  /** For 'contradicts': old fact flipped to superseded with supersededBy set. */
  supersedeCorrect: boolean | null;
  /** For 'refines': same document updated in place (no new active row for that predicate). */
  consolidationCorrect: boolean | null;
  activeFactObject: string | null;
  activeFactContainsExpected: boolean;
}

export interface ReconciliationEvalReport {
  suite: "reconciliation";
  scenarios: ScenarioResult[];
  summary: {
    relationAccuracy: number;
    supersedeAccuracy: number;
    consolidationAccuracy: number;
  };
  failures: ScenarioResult[];
}

export async function runReconciliationEval(
  client: EvalClient,
  resetBetweenScenarios?: () => Promise<void>
): Promise<ReconciliationEvalReport> {
  const scenarios: ScenarioResult[] = [];

  for (const scenario of RECONCILIATION_SCENARIOS) {
    // Isolation between scenarios matters here more than in the other suites: memory is global
    // (not session-scoped), and `listAll()` returns oldest-first, so without a reset a later
    // scenario's "find the active fact I just created" could silently grab an EARLIER
    // scenario's leftover fact instead — a real bug caught by running this suite twice with
    // scenarios in a fixed order and seeing job_refinement/preference_refinement fail only when
    // something else ran first. See FIXES_REPORT.md #1.
    await resetBetweenScenarios?.();

    const sessionId = await client.newSession();
    await client.send(sessionId, scenario.setup);
    const before = await client.listFacts();
    // Each scenario's setup is a single simple statement, so exactly one active fact should
    // exist at this point — this is the specific document `refines`/`contradicts` acts on.
    const setupFactId = before.userFacts.find((f) => f.status === "active")?.id ?? null;

    const followUpResult = await client.send(sessionId, scenario.followUp);
    const after = await client.listFacts();

    const reconEntry = followUpResult.reconciliation.find(
      (r) =>
        r.fact.subject === "user" && (r.relation === "refines" || r.relation === "contradicts" || r.relation === "same")
    );
    const observedRelation = reconEntry?.relation ?? null;
    const relationCorrect = observedRelation === scenario.expectedRelation;

    let supersedeCorrect: boolean | null = null;
    let consolidationCorrect: boolean | null = null;

    if (scenario.expectedRelation === "contradicts") {
      const setupFact = setupFactId ? after.userFacts.find((f) => f.id === setupFactId) : undefined;
      supersedeCorrect = setupFact?.status === "superseded" && setupFact.supersededBy !== null;
    } else {
      // refines/same: the ORIGINAL fact must still exist under the SAME id, still active, now
      // carrying the refined content — i.e. updated in place, not superseded or duplicated.
      // This does NOT require the total fact count to stay flat: a refinement message can
      // legitimately introduce a second, genuinely new fact (e.g. "...at Microsoft" adds an
      // `employer` fact alongside refining `job_title` in place) — checking raw counts conflated
      // that with a failure to consolidate. See FIXES_REPORT.md #1 for why this metric changed
      // after a real run caught the false positive.
      const setupFact = setupFactId ? after.userFacts.find((f) => f.id === setupFactId) : undefined;
      const objectLower = setupFact?.object.toLowerCase() ?? "";
      consolidationCorrect =
        setupFact !== undefined &&
        setupFact.status === "active" &&
        scenario.expectedActiveKeywords.some((kw) => objectLower.includes(kw.toLowerCase()));
    }

    const activeMatch = after.userFacts
      .filter((f) => f.status === "active")
      .find((f) => scenario.expectedActiveKeywords.some((kw) => f.object.toLowerCase().includes(kw.toLowerCase())));

    scenarios.push({
      scenarioId: scenario.id,
      description: scenario.description,
      expectedRelation: scenario.expectedRelation,
      observedRelation,
      relationCorrect,
      supersedeCorrect,
      consolidationCorrect,
      activeFactObject: activeMatch?.object ?? null,
      activeFactContainsExpected: activeMatch !== undefined,
    });
  }

  const outcomeCorrect = (s: ScenarioResult) =>
    s.expectedRelation === "contradicts" ? s.supersedeCorrect === true : s.consolidationCorrect === true;

  const summary = {
    relationAccuracy: mean(scenarios.map((s) => (s.relationCorrect ? 1 : 0))),
    supersedeAccuracy: mean(
      scenarios.filter((s) => s.expectedRelation === "contradicts").map((s) => (s.supersedeCorrect ? 1 : 0))
    ),
    consolidationAccuracy: mean(
      scenarios.filter((s) => s.expectedRelation === "refines").map((s) => (s.consolidationCorrect ? 1 : 0))
    ),
  };

  return {
    suite: "reconciliation",
    scenarios,
    summary,
    failures: scenarios.filter((s) => !s.relationCorrect || !outcomeCorrect(s) || !s.activeFactContainsExpected),
  };
}

export function printReconciliationReport(report: ReconciliationEvalReport): void {
  console.log("\n=== Contradiction / Refinement Handling (issues #1, #10) ===");
  console.log(`Relation classification accuracy: ${pct(report.summary.relationAccuracy)}`);
  console.log(`Supersession accuracy (contradicts): ${pct(report.summary.supersedeAccuracy)}`);
  console.log(`Consolidation accuracy (refines):     ${pct(report.summary.consolidationAccuracy)}`);
  for (const s of report.scenarios) {
    const ok = s.relationCorrect && s.activeFactContainsExpected;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} [${s.scenarioId}] expected=${s.expectedRelation} observed=${s.observedRelation} active="${s.activeFactObject}"`
    );
  }
}
