import { MemoryRepository } from "../memory/memory.repository.js";
import { GeminiClient } from "../llm/gemini.client.js";
import { PERSONA_SEED_FACTS, PERSONA_SYSTEM_PROMPT } from "./persona.data.js";
import { RetrievedFact } from "../../common/types.js";
import { Logger } from "../../common/logger.js";

export class PersonaService {
  private readonly logger = new Logger("PersonaService");

  constructor(private readonly personaRepo: MemoryRepository, private readonly llm: GeminiClient) {}

  /** Seed the persona's own backstory/opinions once, on first boot. */
  async seedIfEmpty(): Promise<void> {
    const existing = await this.personaRepo.findAllActive();
    if (existing.length > 0) return;
    this.logger.info(`Seeding ${PERSONA_SEED_FACTS.length} persona facts`);
    for (const fact of PERSONA_SEED_FACTS) {
      const embedding = await this.llm.embed(`${fact.subject} ${fact.predicate} ${fact.object}`);
      await this.personaRepo.insert(fact, embedding);
    }
  }

  buildSystemPrompt(retrievedUserFacts: RetrievedFact[], retrievedPersonaFacts: RetrievedFact[]): string {
    const userFactsBlock =
      retrievedUserFacts.length > 0
        ? [
            "",
            "What you remember about the user:",
            ...retrievedUserFacts.map((f) => `- ${f.predicate}: ${f.object}`),
          ].join("\n")
        : "";

    const personaFactsBlock =
      retrievedPersonaFacts.length > 0
        ? [
            "",
            "Relevant things you've said about yourself before (stay consistent with these):",
            ...retrievedPersonaFacts.map((f) => `- ${f.predicate}: ${f.object}`),
          ].join("\n")
        : "";

    return `${PERSONA_SYSTEM_PROMPT}${userFactsBlock}${personaFactsBlock}`;
  }
}
