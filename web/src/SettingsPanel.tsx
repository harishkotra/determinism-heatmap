import { useEffect, useState } from 'react';
import { fetchServerKeyStatus } from './api';
import type { Settings } from './types';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onChange, onClose }: Props) {
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [hasServerKey, setHasServerKey] = useState(false);

  useEffect(() => {
    void fetchServerKeyStatus().then(setHasServerKey);
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  /**
   * A real one-call probe against the configured endpoint. Surfaces the
   * provider's own error text rather than a generic failure.
   */
  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/sweep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompts: ['Reply with exactly: OK'],
          reps: 1,
          config: {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            modelA: settings.modelA,
            modelB: settings.modelB,
            temperature: settings.temperature,
            maxTokens: 32,
            disableReasoning: true,
          },
        }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok) {
        setTestResult(`✗ ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setTestResult(`✓ accepted — a real 1-rep probe sweep was started (${body.id?.slice(0, 8)}…)`);
    } catch (err) {
      setTestResult(`✗ ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>Base URL</span>
            <input
              type="text"
              value={settings.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder="https://api.particle.ai/v1"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>API Key</span>
            <div className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
                placeholder="sk-…"
                spellCheck={false}
                autoComplete="off"
              />
              <button className="ghost" onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <small>
              Stored in this browser's localStorage only. Never written to the server log.
              {hasServerKey && (
                <>
                  {' '}
                  <strong className="server-key-note">
                    The server already has a key in its environment — leave this blank to use it.
                  </strong>
                </>
              )}
            </small>
          </label>

          <div className="field-row">
            <label className="field">
              <span>Model A (older)</span>
              <input
                type="text"
                value={settings.modelA}
                onChange={(e) => set('modelA', e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Model B (newer)</span>
              <input
                type="text"
                value={settings.modelB}
                onChange={(e) => set('modelB', e.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Temperature</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={settings.temperature}
                onChange={(e) => set('temperature', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Max tokens</span>
              <input
                type="number"
                step="100"
                min="1"
                value={settings.maxTokens}
                onChange={(e) => set('maxTokens', Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>Repetitions</span>
              <input
                type="number"
                step="1"
                min="1"
                max="50"
                value={settings.reps}
                onChange={(e) => set('reps', Number(e.target.value))}
              />
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.disableReasoning}
              onChange={(e) => set('disableReasoning', e.target.checked)}
            />
            <span>
              Disable reasoning
              <small>
                Sends <code>chat_template_kwargs: {'{'} "enable_thinking": false {'}'}</code>
              </small>
            </span>
          </label>

          <div className="modal-actions">
            <button className="ghost" onClick={testConnection} disabled={testing}>
              {testing ? 'Testing…' : 'Test configuration'}
            </button>
            {testResult && <span className="test-result">{testResult}</span>}
          </div>

          <p className="modal-footnote">
            Determinism is measured at temperature {settings.temperature}. At temperature 0 the
            score is an upper bound on what the model can do — real deployments run warmer.
          </p>
        </div>
      </div>
    </div>
  );
}