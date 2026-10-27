import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { DomainInfo, ModelStatus, Run, RunListItem, Split, TaskMeta, Trial, ConditionId } from './types';
import { AnvilMark, Banner } from './components';
import { Workbench } from './views/Workbench';
import { Experiments } from './views/Experiments';
import { Interfaces } from './views/Interfaces';
import { Integration } from './views/Integration';
import { ModelPanel } from './panels/ModelPanel';
import { IS_REPLAY } from './replay';
import { RunSetup } from './panels/RunSetup';

type View = 'workbench' | 'experiments' | 'interfaces' | 'integration';
export interface Selection {
  taskId: string;
  condition: ConditionId;
  trialNumber: number;
}

const NAV: Array<{ id: View; label: string; hint: string }> = [
  { id: 'workbench', label: 'Workbench', hint: 'Compare and inspect trials' },
  { id: 'experiments', label: 'Experiments', hint: 'Saved runs and evidence' },
  { id: 'interfaces', label: 'Interfaces', hint: 'Schemas and adapter editing' },
  { id: 'integration', label: 'Integration', hint: 'MCP and Alan status' },
];

/**
 * The recorded replay opens on the clearest sealed eval v2 contrast: the
 * largest completed live gpt-oss-20b calendar run (all three conditions),
 * falling back to any completed live eval v2 run.
 */
function replayLandingRun(runs: RunListItem[]): RunListItem | null {
  const eval2 = runs.filter((run) => run.split === 'eval2' && run.mode === 'live' && run.status === 'completed');
  const largest = (list: RunListItem[]) =>
    list.reduce<RunListItem | null>((best, run) => (!best || run.attempts > best.attempts ? run : best), null);
  return (
    largest(eval2.filter((run) => run.domain === 'calendar' && run.model.includes('gpt-oss'))) ??
    largest(eval2.filter((run) => run.model.includes('gpt-oss'))) ??
    largest(eval2)
  );
}

