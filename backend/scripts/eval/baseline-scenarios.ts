export interface BaselineScenario {
  id: string;
  description: string;
  seedMessage: string;
  /** Enough filler turns to push the seed fact outside the raw recent-message window (8 msgs = 4 exchanges). */
  fillerMessages: string[];
  probeQuestion: string;
  expectedKeywords: string[];
}

/**
 * Same scenario run twice — once with full memory retrieval, once in baseline mode (fixed
 * persona prompt + last-8-raw-messages only, no fact store) — to produce a real "full system
 * vs baseline" number (issue #12) instead of asserting the memory system helps. The filler
 * turns are the point: they push the seed fact outside baseline's raw window while full-system
 * retrieval keeps finding it regardless of turn distance.
 */
export const BASELINE_SCENARIOS: BaselineScenario[] = [
  {
    id: "occupation_after_gap",
    description: "Job fact recalled after enough turns to fall out of an 8-message raw window",
    seedMessage: "I'm a nurse at St. Mary's hospital downtown, three years in now.",
    fillerMessages: [
      "How's your day going?",
      "I'm pretty tired, long week.",
      "Any good recommendations for dinner tonight?",
      "I think I'm going to turn in early.",
      "Actually, one more thing — do you like tea or coffee more?",
      "Cool, noted.",
    ],
    probeQuestion: "Quick one — what did I say I do for work again?",
    expectedKeywords: ["nurse"],
  },
  {
    id: "relationship_after_gap",
    description: "Relationship-status fact recalled after a topic-shifted gap",
    seedMessage: "My partner and I just moved in together, really happy about it.",
    fillerMessages: [
      "What's your favorite season?",
      "I've been meaning to read more this year.",
      "Do you have a go-to comfort food?",
      "I might take up running again.",
      "What do you usually do on weekends?",
      "Anyway, random tangent, ignore that.",
    ],
    probeQuestion: "Hey, what's my living situation these days?",
    expectedKeywords: ["moved in", "living with", "partner"],
  },
  {
    id: "hobby_after_gap",
    description: "Preference fact recalled after a topic-shifted gap",
    seedMessage: "I really love hiking on weekends, it's my favorite way to unwind.",
    fillerMessages: [
      "What's a good movie you'd recommend?",
      "I'm thinking about learning to cook more.",
      "Do you prefer mornings or nights?",
      "I keep forgetting to water my plants.",
      "What's something small that made you happy recently?",
      "Anyway, different topic now.",
    ],
    probeQuestion: "What did I say I like doing on weekends?",
    expectedKeywords: ["hik"],
  },
];
