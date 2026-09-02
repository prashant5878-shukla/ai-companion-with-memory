import type { Request, Response } from "express";
import { MemoryRepository, StoredFact } from "./memory.repository.js";

function withoutEmbedding(fact: StoredFact): Omit<StoredFact, "embedding"> {
  const { embedding: _embedding, ...rest } = fact;
  return rest;
}

export class MemoryController {
  constructor(
    private readonly userFactRepo: MemoryRepository,
    private readonly personaFactRepo: MemoryRepository
  ) {}

  listAll = async (_req: Request, res: Response): Promise<void> => {
    const [userFacts, personaFacts] = await Promise.all([
      this.userFactRepo.listAll(),
      this.personaFactRepo.listAll(),
    ]);
    res.json({
      userFacts: userFacts.map(withoutEmbedding),
      personaFacts: personaFacts.map(withoutEmbedding),
    });
  };
}
