import { AUTHOR } from './author';
import { legendGradient } from './color';
import type { SweepView } from './types';

interface Props {
  sweep: SweepView | null;
  status: SweepView['status'];
  mode: 'live' | 'replay';
  progressText: string | null;
  measuredCount: number;
  canRun: boolean;
  onRun: () => void;
  onReplay: () => void;
  onStopReplay: () => void;
  onExportPng: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onOpenPrompts: () => void;
}

const STATUS_LABEL: Record<SweepView['status'], string> = {
  idle: 'idle',
  sweeping: 'sweeping',
  complete: 'complete',
  cancelled: 'cancelled',
  error: 'error',
};

export function Overlay({
  sweep,
  status,
  mode,
  progressText,
  measuredCount,
  canRun,
  onRun,
  onReplay,
  onStopReplay,
  onExportPng,
  onCancel,
  onOpenSettings,
  onOpenPrompts,
}: Props) {
  const audit = sweep?.nonceAudit;
  const pct =
    sweep && sweep.totalCalls > 0 ? Math.round((sweep.completedCalls / sweep.totalCalls) * 100) : 0;

  return (
    <>
      <header className="overlay overlay-title">
        <h1>The Determinism Heatmap</h1>
        <p className="subtitle">
          How often does the same prompt return byte-identical output? Each bar is one prompt ×
          one model, measured over {sweep?.config.reps ?? 10} repetitions.
        </p>
        <p className="subtitle dim">
          Colour = determinism (sha256 of the raw response). Height = mean reasoning tokens.
          {sweep ? ` Temperature ${sweep.config.temperature}.` : ' Temperature 0.'}{' '}
          <strong className="warn">
            Determinism at temperature 0 is an upper bound, not a guarantee.
          </strong>
        </p>
        {sweep && (
          <p className="run-stamp">
            viewing run {sweep.id.slice(0, 8)} · {sweep.prompts.length} prompts ·{' '}
            {sweep.completedCalls} calls · {new Date(sweep.startedAt).toLocaleString()}
          </p>
        )}
      </header>

      <div className="overlay overlay-controls">
        {status === 'sweeping' ? (
          mode === 'replay' ? (
            <button className="danger" onClick={onStopReplay}>
              ■ Stop replay
            </button>
          ) : (
            <button className="danger" onClick={onCancel}>
              ■ Cancel sweep
            </button>
          )
        ) : (
          <button className="primary-inline" onClick={onRun} disabled={!canRun}>
            ▶ Run sweep
          </button>
        )}

        <button
          onClick={onReplay}
          disabled={status === 'sweeping' || !sweep || measuredCount === 0}
          title="Play this run back cell by cell using the calls already on disk — no new model calls"
        >
          ↻ Replay
        </button>

        <button onClick={onExportPng} disabled={!sweep || measuredCount === 0}>
          ⤓ Export PNG
        </button>
        <button onClick={onOpenSettings}>⚙ Settings</button>
        <button onClick={onOpenPrompts}>✎ Prompts ({sweep?.prompts.length ?? 8})</button>

        <span className={`status status-${status}`}>
          {status === 'sweeping' && mode === 'replay' ? 'replaying' : STATUS_LABEL[status]}
        </span>
      </div>

      {status === 'sweeping' && (
        <div className="overlay overlay-progress">
          {mode === 'replay' && (
            <div className="replay-banner">
              ↻ Replaying recorded calls — no new model calls are being made
            </div>
          )}
          <div className="progress-row">
            <span className="progress-text">{progressText ?? 'starting…'}</span>
            <span className="progress-pct">{pct}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          {sweep?.progress && (
            <div className="progress-sub">
              {sweep.progress.promptLabel} · model {sweep.progress.modelSlot} (
              {sweep.progress.model})
            </div>
          )}
        </div>
      )}

      {status === 'cancelled' && (
        <div className="overlay overlay-note">
          Sweep cancelled — {sweep?.completedCalls ?? 0} of {sweep?.totalCalls ?? 0} calls kept.
          Everything measured so far is still on disk.
        </div>
      )}

      {status === 'error' && (
        <div className="overlay overlay-note error">
          {sweep?.error ?? 'The sweep failed.'}
        </div>
      )}

      <div className="overlay overlay-legend">
        <div className="legend-block">
          <div className="legend-title">Determinism score</div>
          <div className="legend-bar" style={{ background: legendGradient() }} />
          <div className="legend-ticks">
            <span>0.0 · model wanders</span>
            <span>0.5</span>
            <span>1.0 · byte-identical</span>
          </div>
        </div>

        <div className="legend-block">
          <div className="legend-title">Bar height</div>
          <div className="legend-note">
            mean reasoning tokens, scaled to the grid max
          </div>
          <div className="legend-note accent">tall + red = expensive and unstable</div>
        </div>

        {audit && (
          <div className="legend-block">
            <div className="legend-title">Nonce audit</div>
            <div className={audit.ok ? 'legend-ok' : 'legend-bad'}>
              {audit.ok
                ? `✓ ${audit.issued} calls · ${audit.unique} unique nonces · 0 reused`
                : `✗ ${audit.duplicates.length} nonce(s) reused — results invalid`}
            </div>
            <div className="legend-note">
              every call carries a fresh nonce so no cache can fake determinism
            </div>
          </div>
        )}

        {/* Attribution rides the legend's flex row so it can never collide. */}
        <div className="overlay-credit">
          <span>
            Built by{' '}
            <a href={AUTHOR.url} target="_blank" rel="noopener noreferrer">
              {AUTHOR.name}
            </a>
          </span>
          <span className="credit-sep">·</span>
          <a href={AUTHOR.buildsUrl} target="_blank" rel="noopener noreferrer">
            {AUTHOR.buildsLabel}
          </a>
        </div>
      </div>
    </>
  );
}