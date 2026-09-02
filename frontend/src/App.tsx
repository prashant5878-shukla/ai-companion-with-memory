import { useCallback, useEffect, useRef, useState } from "react";
import { CompanionApiClient } from "./api/companionApi";
import { ChatPanel } from "./components/ChatPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { MetricsPanel } from "./components/MetricsPanel";
import type { ChatMessage, ChatTurnResult, MetricsSummary, StoredFact } from "./types";
import "./index.css";

const PERSONA_NAME = "Wren";

type RightTab = "memory" | "metrics";

export default function App() {
  const apiRef = useRef(new CompanionApiClient());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<ChatTurnResult | null>(null);
  const [userFacts, setUserFacts] = useState<StoredFact[]>([]);
  const [personaFacts, setPersonaFacts] = useState<StoredFact[]>([]);
  const [factsLoading, setFactsLoading] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("memory");
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const refreshFacts = useCallback(async () => {
    setFactsLoading(true);
    try {
      const { userFacts, personaFacts } = await apiRef.current.listFacts();
      setUserFacts(userFacts);
      setPersonaFacts(personaFacts);
    } catch (err) {
      console.error("Failed to load facts", err);
    } finally {
      setFactsLoading(false);
    }
  }, []);

  const refreshMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      setMetrics(await apiRef.current.getMetrics());
    } catch (err) {
      console.error("Failed to load metrics", err);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    apiRef.current
      .resumeSession()
      .then((id) => {
        setSessionId(id);
        return Promise.all([refreshFacts(), refreshMetrics()]);
      })
      .catch((err) => {
        console.error(err);
        setConnectError(
          "Could not reach the backend at http://localhost:4000 — make sure `npm run server` is running in backend/."
        );
      });
  }, [refreshFacts, refreshMetrics]);

  async function handleNewSession() {
    const id = await apiRef.current.newSession();
    setSessionId(id);
    setMessages([]);
    setLastTurn(null);
  }

  async function handleSend(text: string) {
    if (!sessionId) return;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setStreamingText("");
    try {
      const result = await apiRef.current.sendMessageStream(sessionId, text, (token) => {
        setStreamingText((prev) => (prev ?? "") + token);
      });
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.reply,
        cacheHit: result.cacheHit,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setLastTurn(result);
      await Promise.all([refreshFacts(), refreshMetrics()]);
    } catch (err) {
      console.error(err);
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "(something went wrong reaching the backend — check the server logs)",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setStreamingText(null);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Companion-AI</h1>
        <button type="button" onClick={handleNewSession} disabled={!sessionId}>
          New session
        </button>
      </header>

      {connectError ? (
        <div className="connect-error">{connectError}</div>
      ) : (
        <main className="app-main">
          <ChatPanel
            personaName={PERSONA_NAME}
            messages={messages}
            streamingText={streamingText}
            disabled={!sessionId}
            onSend={handleSend}
          />
          <div className="right-pane">
            <div className="panel-tabs">
              <button
                type="button"
                className={rightTab === "memory" ? "active" : ""}
                onClick={() => setRightTab("memory")}
              >
                Memory
              </button>
              <button
                type="button"
                className={rightTab === "metrics" ? "active" : ""}
                onClick={() => setRightTab("metrics")}
              >
                Observability
              </button>
            </div>
            {rightTab === "memory" ? (
              <MemoryPanel
                userFacts={userFacts}
                personaFacts={personaFacts}
                lastTurn={lastTurn}
                loading={factsLoading}
                onRefresh={refreshFacts}
              />
            ) : (
              <MetricsPanel metrics={metrics} loading={metricsLoading} onRefresh={refreshMetrics} />
            )}
          </div>
        </main>
      )}
    </div>
  );
}
