import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { env } from "../../config/env.js";
import { Logger } from "../../common/logger.js";
import { ChatMessageRecord, ExtractedFactInput, FactRelation } from "../../common/types.js";
import { MetricsService } from "../observability/metrics.service.js";

const CHAT_MODEL_NAME = "gemini-3.6-flash";
const EMBEDDING_MODEL_NAME = "gemini-embedding-001";

const FACT_CATEGORIES = [
  "relationship",
  "work",
  "preference",
  "plan",
  "opinion",
  "event",
  "trait",
  "other",
] as const;

const extractedFactSchema = z.object({
  facts: z.array(
    z.object({
      subject: z.string().describe("Usually 'user', or 'companion' for the persona's own statements"),
      predicate: z.string().describe("short_snake_case relation, e.g. relationship_status, job_title, likes"),
      object: z.string().describe("the value/content of the fact"),
      category: z.enum(FACT_CATEGORIES),
      confidence: z.number().min(0).max(1),
    })
  ),
});

const relationClassificationSchema = z.object({
  results: z.array(
    z.object({
      candidateIndex: z.number(),
      relation: z.enum(["same", "refines", "contradicts", "unrelated"]),
    })
  ),
});

interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function tokensFromUsageMetadata(usage: unknown): UsageTokens {
  const u = usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined;
  return {
    promptTokens: u?.input_tokens ?? 0,
    completionTokens: u?.output_tokens ?? 0,
    totalTokens: u?.total_tokens ?? (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0),
  };
}

/** Thin wrapper around Gemini (chat + embeddings) used by every memory-pipeline stage. */
export class GeminiClient {
  private readonly chatModel: ChatGoogleGenerativeAI;
  private readonly embeddingsModel: GoogleGenerativeAIEmbeddings;
  private readonly logger = new Logger("GeminiClient");

  readonly chatModelName = CHAT_MODEL_NAME;
  readonly embeddingModelName = EMBEDDING_MODEL_NAME;

  constructor(private readonly metrics: MetricsService) {
    // A placeholder keeps client construction (and thus server boot) from throwing when no
    // key is set yet; real calls will fail with a clear auth error until a valid key is provided.
    const apiKey = env.geminiApiKey || "MISSING_GEMINI_API_KEY";
    this.chatModel = new ChatGoogleGenerativeAI({
      apiKey,
      model: CHAT_MODEL_NAME,
      temperature: 0.8,
    });
    this.embeddingsModel = new GoogleGenerativeAIEmbeddings({
      apiKey,
      model: EMBEDDING_MODEL_NAME,
    });
  }

