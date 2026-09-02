import "dotenv/config";

class EnvConfig {
  readonly geminiApiKey: string;
  readonly mongoUri: string;
  readonly redisUrl: string;
  readonly port: number;

  constructor() {
    this.geminiApiKey = process.env.GEMINI_API_KEY ?? "";
    this.mongoUri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/companion_ai";
    this.redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.port = Number(process.env.PORT ?? 4000);

    if (!this.geminiApiKey) {
      console.warn(
        "[env] GEMINI_API_KEY is not set — LLM calls will fail until it is provided (.env or shell export)."
      );
    }
  }
}

export const env = new EnvConfig();
