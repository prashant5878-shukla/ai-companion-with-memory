import { createClient, type RedisClientType } from "redis";
import { env } from "../../config/env.js";
import { Logger } from "../../common/logger.js";

const logger = new Logger("RedisCache");

/** Connection singleton for the Redis Stack instance backing the semantic response cache. */
export class RedisCache {
  private static client: RedisClientType | null = null;

  /** Returns null (rather than throwing) if Redis isn't reachable — the cache is optional. */
  static async connect(): Promise<RedisClientType | null> {
    if (RedisCache.client) return RedisCache.client;
    const client: RedisClientType = createClient({ url: env.redisUrl });
    client.on("error", (err) => logger.warn("Redis client error", err));
    try {
      await client.connect();
    } catch (err) {
      logger.warn(
        `Could not connect to Redis at ${env.redisUrl} — semantic caching disabled (run \`docker compose up -d\` to start it).`,
        err
      );
      return null;
    }
    RedisCache.client = client;
    logger.info(`Connected to Redis at ${env.redisUrl}`);
    return client;
  }

  static async disconnect(): Promise<void> {
    if (!RedisCache.client) return;
    await RedisCache.client.quit();
    RedisCache.client = null;
  }
}