export function App() {
  const [view, setView] = useState<View>('workbench');
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [tasksByDomain, setTasksByDomain] = useState<Record<string, TaskMeta[]>>({});
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [domainId, setDomainId] = useState('calendar');
  const [split, setSplit] = useState<Split>('dev');
  const [run, setRun] = useState<Run | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<'live' | 'simulation'>('live');
  const [afterModel, setAfterModel] = useState(false);
  const booted = useRef(false);

  const refreshRuns = useCallback(async () => {
    const response = await api.get<{ runs: RunListItem[] }>('/api/runs');
    setRuns(response.runs);
    return response.runs;
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const response = await api.get<{ run: Run }>(`/api/runs/${id}`);
    setRun(response.run);
    setActiveRunId(id);
    const first = response.run.trials[0];
    setSelection(first ? { taskId: first.taskId, condition: first.condition, trialNumber: first.trial } : null);
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      try {
        const [health, domainResponse, runResponse, configResponse] = await Promise.all([
          api.get<{ model: ModelStatus }>('/api/health'),
          api.get<{ domains: DomainInfo[] }>('/api/domains'),
          api.get<{ runs: RunListItem[] }>('/api/runs'),
          api.get<{ status: ModelStatus }>('/api/config/model'),
        ]);
        setModel(configResponse.status ?? health.model);
        setDomains(domainResponse.domains);
        setRuns(runResponse.runs);
        const taskEntries = await Promise.all(
          domainResponse.domains.map(async (domain) => {
            const response = await api.get<{ tasks: TaskMeta[] }>(`/api/tasks?domain=${encodeURIComponent(domain.id)}`);
            return [domain.id, response.tasks] as const;
          }),
        );
        setTasksByDomain(Object.fromEntries(taskEntries));
        const latest =
          (IS_REPLAY ? replayLandingRun(runResponse.runs) : null) ??
          runResponse.runs.find((candidate) => candidate.domain === 'calendar' && candidate.split === 'dev') ??
          runResponse.runs[0];
        if (latest) {
          setDomainId(latest.domain);
          setSplit(latest.split);
          await loadRun(latest.id);
        }
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadRun]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const handle = (next: Run) => {
      if (closed) return;
      setRun(next);
      if (next.status !== 'running') {
        void refreshRuns();
      }
    };
    if (typeof EventSource !== 'undefined') {
      source = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/events`);
      source.addEventListener('run', (event) => {
        try {
          handle(JSON.parse((event as MessageEvent).data) as Run);
        } catch {
          // Ignore malformed stream payloads; polling remains as a fallback.
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
      };
    }
    poll = setInterval(async () => {
      try {
        const response = await api.get<{ run: Run }>(`/api/runs/${run.id}`);
        handle(response.run);
      } catch {
        // Keep the last state; the run page can be refreshed manually.
      }
    }, 4000);
    return () => {
      closed = true;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [run?.id, run?.status, refreshRuns]);

  const tasks = tasksByDomain[domainId] ?? [];
  const selectedTrial: Trial | null =
    run && selection
      ? run.trials.find(
          (trial) => trial.taskId === selection.taskId && trial.condition === selection.condition && trial.trial === selection.trialNumber,
        ) ?? null
      : null;

  const pickRunFor = (candidateRuns: RunListItem[], domain: string, splitValue: Split, preferredId?: string | null) => {
    if (preferredId) {
      const preferred = candidateRuns.find((item) => item.id === preferredId);
      if (preferred) return preferred;
    }
    return candidateRuns.find((item) => item.domain === domain && item.split === splitValue) ?? null;
  };

  const changeDomain = (next: string) => {
    setDomainId(next);
    setSelection(null);
    const candidate = pickRunFor(runs, next, split);
    if (candidate) void loadRun(candidate.id);
    else {
      setRun(null);
      setActiveRunId(null);
    }
  };

  const changeSplit = (next: Split) => {
    setSplit(next);
    setSelection(null);
    const candidate = pickRunFor(runs, domainId, next);
    if (candidate) void loadRun(candidate.id);
    else {
      setRun(null);
      setActiveRunId(null);
    }
  };

  const openRun = async (item: RunListItem) => {
    setView('workbench');
    setDomainId(item.domain);
    setSplit(item.split);
    try {
      await loadRun(item.id);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const startRun = async (next: Run) => {
    setSetupOpen(false);
    setView('workbench');
    setDomainId(next.config.domain);
    setSplit(next.config.split);
    setRun(next);
    setActiveRunId(next.id);
    setSelection(next.trials[0] ? { taskId: next.trials[0].taskId, condition: next.trials[0].condition, trialNumber: next.trials[0].trial } : null);
    setNotice(next.mode === 'simulation' ? 'Scripted simulation started. It is a rehearsal, not model evidence.' : 'Live experiment started.');
    await refreshRuns();
  };

  const quickSimulation = async () => {
    try {
      setError(null);
      const response = await api.post<{ run: Run }>('/api/runs', {
        mode: 'simulation',
        domain: domainId,
        split,
        trialsPerTask: 1,
      });
      await startRun(response.run);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    }
  };

  const openSetup = (mode: 'live' | 'simulation') => {
    if (mode === 'live' && model && !model.configured) {
      setAfterModel(true);
      setModelOpen(true);
      return;
    }
    setSetupMode(mode);
    setSetupOpen(true);
  };

  const runningCount = runs.filter((item) => item.status === 'running').length;

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="rail-brand">
          <AnvilMark size={30} />
          <span className="rail-word">ANVIL</span>
        </div>
        <nav className="rail-nav" aria-label="Main">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? 'rail-btn is-active' : 'rail-btn'}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
              title={item.hint}
            >
              <span className="rail-btn-mark" aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="mono">v0.1</span>
          <span className="mono">{IS_REPLAY ? 'replay' : 'local'}</span>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div className="brandline">
            <span className="mono eyebrow">Tool-interface workbench</span>
            <span className="brand-rule" aria-hidden="true" />
            <span className="mono eyebrow muted">Independent state checks · open models</span>
          </div>
          <div className="topbar-main">
            <div>
              <h1 className="product-title">Anvil</h1>
              <p className="muted topbar-sub">
                Does changing the tool interface help this model finish tasks?
              </p>
            </div>
            {IS_REPLAY ? (
              <div className="topbar-actions">
                <span className="chip chip-sim replay-chip">Recorded replay · read-only</span>
              </div>
            ) : (
            <div className="topbar-actions">
              <button
                type="button"
                className={model?.configured ? 'model-pill is-ready' : 'model-pill'}
                onClick={() => setModelOpen(true)}
                aria-label="Model and provider settings"
              >
                <span className="model-dot" aria-hidden="true" />
                <span className="model-pill-text">
                  <span className="mono model-pill-label">Model</span>
                  <span>{model?.configured ? model.model : 'Not configured'}</span>
                </span>
              </button>
              <button type="button" className="btn btn-primary" onClick={() => openSetup('live')}>
                Run experiment
              </button>
            </div>
            )}
          </div>
        </header>

        {IS_REPLAY ? (
          <div className="shell-alerts">
            <Banner tone="info" title="Recorded replay">
              Every live result here was recorded with an open model, either local Ollama or hosted OpenAI-compatible
              endpoints (DeepSeek V4.1 Flash, and NVIDIA-hosted Nemotron and gpt-oss-20b); the exact model id and endpoint are on
              each run. Results are shown exactly as stored. Runs labelled simulation used a scripted policy and are not model evidence. Nothing on this
              page calls a model; adapter validation and mapping previews run in your browser. To run experiments, clone the
              repository and start Anvil locally.
            </Banner>
          </div>
        ) : null}

        {error ? (
          <div className="shell-alerts">
            <Banner tone="danger" title="Something needs attention">
              {error}
              <button type="button" className="text-btn" onClick={() => setError(null)} style={{ marginLeft: 10 }}>
                Dismiss
              </button>
            </Banner>
          </div>
        ) : null}
        {notice ? (
          <div className="shell-alerts">
            <Banner tone="info">{notice}</Banner>
          </div>
        ) : null}

        <main className="main">
          {loading ? (
            <div className="loading-page">
              <div className="loading-rule" />
              <p className="mono">Loading workbench…</p>
            </div>
          ) : view === 'workbench' ? (
            <Workbench
              domains={domains}
              tasks={tasks}
              domainId={domainId}
              split={split}
              run={run}
              runs={runs}
              model={model}
              selectedTrial={selectedTrial}
              selection={selection}
              runningCount={runningCount}
              onChangeDomain={changeDomain}
              onChangeSplit={changeSplit}
              onSelect={setSelection}
              onOpenSetup={openSetup}
              onQuickSimulation={quickSimulation}
              onRefreshRuns={async () => {
                await refreshRuns();
              }}
              onCancel={async () => {
                if (!run) return;
                try {
                  const response = await api.post<{ run: Run }>(`/api/runs/${run.id}/cancel`);
                  setRun(response.run);
                  await refreshRuns();
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
          ) : view === 'experiments' ? (
            <Experiments runs={runs} onOpen={openRun} onRefresh={refreshRuns} />
          ) : view === 'interfaces' ? (
            <Interfaces domains={domains} domainId={domainId} onChangeDomain={changeDomain} />
          ) : (
            <Integration model={model} />
          )}
        </main>
      </div>

      <ModelPanel
        open={modelOpen}
        status={model}
        onClose={() => {
          setModelOpen(false);
          setAfterModel(false);
        }}
        onSaved={(status) => {
          setModel(status);
          if (afterModel && status.configured) {
            setAfterModel(false);
            setModelOpen(false);
            setSetupMode('live');
            setSetupOpen(true);
          }
        }}
      />
      <RunSetup
        open={setupOpen}
        initialMode={setupMode}
        domainId={domainId}
        split={split}
        tasks={tasks}
        model={model}
        onClose={() => setSetupOpen(false)}
        onConfigureModel={() => {
          setSetupOpen(false);
          setAfterModel(true);
          setModelOpen(true);
        }}
        onStarted={startRun}
      />
    </div>
  );
}