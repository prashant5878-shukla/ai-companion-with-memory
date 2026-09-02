export class Logger {
  constructor(private readonly scope: string) {}

  info(message: string, meta?: unknown): void {
    console.log(`[${this.scope}] ${message}`, meta ?? "");
  }

  warn(message: string, meta?: unknown): void {
    console.warn(`[${this.scope}] ${message}`, meta ?? "");
  }

  error(message: string, meta?: unknown): void {
    console.error(`[${this.scope}] ${message}`, meta ?? "");
  }
}
