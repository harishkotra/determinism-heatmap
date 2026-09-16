import type { PromptDef } from './types';

interface Props {
  prompts: PromptDef[];
  onChange: (p: PromptDef[]) => void;
  onClose: () => void;
}

export function PromptEditor({ prompts, onChange, onClose }: Props) {
  const update = (index: number, patch: Partial<PromptDef>) => {
    const next = prompts.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange(next);
  };

  const add = () =>
    onChange([
      ...prompts,
      { id: `p${Date.now()}`, label: `Prompt ${prompts.length + 1}`, text: '' },
    ]);

  const remove = (index: number) => onChange(prompts.filter((_, i) => i !== index));

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= prompts.length) return;
    const next = [...prompts];
    const a = next[index]!;
    next[index] = next[target]!;
    next[target] = a;
    onChange(next);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Prompts</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-footnote">
            Rows are drawn top to bottom in this order. Each prompt is sent to both models,{' '}
            <strong>reps</strong> times, with a fresh nonce appended to every single call.
          </p>

          <div className="prompt-list">
            {prompts.map((prompt, i) => (
              <div className="prompt-row" key={prompt.id}>
                <div className="prompt-index">{i + 1}</div>
                <div className="prompt-fields">
                  <input
                    className="prompt-label"
                    value={prompt.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                    placeholder="Label"
                  />
                  <textarea
                    value={prompt.text}
                    onChange={(e) => update(i, { text: e.target.value })}
                    placeholder="Prompt text"
                    rows={2}
                  />
                </div>
                <div className="prompt-actions">
                  <button className="icon" onClick={() => move(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button
                    className="icon"
                    onClick={() => move(i, 1)}
                    disabled={i === prompts.length - 1}
                  >
                    ↓
                  </button>
                  <button className="icon danger" onClick={() => remove(i)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button className="ghost" onClick={add}>
            + Add prompt
          </button>
        </div>
      </div>
    </div>
  );
}