export interface ReconciliationScenario {
  id: string;
  description: string;
  setup: string;
  followUp: string;
  expectedRelation: "refines" | "contradicts";
  /** Any of these substrings (case-insensitive) surviving into the final active fact's `object` counts as a match. */
  expectedActiveKeywords: string[];
}

/**
 * Ground-truth contradiction/refinement scenarios (issues #1, #10). `refines` must
 * consolidate into ONE stronger active fact in place; `contradicts` must supersede the old
 * fact (status flips, new fact becomes active) — these are checked as distinct outcomes, not
 * just "did the classifier pick a label".
 */
export const RECONCILIATION_SCENARIOS: ReconciliationScenario[] = [
  {
    id: "relationship_breakup",
    description: "The brief's own worked example: living together, then a breakup",
    setup: "My partner and I just moved in together, we're really happy.",
    followUp: "Update: I broke up with my ex, it's over between us. I moved out.",
    expectedRelation: "contradicts",
    expectedActiveKeywords: ["broke", "breakup", "single", "ended", "no longer", "moved out"],
  },
  {
    id: "job_refinement",
    description: "Reviewer's own example: generic job title refined with employer detail",
    setup: "I'm a developer, been coding for a few years now.",
    followUp: "To be more specific, I'm a backend developer at Microsoft.",
    expectedRelation: "refines",
    expectedActiveKeywords: ["backend"],
  },
  {
    id: "relocation",
    description: "A residence fact that becomes false, not just more detailed",
    setup: "I live in Seattle, have for a while.",
    followUp: "Actually I just moved to Austin last month, totally different pace of life.",
    expectedRelation: "contradicts",
    expectedActiveKeywords: ["austin"],
  },
  {
    id: "preference_refinement",
    description: "A preference refined with more specificity, not contradicted",
    setup: "I like tea quite a bit.",
    followUp: "I really love earl grey tea specifically, it's my favorite by far.",
    expectedRelation: "refines",
    expectedActiveKeywords: ["earl grey"],
  },
];
