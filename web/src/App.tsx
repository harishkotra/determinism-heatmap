import { useEffect, useMemo, useRef, useState } from 'react';
import { HeatmapScene, type HoverInfo } from './heatmap';
import {
  cancelSweep,
  fetchLatestSweep,
  fetchServerKeyStatus,
  fetchSweep,
  fetchSweeps,
  startSweep,
  streamSweep,
  type StreamHandlers,
  type SweepSummary,
} from './api';
import { DEFAULT_SETTINGS, type CellAggregate, type PromptDef, type Settings, type SweepView } from './types';
import { SettingsPanel } from './SettingsPanel';
import { Overlay } from './Overlay';
import { Tooltip } from './Tooltip';
import { PromptEditor } from './PromptEditor';
import { ResultsTable } from './ResultsTable';

const STORAGE_KEY = 'determinism-heatmap:settings:v1';
const PROMPTS_KEY = 'determinism-heatmap:prompts:v1';

const DEFAULT_PROMPTS: PromptDef[] = [
  { id: 'recall', label: 'Exact recall', text: 'List the first 12 prime numbers, separated by commas, and nothing else.' },
  { id: 'maths', label: 'Maths', text: 'What is 847 * 293? Show the multiplication steps, then give the final number on its own line.' },
  { id: 'spatial', label: 'Spatial / formatting', text: 'Output a 5x5 multiplication table for the numbers 1 through 5 as a Markdown table. No other text.' },
  { id: 'explain', label: 'One-sentence explanation', text: 'Explain what a hash function is in exactly one sentence.' },
  { id: 'ascii', label: 'ASCII drawing', text: 'Draw a simple ASCII art cat, 5 lines tall. Output only the drawing.' },
  { id: 'haiku', label: 'Haiku', text: 'Write a haiku about the ocean at dawn.' },
  { id: 'joke', label: 'Joke', text: 'Tell me a short joke about programmers.' },
  { id: 'creative', label: 'Open creative', text: 'Describe a city that exists only in the moment between sleeping and waking. Be vivid and specific.' },
];

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadPrompts(): PromptDef[] {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY);
    if (!raw) return DEFAULT_PROMPTS;
    const parsed = JSON.parse(raw) as PromptDef[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PROMPTS;
  } catch {
    return DEFAULT_PROMPTS;
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<HeatmapScene | null>(null);
  const disposeStreamRef = useRef<(() => void) | null>(null);

  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [prompts, setPrompts] = useState<PromptDef[]>(loadPrompts);
  const [sweep, setSweep] = useState<SweepView | null>(null);
  const [status, setStatus] = useState<SweepView['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [hasServerKey, setHasServerKey] = useState(false);
  const [sweepList, setSweepList] = useState<SweepSummary[]>([]);
  /** Distinguishes a live measurement from a replay of recorded calls. */
  const [mode, setMode] = useState<'live' | 'replay'>('live');

  const refreshSweepList = () => {
    void fetchSweeps().then(setSweepList);
  };

  // Persist config to localStorage on every change.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
  }, [prompts]);

  // Create the scene once.
  useEffect(() => {
    if (!canvasRef.current) return;
    const scene = new HeatmapScene(canvasRef.current, setHover);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // On load, re-attach to whatever the server already has (survives reload).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // On first load prefer the most complete sweep, not merely the newest.
        // A throwaway 1-prompt test run would otherwise replace the full grid
        // with a nearly empty one and make the experiment look broken.
        const list = await fetchSweeps();
        let target = await fetchLatestSweep();

        if (list.length > 1) {
          const best = [...list].sort(
            (a, b) => b.cells - a.cells || b.startedAt.localeCompare(a.startedAt),
          )[0];
          // `target.cells` is the full cell array on SweepView; `totalCells`
          // is the count. Comparing against the array silently never matched.
          if (best && (!target || best.cells > target.totalCells)) {
            target = await fetchSweep(best.id);
          }
        }

        if (cancelled || !target) return;
        setSweep(target);
        setStatus(target.status);
        if (target.status === 'sweeping') attachStream(target.id);
      } catch {
        /* server not up yet; the UI still renders idle */
      }
    })();
    void fetchServerKeyStatus().then((has) => {
      if (!cancelled) setHasServerKey(has);
    });
    refreshSweepList();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed scene data whenever cells change.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const cells = sweep?.cells ?? [];
    const promptList = sweep?.prompts ?? prompts;
    scene.setData({
      prompts: promptList,
      cells,
      reps: sweep?.config.reps ?? settings.reps,
      modelA: sweep?.config.modelA ?? settings.modelA,
      modelB: sweep?.config.modelB ?? settings.modelB,
    });
  }, [sweep, prompts, settings.reps, settings.modelA, settings.modelB]);

  function attachStream(id: string, path: 'stream' | 'replay' = 'stream') {
    disposeStreamRef.current?.();
    const handlers: StreamHandlers = {
      onSnapshot: (view) => {
        setSweep(view);
        // A replay is a playback of finished records; keep it marked as such so
        // the UI never presents it as a fresh measurement.
        setStatus(path === 'replay' ? 'sweeping' : view.status);
      },
      onReset: (cells) => {
        setSweep((prev) => (prev ? { ...prev, cells, completedCells: 0 } : prev));
      },
      onProgress: (progress) => {
        setSweep((prev) => (prev ? { ...prev, progress } : prev));
      },
      onCell: (cell: CellAggregate) => {
        setSweep((prev) => {
          if (!prev) return prev;
          const cells = [...prev.cells];
          cells[cell.cellIndex] = cell;
          const completedCells = cells.filter(
            (c) => c && c.okCount + c.errorCount >= prev.config.reps,
          ).length;
          return { ...prev, cells, completedCells };
        });
      },
      onStatus: (s) => setStatus(s),
      onDone: (view) => {
        setSweep(view);
        setStatus(view.status);
        setMode('live');
        disposeStreamRef.current = null;
        refreshSweepList();
      },
      onError: (message) => {
        setError(message);
        setStatus('error');
      },
    };
    disposeStreamRef.current = streamSweep(id, handlers, path);
  }

  /**
   * Show a finished run filling in cell by cell, using the calls already on
   * disk. No new model calls are made — this is playback, not measurement.
   */
  function handleReplay() {
    if (!sweep || sweep.records.length === 0) return;
    setError(null);
    setMode('replay');
    setStatus('sweeping');
    attachStream(sweep.id, 'replay');
  }

  function handleStopReplay() {
    disposeStreamRef.current?.();
    disposeStreamRef.current = null;
    setMode('live');
    setStatus(sweep?.status ?? 'idle');
    setSweep((prev) => (prev ? { ...prev, progress: null } : prev));
  }

  async function handleStart() {
    setError(null);
    if (!settings.apiKey.trim() && !hasServerKey) {
      setError(
        'API key is required. Open Settings and paste your key, or start the server with PARTICLE_AI_API_KEY.',
      );
      setSettingsOpen(true);
      return;
    }
    const cleanPrompts = prompts.filter((p) => p.text.trim().length > 0);
    if (cleanPrompts.length === 0) {
      setError('Add at least one prompt.');
      setPromptsOpen(true);
      return;
    }

    setStatus('sweeping');
    setMode('live');
    setSweep(null);
    try {
      const { id } = await startSweep(cleanPrompts, settings);
      const initial: SweepView = {
        id,
        status: 'sweeping',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        config: {
          baseUrl: settings.baseUrl,
          modelA: settings.modelA,
          modelB: settings.modelB,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          reps: settings.reps,
          disableReasoning: settings.disableReasoning,
          systemPrompt: '',
        },
        prompts: cleanPrompts,
        totalCells: cleanPrompts.length * 2,
        completedCells: 0,
        totalCalls: cleanPrompts.length * 2 * settings.reps,
        completedCalls: 0,
        progress: null,
        error: null,
        nonceAudit: { issued: 0, unique: 0, duplicates: [], ok: true },
        cells: [],
        records: [],
      };
      setSweep(initial);
      attachStream(id);
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  async function handleCancel() {
    if (!sweep) return;
    await cancelSweep(sweep.id);
  }

  /** Load a past sweep from disk — lets you flip back to a full run after a quick test. */
  async function handleSelectSweep(id: string) {
    if (id === sweep?.id) return;
    disposeStreamRef.current?.();
    disposeStreamRef.current = null;
    try {
      const view = await fetchSweep(id);
      setSweep(view);
      setStatus(view.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function handleExportPng() {
    const scene = sceneRef.current;
    if (!scene || !sweep) return;
    const maxReasoningTokens = Math.max(0, ...sweep.cells.map((c) => c.meanReasoningTokens));
    const dataUrl = scene.exportPng(2, {
      prompts: sweep.prompts.length,
      reps: sweep.config.reps,
      modelA: sweep.config.modelA,
      modelB: sweep.config.modelB,
      temperature: sweep.config.temperature,
      disableReasoning: sweep.config.disableReasoning,
      nonceAudit: sweep.nonceAudit,
      maxReasoningTokens,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `determinism-heatmap-${sweep.id.slice(0, 8)}.png`;
    a.click();
  }

  const measuredCells = useMemo(
    () => (sweep?.cells ?? []).filter((c) => c && c.okCount + c.errorCount > 0),
    [sweep],
  );

  const progressText = sweep?.progress
    ? `cell ${sweep.progress.cellIndex + 1} of ${sweep.progress.totalCells} — rep ${sweep.progress.rep} of ${sweep.progress.totalReps}`
    : null;

  return (
    <div className="app">
      <div className="viewport">
        <canvas ref={canvasRef} />
        <Overlay
          sweep={sweep}
          status={status}
          mode={mode}
          progressText={progressText}
          measuredCount={measuredCells.length}
          canRun={status !== 'sweeping'}
          onRun={handleStart}
          onReplay={handleReplay}
          onStopReplay={handleStopReplay}
          onExportPng={handleExportPng}
          onCancel={handleCancel}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPrompts={() => setPromptsOpen(true)}
        />
        {hover && hover.cell && <Tooltip info={hover} />}
      </div>

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {promptsOpen && (
        <PromptEditor prompts={prompts} onChange={setPrompts} onClose={() => setPromptsOpen(false)} />
      )}

      <div className="startbar">
        <button className="primary" onClick={handleStart} disabled={status === 'sweeping'}>
          {status === 'sweeping'
            ? mode === 'replay'
              ? 'Replaying…'
              : 'Sweeping…'
            : '▶ Run sweep'}
        </button>
        <button
          className="ghost"
          onClick={handleReplay}
          disabled={status === 'sweeping' || !sweep || measuredCells.length === 0}
        >
          ↻ Replay this run
        </button>
        <span className="startbar-meta">
          {prompts.length} prompts × 2 models × {settings.reps} reps ={' '}
          <strong>{prompts.length * 2 * settings.reps}</strong> calls
          {hasServerKey && !settings.apiKey.trim() && (
            <span className="key-hint"> · using server env key</span>
          )}
        </span>
        {error && <span className="inline-error">{error}</span>}
      </div>

      {measuredCells.length > 0 && (
        <ResultsTable sweep={sweep!} sweeps={sweepList} onSelect={handleSelectSweep} />
      )}
    </div>
  );
}