import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { ModelStatus, Run, RunPlan, Split, TaskMeta } from '../types';
import { splitName } from '../types';
import { Banner, Modal } from '../components';

const DEFAULT_BUDGET = {
  perTrialCalls: '6',
  totalCalls: '120',
  turns: '8',
  tokens: '250000',
  wallSeconds: '180',
};

export function RunSetup({
  open,
  initialMode,
  domainId,
  split,
  tasks,
  model,
  onClose,
  onConfigureModel,
  onStarted,
}: {
  open: boolean;
  initialMode: 'live' | 'simulation';
  domainId: string;
  split: Split;
  tasks: TaskMeta[];
  model: ModelStatus | null;
  onClose: () => void;
  onConfigureModel: () => void;
  onStarted: (run: Run) => Promise<void>;
}) {
  const available = useMemo(() => tasks.filter((task) => task.split === split), [tasks, split]);
  const [mode, setMode] = useState<'live' | 'simulation'>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trials, setTrials] = useState(1);
  const [adapterSource, setAdapterSource] = useState<'default' | 'saved'>('default');
  const [savedAdapter, setSavedAdapter] = useState<{ savedAt: string } | null>(null);
  const [budget, setBudget] = useState({ ...DEFAULT_BUDGET });
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showBudget, setShowBudget] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setSelected(new Set(available.map((task) => task.id)));
    setTrials(1);
    setBudget({ ...DEFAULT_BUDGET });
    setError(null);
    setPlanError(null);
    setPlan(null);
    setAdapterSource('default');
    void (async () => {
      try {
        const response = await api.get<{ saved: { savedAt: string } | null }>(`/api/adapters/${domainId}`);
        setSavedAdapter(response.saved);
      } catch {
        setSavedAdapter(null);
      }
    })();
  }, [open, initialMode, domainId, split, available]);

  useEffect(() => {
    if (!open || selected.size === 0) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await api.post<RunPlan>('/api/runs/plan', {
          domain: domainId,
          split,
          taskIds: [...selected],
          conditions: ['original', 'descriptions', 'adapted'],
          trialsPerTask: trials,
          budget: {
            maxUnderlyingToolCallsPerTrial: Number(budget.perTrialCalls) || 6,
            maxUnderlyingToolCallsTotal: Number(budget.totalCalls) || 120,
            maxTurnsPerTrial: Number(budget.turns) || 8,
            maxTotalTokens: Number(budget.tokens) || 250000,
            maxWallClockMsPerTrial: (Number(budget.wallSeconds) || 180) * 1000,
          },
        });
        if (!cancelled) {
          setPlan(response);
          setPlanError(null);
        }
      } catch (caught) {
        if (!cancelled) setPlanError((caught as Error).message);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, domainId, split, selected, trials, budget]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = async () => {
    setError(null);
    if (selected.size === 0) {
      setError('Select at least one task.');
      return;
    }
    if (mode === 'live' && !model?.configured) {
      setError('Configure a model before starting a live run.');
      return;
    }
    setStarting(true);
    try {
      const response = await api.post<{ run: Run }>('/api/runs', {
        mode,
        domain: domainId,
        split,
        taskIds: [...selected],
        conditions: ['original', 'descriptions', 'adapted'],
        trialsPerTask: trials,
        adapterSource,
        budget: {
          maxUnderlyingToolCallsPerTrial: Number(budget.perTrialCalls) || 6,
          maxUnderlyingToolCallsTotal: Number(budget.totalCalls) || 120,
          maxTurnsPerTrial: Number(budget.turns) || 8,
          maxTotalTokens: Number(budget.tokens) || 250000,
          maxWallClockMsPerTrial: (Number(budget.wallSeconds) || 180) * 1000,
        },
      });
      await onStarted(response.run);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const detail = caught.detail as { path?: string; message?: string }[] | null;
        setError(detail && Array.isArray(detail) ? `${caught.message} ${detail.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}` : caught.message);
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setStarting(false);
    }
  };

  const allSelected = selected.size === available.length;

  return (
    <Modal
      open={open}
      title="Run experiment"
      subtitle={`${domainId} · ${splitName(split)} split · three interface conditions`}
      onClose={onClose}
      width={860}
    >
      <div className="mode-choice" role="group" aria-label="Run mode">
        <button
          type="button"
          className={mode === 'simulation' ? 'mode-card is-active' : 'mode-card'}
          aria-pressed={mode === 'simulation'}
          onClick={() => setMode('simulation')}
        >
          <span className="mono eyebrow">Rehearsal</span>
          <strong>Simulation</strong>
          <span className="small">Deterministic scripted policy. Labeled everywhere and excluded from live evidence.</span>
        </button>
        <button
          type="button"
          className={mode === 'live' ? 'mode-card is-active' : 'mode-card'}
          aria-pressed={mode === 'live'}
          onClick={() => setMode('live')}
        >
          <span className="mono eyebrow">Measured</span>
          <strong>Live model</strong>
          <span className="small">{model?.configured ? `Calls ${model.model} at ${model.baseUrl}.` : 'Requires an open-model endpoint.'}</span>
        </button>
      </div>

      {mode === 'live' && !model?.configured ? (
        <Banner tone="warning" title="No model configured">
          <div className="inline-actions">
            <span>Live runs need a local Ollama model or a user-supplied OpenAI-compatible endpoint.</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={onConfigureModel}>
              Configure model
            </button>
          </div>
        </Banner>
      ) : null}
      {mode === 'simulation' ? (
        <Banner tone="info" title="Simulation is not model evidence">
          The scripted policy exercises the real interfaces, mappings and validators. It cannot show whether an interface helps a model.
        </Banner>
      ) : null}

      <div className="setup-grid">
        <div>
          <div className="setup-head">
            <div>
              <p className="mono eyebrow">Tasks</p>
              <p className="mono small muted">
                {selected.size}/{available.length} selected · {available.length} available
              </p>
            </div>
            <button
              type="button"
              className="text-btn mono"
              onClick={() => setSelected(allSelected ? new Set() : new Set(available.map((task) => task.id)))}
            >
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <div className="task-checklist">
            {available.map((task) => (
              <label key={task.id} className={selected.has(task.id) ? 'task-check is-selected' : 'task-check'}>
                <input type="checkbox" checked={selected.has(task.id)} onChange={() => toggle(task.id)} />
                <span>
                  <strong>{task.title}</strong>
                  <span className="mono tiny muted">{task.id} · {task.family}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="setup-side">
          <div className="field">
            <span className="field-label mono">Conditions</span>
            <div className="fixed-conditions">
              <span className="chip">Original</span>
              <span className="chip">Descriptions</span>
              <span className="chip">Adapted</span>
            </div>
            <p className="field-hint">Fixed three-way comparison. Only the interface differs.</p>
          </div>

          <div className="field">
            <label className="field-label mono" htmlFor="trials">Trials per task</label>
            <select id="trials" className="input" value={trials} onChange={(event) => setTrials(Number(event.target.value))}>
              <option value={1}>1 trial</option>
              <option value={2}>2 trials</option>
              <option value={3}>3 trials</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label mono" htmlFor="adapter-source">Adapter</label>
            <select
              id="adapter-source"
              className="input"
              value={adapterSource}
              onChange={(event) => setAdapterSource(event.target.value as 'default' | 'saved')}
            >
              <option value="default">Built-in default</option>
              <option value="saved" disabled={!savedAdapter}>
                Saved local adapter{savedAdapter ? '' : ' (none)'}
              </option>
            </select>
          </div>

          <div className="plan-box" aria-live="polite">
            <p className="mono eyebrow">Before you start</p>
            {plan ? (
              <dl className="plan-stats">
                <div>
                  <dt>Attempts</dt>
                  <dd>{plan.plannedTrials}</dd>
                </div>
                <div>
                  <dt>Max underlying calls</dt>
                  <dd>{plan.maxUnderlyingToolCalls}</dd>
                </div>
                <div>
                  <dt>Max turns / trial</dt>
                  <dd>{plan.budget.maxTurnsPerTrial}</dd>
                </div>
                <div>
                  <dt>Token cap</dt>
                  <dd>{Number(plan.budget.maxTotalTokens).toLocaleString()}</dd>
                </div>
              </dl>
            ) : (
              <p className="small muted">{selected.size === 0 ? 'Select tasks to see the planned budget.' : 'Computing plan…'}</p>
            )}
            {planError ? <p className="small err-text">{planError}</p> : null}
            <p className="tiny muted">
              Every attempted call to a condition tool counts, including schema-invalid and compile-failed attempts. Unknown tool names do not
              reach an executor and are not counted.
            </p>
          </div>

          <details className="budget-details" open={showBudget} onToggle={(event) => setShowBudget((event.target as HTMLDetailsElement).open)}>
            <summary className="mono small">Budgets and limits</summary>
            <div className="budget-grid">
              <label className="field">
                <span className="field-label mono">Calls / trial</span>
                <input
                  className="input mono"
                  type="number"
                  min="1"
                  max="24"
                  value={budget.perTrialCalls}
                  onChange={(event) => setBudget({ ...budget, perTrialCalls: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label mono">Total calls</span>
                <input
                  className="input mono"
                  type="number"
                  min="1"
                  max="2000"
                  value={budget.totalCalls}
                  onChange={(event) => setBudget({ ...budget, totalCalls: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label mono">Turns / trial</span>
                <input
                  className="input mono"
                  type="number"
                  min="1"
                  max="20"
                  value={budget.turns}
                  onChange={(event) => setBudget({ ...budget, turns: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label mono">Total tokens</span>
                <input
                  className="input mono"
                  type="number"
                  min="1000"
                  max="2000000"
                  step="1000"
                  value={budget.tokens}
                  onChange={(event) => setBudget({ ...budget, tokens: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label mono">Wall clock / trial (s)</span>
                <input
                  className="input mono"
                  type="number"
                  min="5"
                  max="600"
                  value={budget.wallSeconds}
                  onChange={(event) => setBudget({ ...budget, wallSeconds: event.target.value })}
                />
              </label>
            </div>
            <p className="tiny muted">
              Provider-reported cost is recorded only when the endpoint reports it. Anvil does not estimate a fake cost. Wall-clock limits and
              cancellation stop a trial cleanly.
            </p>
          </details>
        </div>
      </div>

      {error ? <Banner tone="danger" title="Could not start">{error}</Banner> : null}

      <footer className="modal-foot">
        <div className="foot-left">
          <span className="mono tiny muted">
            {mode === 'live' ? `Model: ${model?.model ?? 'not configured'}` : 'No model calls · local fixtures'}
          </span>
        </div>
        <div className="foot-right">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start()}
            disabled={starting || selected.size === 0 || (mode === 'live' && !model?.configured)}
          >
            {starting ? 'Starting…' : mode === 'live' ? 'Start live run' : 'Start simulation'}
          </button>
        </div>
      </footer>
    </Modal>
  );
}