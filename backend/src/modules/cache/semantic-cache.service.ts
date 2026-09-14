import { randomUUID, createHash } from "node:crypto";
import { SchemaFieldTypes, VectorAlgorithms, type RedisClientType } from "redis";
import { Logger } from "../../common/logger.js";

const INDEX_NAME = "idx:response_cache";
const KEY_PREFIX = "cache:";
const EMBEDDING_DIM = 3072; // gemini-embedding-001 output size, confirmed empirically at build time
const SIMILARITY_THRESHOLD = 0.96; // cosine similarity; deliberately high — see ARCHITECTURE.md
const MAX_DISTANCE = 1 - SIMILARITY_THRESHOLD; // RediSearch COSINE metric returns distance, not similarity
const TTL_SECONDS = 6 * 60 * 60; // entries expire after 6h — this is a cache, not memory

function toFloat32Buffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

interface RetrievedFactLike {
  id: string;
  object: string;
}

/**
 * Semantic response cache backed by Redis Stack's RediSearch (HNSW vector index).
 * Deliberately scoped tight to avoid serving a stale/wrong reply: a hit requires the
 * same session AND an identical set of retrieved fact ids (i.e. memory state must
 * match) AND near-duplicate query text (cosine >= 0.96). This only fires on genuine
 * repeats (greetings, acknowledgements, filler) — never on anything where updated
 * memory could change the right answer.
 */
export class SemanticCacheService {
  private readonly logger = new Logger("SemanticCacheService");
  private indexReady = false;

  constructor(private readonly client: RedisClientType | null) {}

  /** Used when Redis isn't reachable at boot — every lookup/store becomes a safe no-op. */
  static disabled(): SemanticCacheService {
    return new SemanticCacheService(null);
  }

  /**
   * Content fingerprint, not just fact ids (fixes issue #8: a `refines`/`same` reconciliation
   * updates a fact's `object` IN PLACE, same id — an id-only hash would silently miss that
   * change and could replay a reply generated before the refinement). Hashing `id:object`
   * pairs means any change to a fact's content — refined in place or superseded to a new id —
   * changes the hash and correctly busts the cache. See FIXES_REPORT.md #8.
   */
  static hashContext(userFacts: RetrievedFactLike[], personaFacts: RetrievedFactLike[]): string {
    const fingerprints = [...userFacts, ...personaFacts]
      .map((f) => `${f.id}:${f.object}`)
      .sort()
      .join("|");
    return createHash("sha1").update(fingerprints).digest("hex");
  }

  async ensureIndex(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.ft.create(
        INDEX_NAME,
        {
          sessionId: { type: SchemaFieldTypes.TAG },
          contextHash: { type: SchemaFieldTypes.TAG },
          reply: { type: SchemaFieldTypes.TEXT },
          embedding: {
            type: SchemaFieldTypes.VECTOR,
            ALGORITHM: VectorAlgorithms.HNSW,
            TYPE: "FLOAT32",
            DIM: EMBEDDING_DIM,
            DISTANCE_METRIC: "COSINE",
          },
        },
        { ON: "HASH", PREFIX: KEY_PREFIX }
      );
      this.indexReady = true;
      this.logger.info(`Created RediSearch index ${INDEX_NAME}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Index already exists")) {
        this.indexReady = true;
        return;
      }
      this.logger.warn("Failed to create RediSearch index — semantic cache disabled", err);
    }
  }

  async lookup(sessionId: string, contextHash: string, queryEmbedding: number[]): Promise<string | null> {
    if (!this.client || !this.indexReady) return null;
    try {
      const query = `(@sessionId:{${sessionId}} @contextHash:{${contextHash}})=>[KNN 1 @embedding $vec AS score]`;
      const result = await this.client.ft.search(INDEX_NAME, query, {
        PARAMS: { vec: toFloat32Buffer(queryEmbedding) },
        SORTBY: "score",
        DIALECT: 2,
        RETURN: ["reply", "score"],
      });
      if (result.total === 0) return null;
      const [top] = result.documents;
      const distance = Number(top.value.score);
      if (Number.isFinite(distance) && distance <= MAX_DISTANCE) {
        return String(top.value.reply);
      }
      return null;
    } catch (err) {
      this.logger.warn("Semantic cache lookup failed, treating as a miss", err);
      return null;
    }
  }

  async store(sessionId: string, contextHash: string, embedding: number[], reply: string): Promise<void> {
    if (!this.client || !this.indexReady) return;
    try {
      const key = `${KEY_PREFIX}${randomUUID()}`;
      await this.client.hSet(key, {
        sessionId,
        contextHash,
        reply,
        embedding: toFloat32Buffer(embedding),
      });
      await this.client.expire(key, TTL_SECONDS);
    } catch (err) {
      this.logger.warn("Semantic cache store failed, continuing without caching this reply", err);
    }
  }
}