  /**
   * Streams the persona's reply token-by-token via `onToken`, and always returns the
   * full accumulated text at the end (callers that don't need streaming can omit
   * `onToken` and just await the return value).
   */
  async streamReply(
    systemPrompt: string,
    recentMessages: ChatMessageRecord[],
    onToken?: (chunk: string) => void,
    sessionId?: string
  ): Promise<string> {
    const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];
    for (const m of recentMessages) {
      messages.push(m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content));
    }
    const startedAt = Date.now();
    // Streamed chunks from this model each carry their own usage_metadata, but empirically
    // NOT as consistent running totals (e.g. one chunk read input=675/output=13/total=1117,
    // a later one read input=0/output=6/total=6) — the numbers aren't cumulative in an
    // obvious way. Taking the chunk with the largest total_tokens as authoritative is a
    // heuristic, not a guarantee; extract/classify calls (non-streaming) get exact figures
    // straight off the raw response instead. See ARCHITECTURE.md's observability section.
    let bestUsage: { total_tokens?: number } | undefined;
    let full = "";
    let ok = true;
    try {
      const stream = await this.chatModel.stream(messages);
      for await (const chunk of stream) {
        const piece = typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content);
        if (piece) {
          full += piece;
          onToken?.(piece);
        }
        const usage = chunk.usage_metadata as { total_tokens?: number } | undefined;
        if (usage && (usage.total_tokens ?? 0) > (bestUsage?.total_tokens ?? 0)) {
          bestUsage = usage;
        }
      }
      return full;
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      const tokens = tokensFromUsageMetadata(bestUsage);
      void this.metrics.record({
        type: "chat",
        model: CHAT_MODEL_NAME,
        sessionId,
        latencyMs: Date.now() - startedAt,
        ok,
        ...tokens,
      });
    }
  }

  async extractFacts(turnText: string, speakerHint: "user" | "companion"): Promise<ExtractedFactInput[]> {
    const startedAt = Date.now();
    let tokens: UsageTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let ok = true;
    try {
      const structured = this.chatModel.withStructuredOutput(extractedFactSchema, {
        name: "extract_facts",
        includeRaw: true,
      });
      const prompt = [
        `Extract durable, memory-worthy facts about "${speakerHint}" from the exchange below.`,
        "Memory-worthy = durable personal facts: relationships, job/work, preferences, plans, opinions stated with conviction, or significant events.",
        "NOT memory-worthy = greetings, small talk, questions, filler, or anything that isn't a durable fact about the speaker.",
        "If nothing memory-worthy is present, return an empty facts array.",
        "",
        "Exchange:",
        turnText,
      ].join("\n");
      const { raw, parsed } = await structured.invoke(prompt);
      tokens = tokensFromUsageMetadata((raw as AIMessage).usage_metadata);
      return parsed.facts;
    } catch (err) {
      ok = false;
      this.logger.warn("extractFacts failed, skipping this turn's extraction", err);
      return [];
    } finally {
      void this.metrics.record({
        type: "extract",
        model: CHAT_MODEL_NAME,
        latencyMs: Date.now() - startedAt,
        ok,
        ...tokens,
      });
    }
  }

  async classifyRelations(
    newFact: ExtractedFactInput,
    candidates: Array<{ index: number; subject: string; predicate: string; object: string }>
  ): Promise<Map<number, FactRelation>> {
    const resultMap = new Map<number, FactRelation>();
    if (candidates.length === 0) return resultMap;
    const startedAt = Date.now();
    let tokens: UsageTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let ok = true;
    try {
      const structured = this.chatModel.withStructuredOutput(relationClassificationSchema, {
        name: "classify_relations",
        includeRaw: true,
      });
      const prompt = [
        "A new fact was just extracted from a conversation. Compare it against each existing candidate fact",
        "(same subject, same rough topic) and classify the relation:",
        "- 'same': candidate says essentially the same thing as the new fact (duplicate/reinforcement)",
        "- 'refines': new fact adds detail to the candidate without conflicting with it",
        "- 'contradicts': new fact supersedes/conflicts with the candidate (the candidate is no longer true)",
        "- 'unrelated': candidate is not actually about the same topic",
        "",
        `New fact: subject=${newFact.subject}, predicate=${newFact.predicate}, object="${newFact.object}"`,
        "",
        "Candidates:",
        ...candidates.map(
          (c) => `[${c.index}] subject=${c.subject}, predicate=${c.predicate}, object="${c.object}"`
        ),
      ].join("\n");
      const { raw, parsed } = await structured.invoke(prompt);
      tokens = tokensFromUsageMetadata((raw as AIMessage).usage_metadata);
      for (const r of parsed.results) {
        resultMap.set(r.candidateIndex, r.relation);
      }
      return resultMap;
    } catch (err) {
      ok = false;
      this.logger.warn("classifyRelations failed, treating candidates as unrelated", err);
      return resultMap;
    } finally {
      void this.metrics.record({
        type: "classify",
        model: CHAT_MODEL_NAME,
        latencyMs: Date.now() - startedAt,
        ok,
        ...tokens,
      });
    }
  }

  async embed(text: string): Promise<number[]> {
    const startedAt = Date.now();
    let ok = true;
    try {
      return await this.embeddingsModel.embedQuery(text);
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      // The embeddings API doesn't surface token usage through this SDK — call count and
      // latency only. See ARCHITECTURE.md's observability section for this limitation.
      void this.metrics.record({
        type: "embed",
        model: EMBEDDING_MODEL_NAME,
        latencyMs: Date.now() - startedAt,
        ok,
      });
    }
  }
}
