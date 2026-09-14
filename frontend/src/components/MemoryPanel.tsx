import type { ChatTurnResult, StoredFact } from "../types";

interface MemoryPanelProps {
  userFacts: StoredFact[];
  personaFacts: StoredFact[];
  lastTurn: ChatTurnResult | null;
  loading: boolean;
  onRefresh: () => void;
}

function FactRow({ fact }: { fact: StoredFact }) {
  return (
    <li className={`fact-row fact-${fact.status}`}>
      <span className="fact-category">{fact.category}</span>
      <span className="fact-temporal">{fact.temporalType}</span>
      <span className="fact-text">
        <strong>{fact.predicate}</strong>: {fact.object}
      </span>
      {fact.status !== "active" && <span className="fact-badge">{fact.status}</span>}
    </li>
  );
}

export function MemoryPanel({ userFacts, personaFacts, lastTurn, loading, onRefresh }: MemoryPanelProps) {
  const activeUser = userFacts.filter((f) => f.status === "active");
  const supersededUser = userFacts.filter((f) => f.status === "superseded");

  return (
    <div className="memory-panel">
      <div className="memory-panel-header">
        <h2>Memory</h2>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {lastTurn && (
        <section className="memory-section">
          <h3>Last turn</h3>
          <p className="memory-hint">
            Mode: {lastTurn.mode}
            {lastTurn.personaCheck.checked &&
              (lastTurn.personaCheck.consistent
                ? " · persona check: consistent"
                : lastTurn.personaCheck.correctionApplied
                  ? ` · persona check: caught & corrected (${lastTurn.personaCheck.conflictingFact})`
                  : ` · persona check: flagged (${lastTurn.personaCheck.conflictingFact})`)}
          </p>
          {lastTurn.retrievedFacts.length > 0 ? (
            <>
              <p className="memory-hint">Retrieved into context:</p>
              <ul className="fact-list">
                {lastTurn.retrievedFacts.map((f) => (
                  <li key={f.id} className="fact-row fact-active">
                    <span className="fact-category">{f.category}</span>
                    <span className="fact-text">
                      <strong>{f.predicate}</strong>: {f.object}
                    </span>
                    <span className="fact-score">{f.score.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="memory-hint">Nothing relevant retrieved this turn.</p>
          )}
          {lastTurn.reconciliation.length > 0 && (
            <>
              <p className="memory-hint">Memory updates:</p>
              <ul className="fact-list">
                {lastTurn.reconciliation.map((r, i) => (
                  <li key={i} className={`fact-row recon-${r.relation}`}>
                    <span className="fact-category">{r.relation}</span>
                    <span className="fact-text">
                      <strong>{r.fact.predicate}</strong>: {r.fact.object}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="memory-section">
        <h3>Active facts about you ({activeUser.length})</h3>
        <ul className="fact-list">
          {activeUser.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
          {activeUser.length === 0 && <li className="memory-hint">Nothing stored yet.</li>}
        </ul>
      </section>

      {supersededUser.length > 0 && (
        <section className="memory-section">
          <h3>Superseded ({supersededUser.length})</h3>
          <ul className="fact-list">
            {supersededUser.map((f) => (
              <FactRow key={f.id} fact={f} />
            ))}
          </ul>
        </section>
      )}

      <section className="memory-section">
        <h3>What the companion remembers about itself ({personaFacts.length})</h3>
        <ul className="fact-list">
          {personaFacts.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
        </ul>
      </section>
    </div>
  );
}
