import { SessionService } from "../session/session.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { PersonaService } from "../persona/persona.service.js";
import { GeminiClient } from "../llm/gemini.client.js";
import { SemanticCacheService } from "../cache/semantic-cache.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { buildChatGraph, ChatGraphNodes } from "./chat.graph.js";
import { ChatTurnResult } from "../../common/types.js";

type CompiledGraph = ReturnType<typeof buildChatGraph>;

export class ChatService {
  private readonly graph: CompiledGraph;

  constructor(
    private readonly sessionService: SessionService,
    private readonly userMemory: MemoryService,
    private readonly personaMemory: MemoryService,
    private readonly persona: PersonaService,
    private readonly llm: GeminiClient,
    private readonly cache: SemanticCacheService,
    private readonly metrics: MetricsService,
    nodes: ChatGraphNodes
  ) {
    this.graph = buildChatGraph(nodes);
  }

  async resumeSession(): Promise<string> {
    return this.sessionService.resumeOrCreateSession();
  }

  async newSession(): Promise<string> {
    return this.sessionService.startNewSession();
  }

  /**
   * Runs one turn. Retrieval, cache lookup, and reply generation happen here as plain
   * sequential calls (not graph nodes) so the reply can stream to the caller via `onToken`
   * as it's generated; only the post-reply extract/reconcile step runs through LangGraph.
   */
  async sendMessage(
    sessionId: string,
    userText: string,
    onToken?: (chunk: string) => void
  ): Promise<ChatTurnResult> {
    const recentMessages = await this.sessionService.getRecentMessages(sessionId);
    const sourceMessageId = await this.sessionService.addUserMessage(sessionId, userText);

    const queryEmbedding = await this.llm.embed(userText);
    const [retrievedUserFacts, retrievedPersonaFacts] = await Promise.all([
      this.userMemory.retrieve(queryEmbedding),
      this.personaMemory.retrieve(queryEmbedding),
    ]);

    const contextHash = SemanticCacheService.hashContext(retrievedUserFacts, retrievedPersonaFacts);
    const cachedReply = await this.cache.lookup(sessionId, contextHash, queryEmbedding);

    let reply: string;
    const cacheHit = cachedReply !== null;
    if (cachedReply !== null) {
      reply = cachedReply;
      onToken?.(cachedReply); // nothing to stream incrementally — it really was instant
      await this.metrics.recordCacheHit(this.llm.chatModelName, sessionId);
    } else {
      const systemPrompt = this.persona.buildSystemPrompt(retrievedUserFacts, retrievedPersonaFacts);
      const messages = [...recentMessages, { role: "user" as const, content: userText }];
      reply = await this.llm.streamReply(systemPrompt, messages, onToken, sessionId);
      await this.cache.store(sessionId, contextHash, queryEmbedding, reply);
    }

    await this.sessionService.addAssistantMessage(sessionId, reply);

    const graphResult = await this.graph.invoke({ userMessage: userText, reply, sourceMessageId });

    return {
      reply,
      retrievedFacts: retrievedUserFacts,
      newFacts: [...graphResult.extractedUserFacts, ...graphResult.extractedPersonaFacts],
      reconciliation: graphResult.reconciliation,
      cacheHit,
    };
  }
}
