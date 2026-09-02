import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { Database } from "./config/database.js";
import { Logger } from "./common/logger.js";

import { GeminiClient } from "./modules/llm/gemini.client.js";
import { FactModel, PersonaFactModel } from "./modules/memory/fact.model.js";
import { MemoryRepository } from "./modules/memory/memory.repository.js";
import { MemoryService } from "./modules/memory/memory.service.js";
import { PersonaService } from "./modules/persona/persona.service.js";
import { SessionRepository } from "./modules/session/session.repository.js";
import { SessionService } from "./modules/session/session.service.js";
import { RedisCache } from "./modules/cache/redis-client.js";
import { SemanticCacheService } from "./modules/cache/semantic-cache.service.js";
import { ChatGraphNodes } from "./modules/chat/chat.graph.js";
import { ChatService } from "./modules/chat/chat.service.js";
import { ChatController } from "./modules/chat/chat.controller.js";
import { chatRoutes } from "./modules/chat/chat.routes.js";
import { MemoryController } from "./modules/memory/memory.controller.js";
import { memoryRoutes } from "./modules/memory/memory.routes.js";
import { MetricsRepository } from "./modules/observability/metrics.repository.js";
import { MetricsService } from "./modules/observability/metrics.service.js";
import { MetricsController } from "./modules/observability/metrics.controller.js";
import { metricsRoutes } from "./modules/observability/metrics.routes.js";

const logger = new Logger("Server");

async function bootstrap() {
  await Database.connect();

  const redisClient = await RedisCache.connect();
  const cache = redisClient ? new SemanticCacheService(redisClient) : SemanticCacheService.disabled();
  await cache.ensureIndex();

  const metricsRepo = new MetricsRepository();
  const metrics = new MetricsService(metricsRepo);

  const llm = new GeminiClient(metrics);

  const userFactRepo = new MemoryRepository(FactModel);
  const personaFactRepo = new MemoryRepository(PersonaFactModel);
  const userMemory = new MemoryService(userFactRepo, llm);
  const personaMemory = new MemoryService(personaFactRepo, llm);

  const persona = new PersonaService(personaFactRepo, llm);
  try {
    await persona.seedIfEmpty();
  } catch (err) {
    logger.warn(
      "Persona seeding failed (likely a missing/invalid GEMINI_API_KEY) — server will still start, " +
        "but chat requests will fail until a valid key is set and the server is restarted.",
      err
    );
  }

  const sessionRepo = new SessionRepository();
  const sessionService = new SessionService(sessionRepo);

  const chatGraphNodes = new ChatGraphNodes(userMemory, personaMemory);
  const chatService = new ChatService(
    sessionService,
    userMemory,
    personaMemory,
    persona,
    llm,
    cache,
    metrics,
    chatGraphNodes
  );
  const chatController = new ChatController(chatService);
  const memoryController = new MemoryController(userFactRepo, personaFactRepo);
  const metricsController = new MetricsController(metrics);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", chatRoutes(chatController));
  app.use("/api/memory", memoryRoutes(memoryController));
  app.use("/api/metrics", metricsRoutes(metricsController));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.listen(env.port, () => {
    logger.info(`Companion-AI backend listening on http://localhost:${env.port}`);
  });
}

bootstrap().catch((err) => {
  logger.error("Failed to start server", err);
  process.exit(1);
});
