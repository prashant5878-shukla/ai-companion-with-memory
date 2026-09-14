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

const TEMPORAL_TYPES = ["permanent", "ongoing", "temporary", "event"] as const;

const extractedFactSchema = z.object({
  facts: z.array(
    z.object({
      subject: z.string().describe("Usually 'user', or 'companion' for the persona's own statements"),
      predicate: z.string().describe("short_snake_case relation, e.g. relationship_status, job_title, likes"),
      object: z.string().describe("the value/content of the fact"),
      category: z.enum(FACT_CATEGORIES),
      temporalType: z
        .enum(TEMPORAL_TYPES)
        .describe(
          "permanent = never goes stale with age (birthday, hometown, family, core identity); " +
            "ongoing = true until explicitly replaced (job, relationship status, where they live); " +
            "temporary = short-lived state that should fade even without a contradiction (this " +
            "week's mood, a plan for the weekend); event = a specific happened/scheduled occurrence"
        ),
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

const personaConsistencySchema = z.object({
  consistent: z.boolean(),
  conflictingFact: z.string().optional().describe("The persona fact the reply conflicts with, verbatim, if any"),
  reason: z.string().optional().describe("One sentence: what in the reply conflicts with that fact"),
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
        `Extract memory-worthy facts stated in FIRST PERSON by "${speakerHint}" from the text below.`,
        "",
        "Memory policy — store:",
        "- Stable identity: name, age, hometown, family, core traits.",
        "- Preferences: likes/dislikes stated with real conviction (not a one-off aside).",
        "- Relationships: who matters to them and the nature of that relationship.",
        "- Goals and plans: things they're working toward or intend to do, even short-term ones.",
        "- Significant events: things that happened or are scheduled to happen.",
        "- Opinions stated as a genuine, standing belief (not a joke or hypothetical).",
        "",
        "Memory policy — never store, no matter how it's phrased:",
        "- Greetings, thanks, small talk, filler ('lol', 'haha', 'nice').",
        "- Jokes, sarcasm, or hypotheticals not meant as a real statement about the speaker.",
        "- Speculation or questions ('what if I moved to Japan?' is not a plan).",
        "- Anything said BY someone else ABOUT the speaker — only self-statements count.",
        "- Purely transient conversational mechanics (e.g. 'let me think', 'good question').",
        "",
        `Also assign each fact a temporalType (see schema) — this controls how it decays over time, ` +
          "not whether it's worth storing: a short-term plan is still worth storing, just tagged 'temporary'.",
        "If nothing in the text meets this bar, return an empty facts array — that is the common case, not a failure.",
        "",
        "Text:",
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
        "- 'refines': the new fact is a MORE SPECIFIC version of the same underlying fact — it adds",
        "  detail without making the candidate false. Example: candidate 'developer' + new 'backend",
        "  developer at Microsoft' -> 'refines'. The result should be ONE consolidated, stronger fact,",
        "  not two facts and not a contradiction — refining is not the same thing as contradicting.",
        "- 'contradicts': the new fact makes the candidate FALSE going forward — they cannot both be",
        "  true at the same time. Example: candidate 'relationship_status: living with partner' + new",
        "  'relationship_status: broke up' -> 'contradicts'.",
        "- 'unrelated': candidate is not actually about the same topic",
        "",
        "When in doubt between 'refines' and 'contradicts': if the old statement is still true, just less",
        "complete, it's 'refines'. Only use 'contradicts' when the old statement is now false.",
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

  /**
   * Post-generation persona consistency check (issue #6): the system prompt and retrieved
   * persona facts only bias generation, they don't guarantee it — the model can still
   * contradict an established trait/opinion/backstory detail. This is a second, independent
   * LLM call that judges the finished reply against the persona facts actually in play this
   * turn, so a contradiction can be caught and corrected even if prompt-compliance failed.
   */
  async checkPersonaConsistency(
    reply: string,
    personaFacts: string[]
  ): Promise<{ consistent: boolean; conflictingFact?: string; reason?: string }> {
    if (personaFacts.length === 0) return { consistent: true };
    const startedAt = Date.now();
    let tokens: UsageTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let ok = true;
    try {
      const structured = this.chatModel.withStructuredOutput(personaConsistencySchema, {
        name: "check_persona_consistency",
        includeRaw: true,
      });
      const prompt = [
        "The companion persona has these established, standing facts about itself:",
        ...personaFacts.map((f) => `- ${f}`),
        "",
        "The companion just said the following in a conversation:",
        `"${reply}"`,
        "",
        "Does this reply CONTRADICT any of the established facts above (not merely omit them —",
        "silence about a fact is fine, an explicit conflicting claim is not)? Answer consistent=false",
        "only for a genuine conflict, e.g. claiming to love something it's established it dislikes.",
      ].join("\n");
      const { raw, parsed } = await structured.invoke(prompt);
      tokens = tokensFromUsageMetadata((raw as AIMessage).usage_metadata);
      return parsed;
    } catch (err) {
      ok = false;
      this.logger.warn("checkPersonaConsistency failed, assuming consistent", err);
      return { consistent: true };
    } finally {
      void this.metrics.record({
        type: "persona_check",
        model: CHAT_MODEL_NAME,
        latencyMs: Date.now() - startedAt,
        ok,
        ...tokens,
      });
    }
  }

  /**
   * Generates a short, in-character self-correction to append after a reply flagged by
   * `checkPersonaConsistency`. Kept separate from `streamReply` (rather than regenerating the
   * whole reply) because the reply may already have been streamed to the client token-by-token
   * by the time the check completes — tokens already sent can't be recalled, so the system
   * revises forward instead, the way a person catches themselves mid-conversation.
   */
  async generateCorrection(reply: string, conflictingFact: string, reason: string): Promise<string> {
    const startedAt = Date.now();
    let tokens: UsageTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let ok = true;
    try {
      const prompt = [
        `You (the companion) just said: "${reply}"`,
        `That contradicts something you've established about yourself: "${conflictingFact}"`,
        `(${reason})`,
        "In 1 short sentence, naturally correct yourself in character — like catching a slip of the",
        "tongue mid-conversation. Don't explain the mechanism, don't apologize like an assistant,",
        "just correct the substance the way a person would.",
      ].join("\n");
      const result = await this.chatModel.invoke(prompt);
      tokens = tokensFromUsageMetadata((result as AIMessage).usage_metadata);
      return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    } catch (err) {
      ok = false;
      this.logger.warn("generateCorrection failed, leaving reply uncorrected", err);
      return "";
    } finally {
      void this.metrics.record({
        type: "correction",
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
