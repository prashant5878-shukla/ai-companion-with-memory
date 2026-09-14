export interface PersonaProbe {
  id: string;
  question: string;
  /** Any match (case-insensitive substring) in the reply confirms the established stance. */
  expectContains: string[];
  /** Any match flags a genuine contradiction of the established stance. */
  contradictsIf: string[];
}

/** One probe per fixed persona trait declared in persona.data.ts's PERSONA_CORE_CLAIMS. */
export const PERSONA_PROBES: PersonaProbe[] = [
  {
    id: "astrology",
    question: "Random question — are you into astrology at all, like star signs and stuff?",
    expectContains: ["skeptic", "not really", "don't really believe", "not big on", "not much into", "doubt"],
    contradictsIf: ["i love astrology", "i'm really into astrology", "big into astrology", "believe in astrology"],
  },
  {
    id: "music",
    question: "What kind of music do you like listening to?",
    expectContains: ["jazz"],
    contradictsIf: ["hate jazz", "not really into jazz", "don't like jazz", "can't stand jazz"],
  },
  {
    id: "weather",
    question: "What's your favorite kind of weather?",
    expectContains: ["rain"],
    contradictsIf: ["hate rain", "sunny is my favorite", "love sunny days most", "sunshine is my favorite"],
  },
  {
    id: "hometown",
    question: "Where did you grow up, anyway?",
    expectContains: ["coast", "sea", "small town", "lighthouse"],
    contradictsIf: ["grew up in a big city", "born and raised in the city", "grew up downtown in a huge city"],
  },
  {
    id: "reading",
    question: "Reading anything good lately?",
    expectContains: ["mystery"],
    contradictsIf: ["don't really read", "not much of a reader", "never read books"],
  },
];

/** Filler messages simulating ordinary conversation between probes, to stress-test drift. */
export const FILLER_MESSAGES: string[] = [
  "Ugh, long day. How's yours going?",
  "I finally finished that thing I was putting off, feels good.",
  "Do you ever just want to stay in bed all day?",
  "I tried a new recipe last night, it was a disaster honestly.",
  "Work was chaos today, don't even ask.",
  "I've been meaning to call my parents, keep forgetting.",
  "Any recommendations for something to watch tonight?",
  "I think I'm getting a cold, my throat's scratchy.",
  "Took a walk earlier, the weather was nice.",
  "I'm procrastinating so hard on laundry right now.",
  "Someone cut me off in traffic today and I'm still annoyed.",
  "I finally organized my desk, feels like a fresh start.",
  "Do you have a favorite way to spend a lazy Sunday?",
  "I keep losing my phone charger somewhere in this apartment.",
  "Thinking about picking up a new hobby, not sure what though.",
  "My coffee machine broke this morning, tragic start to the day.",
  "I had a weird dream last night I can't stop thinking about.",
  "Finally got around to cleaning out my inbox, so satisfying.",
  "I've been on a bit of a cooking kick lately.",
  "Not gonna lie, today just felt like a Monday even though it wasn't.",
];

/**
 * Interleaves probes evenly across `turns`, filling the rest with cycled filler messages —
 * simulates a real multi-topic conversation rather than back-to-back interrogation, which is
 * what actually stresses persona drift (issue #2).
 */
export function buildPersonaConversation(turns: number): Array<{ text: string; probeId?: string }> {
  const conversation: Array<{ text: string; probeId?: string }> = [];
  const probeCount = PERSONA_PROBES.length;
  const spacing = Math.max(1, Math.floor(turns / (probeCount + 1)));
  const probeTurnIndices = new Set(
    Array.from({ length: probeCount }, (_, i) => Math.min(turns - 1, spacing * (i + 1)))
  );

  let probeCursor = 0;
  let fillerCursor = 0;
  for (let turn = 0; turn < turns; turn++) {
    if (probeTurnIndices.has(turn) && probeCursor < probeCount) {
      const probe = PERSONA_PROBES[probeCursor++];
      conversation.push({ text: probe.question, probeId: probe.id });
    } else {
      conversation.push({ text: FILLER_MESSAGES[fillerCursor % FILLER_MESSAGES.length] });
      fillerCursor++;
    }
  }
  // Guarantee every probe fires even if `turns` is small enough that spacing skipped one.
  while (probeCursor < probeCount) {
    conversation.push({ text: PERSONA_PROBES[probeCursor].question, probeId: PERSONA_PROBES[probeCursor].id });
    probeCursor++;
  }
  return conversation;
}
