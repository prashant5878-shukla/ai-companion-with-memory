export interface RetrievalQuery {
  id: string;
  text: string;
  kind: "direct" | "paraphrase" | "indirect" | "distractor_check";
  /** Any of these substrings (case-insensitive) in a retrieved fact's `object` counts as a hit. */
  expectedKeywords: string[];
}

export interface RetrievalScenario {
  id: string;
  description: string;
  /** Messages sent first, in order, to plant the target fact and a same-category distractor. */
  seedMessages: string[];
  queries: RetrievalQuery[];
}

/**
 * Ground-truth retrieval scenarios (issue #3). Each seeds a target fact plus a same-category
 * distractor, then probes with direct/paraphrase/indirect phrasing and one distractor-check
 * query whose correct answer is the OTHER fact — this is what actually tests "did the system
 * retrieve the right memory", not just "did it retrieve *a* memory".
 */
export const RETRIEVAL_SCENARIOS: RetrievalScenario[] = [
  {
    id: "occupation",
    description: "Direct/paraphrase/indirect recall of a job fact, with a same-category distractor",
    seedMessages: [
      "I'm a nurse at St. Mary's hospital downtown, been there about three years.",
      "My best friend Jordan is a firefighter across town.",
    ],
    queries: [
      { id: "direct", text: "What do I do for work?", kind: "direct", expectedKeywords: ["nurse"] },
      { id: "paraphrase", text: "What's my job again, remind me?", kind: "paraphrase", expectedKeywords: ["nurse"] },
      {
        id: "indirect",
        text: "I had a rough shift today, my feet are killing me.",
        kind: "indirect",
        expectedKeywords: ["nurse"],
      },
      {
        id: "distractor_check",
        text: "What does Jordan do for a living?",
        kind: "distractor_check",
        expectedKeywords: ["firefighter"],
      },
    ],
  },
  {
    id: "family_names",
    description: "Distractor resistance between two people sharing a name in different roles",
    seedMessages: [
      "My sister Maya just got engaged last weekend, I'm so happy for her.",
      "My coworker Maya transferred to the downtown branch this month.",
    ],
    queries: [
      { id: "direct", text: "What's my sister's name?", kind: "direct", expectedKeywords: ["sister"] },
      {
        id: "indirect",
        text: "Who in my family just got some big exciting news?",
        kind: "indirect",
        expectedKeywords: ["engaged", "sister"],
      },
      {
        id: "distractor_check",
        text: "What happened with my coworker recently?",
        kind: "distractor_check",
        expectedKeywords: ["coworker", "transfer"],
      },
    ],
  },
  {
    id: "travel_plan",
    description: "Recall of a plan/goal fact with a low-conviction distractor aside",
    seedMessages: [
      "I'm planning a trip to Portugal next spring, been saving up for it for months.",
      "I've also idly wondered about repainting the kitchen someday, no real plan there.",
    ],
    queries: [
      { id: "direct", text: "Where am I planning to travel?", kind: "direct", expectedKeywords: ["portugal"] },
      {
        id: "paraphrase",
        text: "Where's that upcoming trip of mine headed?",
        kind: "paraphrase",
        expectedKeywords: ["portugal"],
      },
    ],
  },
  {
    id: "weekend_preference",
    description: "Preference recall with an explicit dislike as distractor",
    seedMessages: [
      "I really love hiking on weekends, it's my favorite way to unwind after a long week.",
      "I can't stand crowded gyms though, they stress me out.",
    ],
    queries: [
      { id: "direct", text: "What do I like doing on weekends?", kind: "direct", expectedKeywords: ["hik"] },
      {
        id: "indirect",
        text: "I've got a totally free Saturday coming up, any ideas what I'd enjoy?",
        kind: "indirect",
        expectedKeywords: ["hik"],
      },
    ],
  },
];
