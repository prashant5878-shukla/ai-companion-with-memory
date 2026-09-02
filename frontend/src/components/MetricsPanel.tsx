import type { MetricsSummary } from "../types";

interface MetricsPanelProps {
  metrics: MetricsSummary | null;
  loading: boolean;
  onRefresh: () => void;
}

function formatPct(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 100)}%`;
}

export function MetricsPanel({ metrics, loading, onRefresh }: MetricsPanelProps) {
  return (
    <div className="memory-panel">
      <div className="memory-panel-header">
        <h2>Observability</h2>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {!metrics ? (
        <p className="memory-hint">No calls recorded yet.</p>
      ) : (
        <>
          <section className="memory-section">
            <h3>Totals</h3>
            <div className="metrics-stat-grid">
              <div className="metrics-stat">
                <span className="metrics-stat-value">{metrics.totals.calls}</span>
                <span className="metrics-stat-label">LLM calls</span>
              </div>
              <div className="metrics-stat">
                <span className="metrics-stat-value">{metrics.totals.totalTokens.toLocaleString()}</span>
                <span className="metrics-stat-label">total tokens</span>
              </div>
              <div className="metrics-stat">
                <span className="metrics-stat-value">{metrics.totals.promptTokens.toLocaleString()}</span>
                <span className="metrics-stat-label">prompt tokens</span>
              </div>
              <div className="metrics-stat">
                <span className="metrics-stat-value">{metrics.totals.completionTokens.toLocaleString()}</span>
                <span className="metrics-stat-label">completion tokens</span>
              </div>
              <div className="metrics-stat">
                <span className="metrics-stat-value">{formatPct(metrics.cacheHitRate)}</span>
                <span className="metrics-stat-label">cache hit rate</span>
              </div>
            </div>
          </section>

          <section className="memory-section">
            <h3>By call type</h3>
            <div className="metrics-table-wrap">
              <table className="metrics-table">
                <thead>
                  <tr>
                    <th>type</th>
                    <th>calls</th>
                    <th>tokens</th>
                    <th>avg ms</th>
                    <th>errors</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.byType.map((t) => (
                    <tr key={t.type}>
                      <td>{t.type}</td>
                      <td>{t.calls}</td>
                      <td>{t.totalTokens.toLocaleString()}</td>
                      <td>{t.avgLatencyMs}</td>
                      <td>{t.errors > 0 ? t.errors : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="memory-section">
            <h3>Recent calls</h3>
            <ul className="fact-list">
              {metrics.recentCalls.map((c, i) => (
                <li key={i} className={`fact-row ${c.ok ? "fact-active" : "call-error"}`}>
                  <span className="fact-category">{c.type}</span>
                  <span className="fact-text">
                    {c.totalTokens > 0 ? `${c.totalTokens} tok` : "—"} · {c.latencyMs}ms
                  </span>
                  <span className="fact-score">{new Date(c.createdAt).toLocaleTimeString()}</span>
                </li>
              ))}
              {metrics.recentCalls.length === 0 && <li className="memory-hint">Nothing yet.</li>}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
