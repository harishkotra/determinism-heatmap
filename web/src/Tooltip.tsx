import { determinismToCss } from './color';
import type { HoverInfo } from './heatmap';

export function Tooltip({ info }: { info: HoverInfo }) {
  const { cell, clientX, clientY } = info;
  const measured = cell.okCount + cell.errorCount > 0;

  return (
    <div
      className="tooltip"
      style={{ left: clientX + 16, top: clientY + 16 }}
    >
      <div className="tooltip-head">
        <span className="tooltip-slot">Model {cell.modelSlot}</span>
        <span className="tooltip-model">{cell.model}</span>
      </div>
      <div className="tooltip-prompt">{cell.promptText}</div>

      {!measured ? (
        <div className="tooltip-pending">not measured yet</div>
      ) : (
        <dl className="tooltip-stats">
          <div>
            <dt>Determinism</dt>
            <dd style={{ color: determinismToCss(cell.determinismScore) }}>
              {cell.determinismScore.toFixed(2)}
              <span className="tooltip-sub">
                {' '}
                ({Math.round(cell.determinismScore * cell.reps)}/{cell.reps} identical)
              </span>
            </dd>
          </div>
          <div>
            <dt>Distinct outputs</dt>
            <dd>
              {cell.distinctOutputs} of {cell.okCount}
            </dd>
          </div>
          <div>
            <dt>Mean latency</dt>
            <dd>{(cell.meanLatencyMs / 1000).toFixed(2)}s</dd>
          </div>
          <div>
            <dt>Mean reasoning tokens</dt>
            <dd>{cell.meanReasoningTokens.toLocaleString()}</dd>
          </div>
          {cell.errorCount > 0 && (
            <div>
              <dt>Errors</dt>
              <dd className="tooltip-err">{cell.errorCount}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}