import { determinismToCss } from './color';
import type { SweepSummary } from './api';
import type { SweepView } from './types';

interface Props {
  sweep: SweepView;
  sweeps: SweepSummary[];
  onSelect: (id: string) => void;
}

export function ResultsTable({ sweep, sweeps, onSelect }: Props) {
  const rows = sweep.cells.filter((c) => c && c.okCount + c.errorCount > 0);
  if (rows.length === 0) return null;

  const maxReasoning = Math.max(1, ...rows.map((r) => r.meanReasoningTokens));

  return (
    <section className="results">
      <div className="results-head">
        <h2>Measured cells</h2>
        <div className="results-actions">
          {sweeps.length > 1 && (
            <label className="sweep-picker">
              <span>Run</span>
              <select value={sweep.id} onChange={(e) => onSelect(e.target.value)}>
                {sweeps.map((s) => (
                  <option key={s.id} value={s.id}>
                    {new Date(s.startedAt).toLocaleString()} · {s.cells} cells · {s.status}
                  </option>
                ))}
              </select>
            </label>
          )}
          <a className="ghost link" href="/api/export/jsonl" download>
            ⤓ Export raw JSONL
          </a>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Prompt</th>
            <th>Model</th>
            <th>Determinism</th>
            <th>Distinct</th>
            <th>Mean latency</th>
            <th>Mean reasoning tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cell) => (
            <tr key={cell.cellIndex}>
              <td>{cell.promptLabel}</td>
              <td className="mono">
                <span className={`slot slot-${cell.modelSlot}`}>{cell.modelSlot}</span>
                {cell.model}
              </td>
              <td>
                <span className="score-chip" style={{ background: determinismToCss(cell.determinismScore) }}>
                  {cell.determinismScore.toFixed(2)}
                </span>
              </td>
              <td>
                {cell.distinctOutputs}/{cell.okCount}
                {cell.errorCount > 0 && <span className="err"> · {cell.errorCount} err</span>}
              </td>
              <td>{(cell.meanLatencyMs / 1000).toFixed(2)}s</td>
              <td>
                <div className="bar-cell">
                  <span>{cell.meanReasoningTokens.toLocaleString()}</span>
                  <div
                    className="bar"
                    style={{
                      width: `${(cell.meanReasoningTokens / maxReasoning) * 100}%`,
                      background: determinismToCss(cell.determinismScore),
                    }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}