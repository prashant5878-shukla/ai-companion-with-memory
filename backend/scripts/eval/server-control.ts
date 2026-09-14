import { spawn, type ChildProcess } from "node:child_process";

/**
 * Spawns/kills the real backend server (`tsx src/server.ts`, no watch mode) as a child
 * process so the persistence eval (issue #1/#11) can prove memory survives an actual process
 * restart, not just a fresh HTTP session — the strongest available proxy for "the server was
 * killed and restarted" without tearing down this eval run's own process.
 */
export class ServerControl {
  private proc: ChildProcess | null = null;

  async start(cwd: string): Promise<void> {
    this.proc = spawn("npx", ["tsx", "src/server.ts"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    await this.waitHealthy();
  }

  async restart(cwd: string): Promise<void> {
    await this.stop();
    await this.start(cwd);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
        resolve();
      }, 5000);
    });
  }

  private async waitHealthy(timeoutMs = 20000): Promise<void> {
    const base = process.env.EVAL_API_BASE?.replace(/\/api$/, "") ?? "http://localhost:4000";
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("Server did not become healthy in time");
  }
}
