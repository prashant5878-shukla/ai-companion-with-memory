import { SessionService } from "../session/session.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { PersonaService } from "../persona/persona.service.js";
import { PERSONA_CORE_CLAIMS, PERSONA_SYSTEM_PROMPT } from "../persona/persona.data.js";
import { GeminiClient } from "../llm/gemini.client.js";
import { SemanticCacheService } from "../cache/semantic-cache.service.js";
import { MetricsService } from "../observability/metrics.service.js";
import { TurnLogRepository } from "../observability/turn-log.repository.js";
import { buildChatGraph, ChatGraphNodes } from "./chat.graph.js";
import { ChatTurnResult, PersonaConsistencyResult, RetrievedFact } from "../../common/types.js";
import { Logger } from "../../common/logger.js";

type CompiledGraph = ReturnType<typeof buildChatGraph>;

export interface SendMessageOptions {
  /**
   * Baseline mode (issue #12): skip fact retrieval/persona-fact injection entirely — reply
   * using only the fixed persona prompt + the raw recent-message window, the way a plain
   * recent-history/system-prompt chatbot would. Still extracts+reconciles facts in the
   * background so the harness can compare identical scenarios turn-for-turn, but nothing
   * retrieved actually reaches the prompt. Exists purely so the eval harness can produce a
   * real "full system vs baseline" number instead of asserting the memory system helps.
   */
  baseline?: boolean;
}

const NO_PERSONA_CHECK: PersonaConsistencyResult = {
  checked: false,
  consistent: true,
  correctionApplied: false,
};

export class ChatService {
  private readonly graph: CompiledGraph;
  private readonly logger = new Logger("ChatService");

  constructor(
    private readonly sessionService: SessionService,
    private readonly userMemory: MemoryService,
    private readonly personaMemory: MemoryService,
    private readonly persona: PersonaService,
    private readonly llm: GeminiClient,
    private readonly cache: SemanticCacheService,
    private readonly metrics: MetricsService,
    private readonly turnLogs: TurnLogRepository,
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
    onToken?: (chunk: string) => void,
    options: SendMessageOptions = {}
  ): Promise<ChatTurnResult> {
    const mode = options.baseline ? "baseline" : "full";
    const recentMessages = await this.sessionService.getRecentMessages(sessionId);
    const sourceMessageId = await this.sessionService.addUserMessage(sessionId, userText);

    const queryEmbedding = await this.llm.embed(userText);
    const [retrievedUserFacts, retrievedPersonaFacts]: [RetrievedFact[], RetrievedFact[]] = options.baseline
      ? [[], []]
      : await Promise.all([this.userMemory.retrieve(queryEmbedding), this.personaMemory.retrieve(queryEmbedding)]);

    // Baseline mode never touches the cache — it isn't the thing under test, and a baseline
    // reply cached under a memory-derived contextHash would be a category error.
    const contextHash = SemanticCacheService.hashContext(retrievedUserFacts, retrievedPersonaFacts);
    const cachedReply = options.baseline ? null : await this.cache.lookup(sessionId, contextHash, queryEmbedding);

    let reply: string;
    let personaCheck: PersonaConsistencyResult = NO_PERSONA_CHECK;
    const cacheHit = cachedReply !== null;
    if (cachedReply !== null) {
      reply = cachedReply;
      onToken?.(cachedReply); // nothing to stream incrementally — it really was instant
      await this.metrics.recordCacheHit(this.llm.chatModelName, sessionId);
    } else {
      const systemPrompt = options.baseline
        ? PERSONA_SYSTEM_PROMPT
        : this.persona.buildSystemPrompt(retrievedUserFacts, retrievedPersonaFacts);
      const messages = [...recentMessages, { role: "user" as const, content: userText }];
      reply = await this.llm.streamReply(systemPrompt, messages, onToken, sessionId);

      if (!options.baseline) {
        const checked = await this.runPersonaCheck(reply, retrievedPersonaFacts, onToken);
        personaCheck = checked.result;
        reply = checked.reply; // includes the appended correction, if one was generated
      }

      await this.cache.store(sessionId, contextHash, queryEmbedding, reply);
    }

    await this.sessionService.addAssistantMessage(sessionId, reply);

    // Baseline mode still extracts/reconciles in the background (so the harness can inspect
    // "what would have been remembered") but the reply above never saw any of it.
    const graphResult = await this.graph.invoke({ userMessage: userText, reply, sourceMessageId });

    const result: ChatTurnResult = {
      reply,
      retrievedFacts: retrievedUserFacts,
      retrievedPersonaFacts,
      newFacts: [...graphResult.extractedUserFacts, ...graphResult.extractedPersonaFacts],
      reconciliation: graphResult.reconciliation,
      cacheHit,
      personaCheck,
      mode,
    };

    await this.turnLogs.record(sessionId, userText, result).catch((err) => {
      this.logger.warn("Failed to record turn log (non-fatal)", err);
    });

    return result;
  }

  /**
   * Issue #6: judge the just-generated reply against the persona facts actually retrieved
   * this turn plus the fixed core claims (see PERSONA_CORE_CLAIMS), and if it contradicts one,
   * stream a short in-character self-correction right after it. See
   * GeminiClient.generateCorrection for why this appends rather than regenerates.
   */
  private async runPersonaCheck(
    reply: string,
    retrievedPersonaFacts: RetrievedFact[],
    onToken?: (chunk: string) => void
  ): Promise<{ result: PersonaConsistencyResult; reply: string }> {
    const candidateFacts = [
      ...PERSONA_CORE_CLAIMS,
      ...retrievedPersonaFacts.map((f) => `${f.predicate}: ${f.object}`),
    ];
    const checkResult = await this.llm.checkPersonaConsistency(reply, candidateFacts);
    if (checkResult.consistent) {
      return { result: { checked: true, consistent: true, correctionApplied: false }, reply };
    }

    const conflictingFact = checkResult.conflictingFact ?? "an established persona fact";
    const reason = checkResult.reason ?? "the reply conflicts with an established trait";
    const correction = await this.llm.generateCorrection(reply, conflictingFact, reason);
    if (correction) {
      onToken?.(` ${correction}`);
      return {
        result: { checked: true, consistent: false, conflictingFact, reason, correctionApplied: true },
        reply: `${reply} ${correction}`,
      };
    }
    return {
      result: { checked: true, consistent: false, conflictingFact, reason, correctionApplied: false },
      reply,
    };
  }
}
