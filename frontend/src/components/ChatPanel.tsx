import { useRef, useEffect, useState, type FormEvent } from "react";
import type { ChatMessage } from "../types";

interface ChatPanelProps {
  personaName: string;
  messages: ChatMessage[];
  /** null = not streaming; "" = streaming started, no tokens yet; string = partial reply so far. */
  streamingText: string | null;
  disabled: boolean;
  onSend: (text: string) => void;
}

export function ChatPanel({ personaName, messages, streamingText, disabled, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingText]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  }

  return (
    <div className="chat-panel">
      <div className="message-list" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-state">Say hello to {personaName} to get started.</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`message message-${m.role}`}>
            <span className="message-author">
              {m.role === "user" ? "you" : personaName}
              {m.cacheHit && <span className="cache-badge" title="served from semantic cache">⚡ cached</span>}
            </span>
            <p>{m.content}</p>
          </div>
        ))}
        {streamingText !== null && (
          <div className="message message-assistant message-pending">
            <span className="message-author">{personaName}</span>
            {streamingText === "" ? (
              <p className="typing-dots">
                <span />
                <span />
                <span />
              </p>
            ) : (
              <p>{streamingText}</p>
            )}
          </div>
        )}
      </div>
      <form className="composer" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={disabled ? "Connecting..." : "Type a message..."}
          disabled={disabled}
          autoFocus
        />
        <button type="submit" disabled={disabled || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
