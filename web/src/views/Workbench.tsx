import { useEffect, useState } from 'react';
import type {
  ConditionId,
  ConditionSummary,
  DomainInfo,
  ModelStatus,
  Run,
  RunListItem,
  Split,
  StateDiff,
  TaskMeta,
  Trial,
  ToolCallRecord,
} from '../types';
import {
  AnvilMark,
  Banner,
  CONDITION_LABEL,
  CONDITION_NOTE,
  Chevron,
  EmptyMark,
  JsonBlock,
  Segmented,
  Spinner,
  StatusChip,
  StatusWord,
} from '../components';
import { formatDuration, formatTime, percent, shortHash } from '../api';
import { splitName } from '../types';
import { downloadAvailable, downloadHref, IS_REPLAY } from '../replay';
import type { Selection } from '../App';

const CONDITIONS: ConditionId[] = ['original', 'descriptions', 'adapted'];

export function Workbench({
  domains,
  tasks,
  domainId,
  split,
  run,
  runs,
  model,
  selectedTrial,
  selection,
  runningCount,
  onChangeDomain,
  onChangeSplit,
  onSelect,
  onOpenSetup,
  onQuickSimulation,
  onRefreshRuns,
  onCancel,
}: {
  domains: DomainInfo[];
  tasks: TaskMeta[];
  domainId: string;
  split: Split;
  run: Run | null;
  runs: RunListItem[];
  model: ModelStatus | null;
  selectedTrial: Trial | null;
  selection: Selection | null;
  runningCount: number;
  onChangeDomain: (id: string) => void;
  onChangeSplit: (split: Split) => void;
  onSelect: (selection: Selection) => void;
  onOpenSetup: (mode: 'live' | 'simulation') => void;
  onQuickSimulation: () => Promise<void>;
  onRefreshRuns: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const domain = domains.find((candidate) => candidate.id === domainId);
  const splitTasks = tasks.filter((task) => task.split === split);
  const matchingRuns = runs.filter((candidate) => candidate.domain === domainId && candidate.split === split);
  const [busySimulation, setBusySimulation] = useState(false);

  return (
    <div className="view">
      <div className="view-head">
        <div className="domain-row">
          <div className="domain-tabs" role="tablist" aria-label="Domain">
            {domains.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === domainId}
                className={candidate.id === domainId ? 'domain-tab is-active' : 'domain-tab'}
                onClick={() => onChangeDomain(candidate.id)}
              >
                <span>{candidate.name}</span>
                <span className="mono domain-count">
                  {candidate.tasks.dev} dev · {candidate.tasks.eval} eval v1 · {candidate.tasks.eval2 ?? 0} eval v2
                </span>
              </button>
            ))}
          </div>
          <div className="head-tools">
            <Segmented
              ariaLabel="Task split"
              value={split}
              onChange={(next) => onChangeSplit(next)}
              options={[
                { value: 'dev', label: 'Development' },
                { value: 'eval', label: 'Eval v1 (seen)' },
                { value: 'eval2', label: 'Sealed eval v2' },
              ]}
            />
          </div>
        </div>
        {domain ? <p className="environment mono">{domain.environment}</p> : null}
      </div>

      <div className="run-strip">
        <div className="run-strip-id">
          <span className="mono eyebrow">Experiment</span>
          {run ? (
            <>
              <span className="run-id mono">{run.id}</span>
              <StatusWord status={run.status} />
              <span className={`chip ${run.mode === 'simulation' ? 'chip-sim' : 'chip-live'}`}>
                {run.mode === 'simulation' ? 'Simulation' : 'Live model'}
              </span>
              <span className="mono muted">
                {run.trials.length} attempt{run.trials.length === 1 ? '' : 's'} · {formatTime(run.createdAt)}
              </span>
            </>
          ) : (
            <span className="muted">
              No {splitName(split)} run yet for {domain?.name ?? domainId}.
            </span>
          )}
        </div>
        <div className="run-strip-actions">
          {run?.status === 'running' ? (
            <button type="button" className="btn btn-danger btn-small" onClick={() => void onCancel()}>
              Stop run
            </button>
          ) : null}
          {run && downloadAvailable(`/api/runs/${run.id}/export`) ? (
            <a className="btn btn-ghost btn-small" href={downloadHref(`/api/runs/${run.id}/export`)} download>
              Export evidence
            </a>
          ) : run ? (
            <span className="mono tiny" title="The evidence bundle for this run was not captured in this replay.">
              Export not in replay
            </span>
          ) : null}
          {!IS_REPLAY ? (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={async () => {
                setBusySimulation(true);
                try {
                  await onQuickSimulation();
                } finally {
                  setBusySimulation(false);
                }
              }}
              disabled={busySimulation}
            >
              {busySimulation ? 'Starting…' : 'Explore a simulation'}
            </button>
          ) : null}
          {!IS_REPLAY ? (
            <button type="button" className="btn btn-primary btn-small" onClick={() => onOpenSetup('live')}>
              Run experiment
            </button>
          ) : null}
        </div>
      </div>

      {runningCount > 0 && run?.status !== 'running' ? (
        <Banner tone="info" title="A run is active">
          {runningCount} experiment{runningCount === 1 ? '' : 's'} running elsewhere in this workbench. Open Experiments to follow it.
        </Banner>
      ) : null}

      {!run ? (
        <ScenarioEmpty
          domainId={domainId}
          split={split}
          tasks={splitTasks}
          model={model}
          matchingRuns={matchingRuns.length}
          onOpenSetup={onOpenSetup}
          onQuickSimulation={onQuickSimulation}
        />
      ) : (
        <>
          <RunNotice run={run} />
          <Comparison run={run} />
          <Progress run={run} />
          {run.error ? <Banner tone="danger" title="Run failure">{run.error}</Banner> : null}
          <div className="work-grid">
            <TaskMatrix run={run} tasks={tasks} selection={selection} onSelect={onSelect} />
            <div className="detail-column">
              {selectedTrial ? (
                <TrialDetail run={run} trial={selectedTrial} selection={selection} onSelect={onSelect} />
              ) : (
                <div className="panel empty-panel">
                  <p className="mono eyebrow">Inspect a trial</p>
                  <p>
                    Select a status cell to inspect every model turn, the proposed tool input, the compiled original call,
                    the independent checks and the exact state diff.
                  </p>
                </div>
              )}
            </div>
          </div>
          <RunNotes run={run} />
        </>
      )}
    </div>
  );
}

function ScenarioEmpty({
  domainId,
  split,
  tasks,
  model,
  matchingRuns,
  onOpenSetup,
  onQuickSimulation,
}: {
  domainId: string;
  split: Split;
  tasks: TaskMeta[];
  model: ModelStatus | null;
  matchingRuns: number;
  onOpenSetup: (mode: 'live' | 'simulation') => void;
  onQuickSimulation: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <section className="empty-state">
        <EmptyMark />
        <div className="empty-copy">
          <p className="mono eyebrow">First run</p>
          <h2>Start with a measured comparison.</h2>
          <p>
            The experiment holds the tasks, fixture, model, temperature and budgets constant. Only the tool interface changes:
            raw tools, improved descriptions, or executable adapted tools. Every final state is checked independently.
          </p>
          {matchingRuns === 0 ? (
            <p className="muted small">
              No saved run exists for this domain and split yet. Simulation is a deterministic rehearsal; it is not model evidence.
            </p>
          ) : null}
          {IS_REPLAY ? (
            <p className="inline-note">
              No recorded run exists for this domain and split in this replay. Pick another split or domain, or run Anvil locally.
            </p>
          ) : (
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => onOpenSetup('live')}>
              Run with a model
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onQuickSimulation();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Starting simulation…' : 'Explore a simulation'}
            </button>
          </div>
          )}
          {!IS_REPLAY && !model?.configured ? (
            <p className="inline-note">
              A live run needs a local Ollama model or a user-supplied OpenAI-compatible endpoint. No key is stored in the browser
              or on disk.
            </p>
          ) : null}
        </div>
      </section>

      <section className="workflow" aria-label="How Anvil works">
        <div className="workflow-step">
          <span className="mono step-num">01</span>
          <h3>Configure one open model</h3>
          <p>Local Ollama or a user-supplied OpenAI-compatible endpoint. Same model and guidance in all three conditions.</p>
        </div>
        <div className="workflow-step">
          <span className="mono step-num">02</span>
          <h3>Run three interfaces</h3>
          <p>Original, descriptions-only and executable adapters, reset to the same fixture before every trial.</p>
        </div>
        <div className="workflow-step">
          <span className="mono step-num">03</span>
          <h3>Inspect state, not prose</h3>
          <p>Independent assertions check the intended change and the preservation of unrelated records.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="mono eyebrow">Task set</p>
            <h2>{tasks.length} tasks in the {splitName(split)} split</h2>
          </div>
          <span className="mono muted">{domainId}</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Family</th>
                <th>What it tests</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <strong>{task.title}</strong>
                    <span className="cell-sub mono">{task.id}</span>
                  </td>
                  <td className="mono small">{task.family}</td>
                  <td className="prompt-cell">{task.prompt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function RunNotice({ run }: { run: Run }) {
  if (run.mode === 'simulation') {
    return (
      <Banner tone="warning" title="Scripted simulation — not model evidence">
        A deterministic local policy drove the interface. No model was called. These results exercise the engine and may demonstrate
        mapping or checker behavior, but they are excluded from every live performance claim.
      </Banner>
    );
  }
  const identity = run.provenance.modelIdentity;
  return (
    <Banner tone="info" title="Live model evidence">
      Requests went to <span className="mono">{identity?.baseUrl ?? run.config.model.baseUrl}</span> using{' '}
      <span className="mono">{identity?.reported ?? run.config.model.model}</span>
      {identity?.reported && identity.reported !== run.config.model.model ? ` (requested ${run.config.model.model})` : ''}. Counts are
      descriptive. Small pilots do not establish statistical superiority.
    </Banner>
  );
}

function Comparison({ run }: { run: Run }) {
  return (
    <section className="comparison" aria-label="Condition comparison">
      {CONDITIONS.map((condition) => {
        const summary = run.summary.byCondition[condition];
        return <ConditionCard key={condition} condition={condition} summary={summary} run={run} />;
      })}
    </section>
  );
}

function ConditionCard({
  condition,
  summary,
  run,
}: {
  condition: ConditionId;
  summary: ConditionSummary | undefined;
  run: Run;
}) {
  const attempts = summary?.attempts ?? 0;
  const segments = summary
    ? ([
        ['pass', summary.pass],
        ['fail', summary.fail],
        ['invalid', summary.invalid],
        ['error', summary.error],
        ['canceled', summary.canceled],
      ] as const)
    : [];
  return (
    <article className={`condition-card condition-${condition}`}>
      <header className="condition-head">
        <div>
          <p className="mono eyebrow">{condition === 'adapted' ? 'Executable adapter' : condition === 'descriptions' ? 'Descriptions only' : 'Raw interface'}</p>
          <h3>{CONDITION_LABEL[condition]}</h3>
        </div>
        <span className="mono hash" title={run.provenance.interfaceHashes[condition]}>
          {shortHash(run.provenance.interfaceHashes[condition])}
        </span>
      </header>
      <div className="condition-score">
        <span className="score-big">
          {attempts > 0 ? `${summary?.pass ?? 0}/${attempts}` : '—'}
        </span>
        <span className="score-label mono">pass / attempts</span>
      </div>
      <div className="segment-bar" aria-hidden="true">
        {segments.map(([status, count]) =>
          count > 0 ? <span key={status} className={`segment segment-${status}`} style={{ flexGrow: count }} /> : null,
        )}
        {attempts === 0 ? <span className="segment segment-empty" /> : null}
      </div>
      <dl className="condition-stats">
        <div>
          <dt>Decisive pass</dt>
          <dd>{percent(summary?.decisivePassRate ?? null)}</dd>
        </div>
        <div>
          <dt>Invalid / error</dt>
          <dd>
            {(summary?.invalid ?? 0) + (summary?.error ?? 0)}
          </dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{summary?.underlyingToolCalls ?? 0}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{summary?.totalTokens ?? 'unknown'}</dd>
        </div>
      </dl>
      {summary?.wilson95 && run.mode === 'live' ? (
        <p className="mono tiny muted">
          95% Wilson interval {percent(summary.wilson95[0])}–{percent(summary.wilson95[1])} (descriptive, not a significance test)
        </p>
      ) : null}
      <p className="condition-note">{CONDITION_NOTE[condition]}</p>
    </article>
  );
}

function Progress({ run }: { run: Run }) {
  const planned = run.taskIds.length * run.config.conditions.length * run.config.trialsPerTask;
  const done = run.trials.length;
  if (run.status !== 'running' && done === planned) return null;
  return (
    <div className="progress-panel">
      <div className="progress-top">
        <Spinner label={run.status === 'running' ? 'Experiment running' : `Run ${run.status}`} />
        <span className="mono small">
          {done}/{planned} attempts
        </span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={planned}
        aria-valuenow={done}
        aria-label="Experiment progress"
      >
        <span style={{ width: `${planned > 0 ? Math.min(100, (done / planned) * 100) : 0}%` }} />
      </div>
      <p className="tiny muted mono">
        Budget: {run.config.budget.maxUnderlyingToolCallsTotal} underlying calls total · {run.config.budget.maxTurnsPerTrial} turns per trial
      </p>
    </div>
  );
}

function TaskMatrix({
  run,
  tasks,
  selection,
  onSelect,
}: {
  run: Run;
  tasks: TaskMeta[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const orderedTasks = run.taskIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is TaskMeta => Boolean(task));
  return (
    <section className="panel matrix-panel">
      <div className="panel-head">
        <div>
          <p className="mono eyebrow">Tasks × interfaces</p>
          <h2>Attempt outcomes</h2>
        </div>
        <span className="mono muted small">click a status</span>
      </div>
      <div className="table-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Task</th>
              {CONDITIONS.map((condition) => (
                <th key={condition} scope="col" className="mono">
                  {CONDITION_LABEL[condition]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orderedTasks.map((task) => {
              const family = task.family;
              return (
                <tr key={task.id}>
                  <th scope="row">
                    <span className="matrix-task">{task.title}</span>
                    <span className="mono tiny muted">{family}</span>
                  </th>
                  {CONDITIONS.map((condition) => {
                    const trials = run.trials
                      .filter((trial) => trial.taskId === task.id && trial.condition === condition)
                      .sort((a, b) => a.trial - b.trial);
                    const active = selection?.taskId === task.id && selection.condition === condition;
                    if (trials.length === 0) {
                      return (
                        <td key={condition} className="matrix-cell">
                          <span className="mono muted">—</span>
                        </td>
                      );
                    }
                    return (
                      <td key={condition} className={active ? 'matrix-cell is-active' : 'matrix-cell'}>
                        <div className="matrix-dots">
                          {trials.map((trial) => (
                            <button
                              key={trial.id}
                              type="button"
                              className={`matrix-dot status-bg-${trial.status}`}
                              title={`${task.title} · ${CONDITION_LABEL[condition]} · trial ${trial.trial} · ${trial.status}${trial.statusReason ? ` — ${trial.statusReason}` : ''}`}
                              aria-label={`Inspect ${task.title}, ${CONDITION_LABEL[condition]}, trial ${trial.trial}, ${trial.status}`}
                              onClick={() => onSelect({ taskId: task.id, condition, trialNumber: trial.trial })}
                            >
                              <span aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                        <span className="mono tiny muted">
                          {trials.filter((trial) => trial.status === 'pass').length}/{trials.length}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrialDetail({
  run,
  trial,
  selection,
  onSelect,
}: {
  run: Run;
  trial: Trial;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const [tab, setTab] = useState<'trace' | 'checks' | 'diff' | 'raw'>('trace');
  useEffect(() => {
    setTab('trace');
  }, [trial.id]);

  const siblings = CONDITIONS.map((condition) => ({
    condition,
    trial: run.trials.find(
      (candidate) => candidate.taskId === trial.taskId && candidate.condition === condition && candidate.trial === trial.trial,
    ),
  }));

  return (
    <section className="panel trial-panel" aria-label="Trial detail">
      <header className="trial-head">
        <div>
          <p className="mono eyebrow">Trial detail · {trial.taskId}</p>
          <h2>{trial.taskTitle}</h2>
          <div className="trial-tags">
            <StatusChip status={trial.status} reason={trial.statusReason} />
            <span className={`chip ${trial.mode === 'simulation' ? 'chip-sim' : 'chip-live'}`}>
              {trial.mode === 'simulation' ? 'Simulated' : 'Live'}
            </span>
            <span className="mono tiny muted">{trial.family}</span>
          </div>
        </div>
        <div className="trial-cond-switch" role="group" aria-label="Same task, other conditions">
          {siblings.map(({ condition, trial: sibling }) => (
            <button
              key={condition}
              type="button"
              className={condition === trial.condition ? 'cond-btn is-active' : 'cond-btn'}
              disabled={!sibling}
              title={sibling ? `Inspect ${CONDITION_LABEL[condition]}` : 'No attempt in this condition'}
              onClick={() => {
                if (sibling && selection) onSelect({ ...selection, condition });
              }}
            >
              <span>{CONDITION_LABEL[condition]}</span>
              {sibling ? <span className={`mini-dot status-bg-${sibling.status}`} aria-label={sibling.status} /> : null}
            </button>
          ))}
        </div>
      </header>

      {trial.statusReason ? <p className="status-reason">{trial.statusReason}</p> : null}
      {trial.error ? (
        <Banner tone="danger" title={`${trial.error.code}`}>
          {trial.error.message}
          {trial.error.detail ? <JsonBlock value={trial.error.detail} maxHeight={160} /> : null}
        </Banner>
      ) : null}

      <dl className="meta-grid">
        <div>
          <dt>Model</dt>
          <dd className="mono">{trial.model.reported ?? trial.model.requested}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd className="mono">{trial.model.provider}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(trial.durationMs)}</dd>
        </div>
        <div>
          <dt>Underlying calls</dt>
          <dd>{trial.usage.underlyingToolCalls}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{trial.usage.totalTokens ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>Provider cost</dt>
          <dd>{trial.usage.providerReportedCostUsd === null ? 'unknown' : `$${trial.usage.providerReportedCostUsd.toFixed(6)}`}</dd>
        </div>
        <div>
          <dt>Interface hash</dt>
          <dd className="mono tiny" title={trial.interfaceHash}>{shortHash(trial.interfaceHash)}</dd>
        </div>
        <div>
          <dt>Adapter hash</dt>
          <dd className="mono tiny" title={trial.adapterHash ?? ''}>{shortHash(trial.adapterHash)}</dd>
        </div>
      </dl>

      {trial.notes.length > 0 ? (
        <ul className="note-list">
          {trial.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="tabs" role="tablist" aria-label="Trial views">
        {([
          ['trace', `Trace (${trial.turns.length || trial.toolCalls.length})`],
          ['checks', `Checks (${trial.checks.filter((check) => check.ok).length}/${trial.checks.length})`],
          ['diff', `State diff (${trial.stateDiff.changes.length})`],
          ['raw', 'Raw'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab is-active' : 'tab'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === 'trace' ? <Trace trial={trial} /> : null}
        {tab === 'checks' ? <Checks trial={trial} /> : null}
        {tab === 'diff' ? <Diff diff={trial.stateDiff} /> : null}
        {tab === 'raw' ? <JsonBlock value={trial} label="Persisted trial record" maxHeight={560} /> : null}
      </div>

      {trial.finalAnswer ? (
        <div className="final-answer">
          <div className="section-label mono">Final answer</div>
          <pre>{trial.finalAnswer}</pre>
        </div>
      ) : null}
    </section>
  );
}

function Trace({ trial }: { trial: Trial }) {
  if (trial.turns.length === 0 && trial.toolCalls.length === 0) {
    return <p className="muted">No model turns or tool calls were recorded.</p>;
  }
  return (
    <div className="trace">
      {trial.turns.map((turn) => {
        const calls = trial.toolCalls.filter((call) => call.turn === turn.turn);
        return (
          <article className="turn" key={turn.turn}>
            <header className="turn-head">
              <span className="turn-num mono">Turn {turn.turn}</span>
              <span className="mono tiny muted">
                {turn.requestSummary.messageCount} messages · {turn.requestSummary.toolCount} tools · {formatDuration(turn.latencyMs)}
                {turn.finishReason ? ` · ${turn.finishReason}` : ''}
              </span>
            </header>
            {turn.content ? <div className="assistant-text">{turn.content}</div> : <p className="muted small">No assistant text in this turn.</p>}
            {turn.notes?.map((note) => (
              <p key={note} className="inline-note">{note}</p>
            ))}
            {calls.map((call) => (
              <ToolCallCard key={`${call.turn}-${call.index}`} call={call} />
            ))}
          </article>
        );
      })}
      {trial.turns.length === 0
        ? trial.toolCalls.map((call) => <ToolCallCard key={call.index} call={call} />)
        : null}
      {trial.turns.length === 0 ? (
        <p className="inline-note">Scripted simulation: no model transcript exists. Calls below came from the deterministic rehearsal policy.</p>
      ) : null}
    </div>
  );
}

function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={call.result.ok ? 'tool-call' : 'tool-call is-error'}>
      <button type="button" className="tool-call-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tool-call-title">
          <Chevron open={open} />
          <span className="mono tool-name">{call.publicTool}</span>
          <span className={`chip chip-tiny ${call.source === 'simulation' ? 'chip-sim' : 'chip-live'}`}>{call.source}</span>
          <span className={call.result.ok ? 'mono tiny ok-text' : 'mono tiny err-text'}>
            {call.result.ok ? 'ok' : call.result.error?.code ?? 'error'}
          </span>
        </span>
        <span className="mono tiny muted">
          {call.durationMs} ms ·{' '}
          {call.countedUnderlying
            ? `${call.underlyingCalls ?? 1} original call${(call.underlyingCalls ?? 1) === 1 ? '' : 's'} counted`
            : 'not counted'}
        </span>
      </button>
      {open ? (
        <div className="tool-call-body">
          {call.adaptedLookup ? (
            <div className="lookup-step">
              <div className="section-label mono">
                Step 1 · read-only lookup · {call.adaptedLookup.tool} ·{' '}
                <span className={call.adaptedLookup.ok ? 'ok-text' : 'err-text'}>
                  {call.adaptedLookup.ok
                    ? `exactly one match → ${call.adaptedLookup.matchedId}`
                    : `${call.adaptedLookup.matchCount} match${call.adaptedLookup.matchCount === 1 ? '' : 'es'} · no write`}
                </span>
              </div>
              <JsonBlock value={call.adaptedLookup.input} maxHeight={160} />
              {!call.adaptedLookup.ok && call.adaptedLookup.candidates.length > 0 ? (
                <>
                  <div className="section-label mono">Candidates returned to the model</div>
                  <JsonBlock value={call.adaptedLookup.candidates} maxHeight={200} />
                </>
              ) : null}
            </div>
          ) : null}
          <div className={call.adaptedCompilation ? 'call-grid' : 'call-grid is-single'}>
            <div>
              <div className="section-label mono">Proposed tool input</div>
              <JsonBlock value={call.proposedInput} maxHeight={240} />
            </div>
            {call.adaptedCompilation ? (
              <div>
                <div className="section-label mono">
                  {call.adaptedLookup ? 'Step 2 · ' : ''}Compiled original call · {call.adaptedCompilation.target}
                  {call.adaptedCompilation.input == null ? ' · not made' : ''}
                </div>
                {call.adaptedCompilation.input == null ? (
                  <p className="muted small">No original {call.adaptedCompilation.target} call was made; the fixture was not written.</p>
                ) : (
                  <JsonBlock value={call.adaptedCompilation.input} maxHeight={240} />
                )}
                {call.adaptedCompilation.transformNotes.length > 0 ? (
                  <ul className="transform-notes mono tiny">
                    {call.adaptedCompilation.transformNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
          {!call.validation.ok ? (
            <div className="validation-errors">
              <span className="mono tiny">Schema validation</span>
              {call.validation.errors.map((error) => (
                <code key={error}>{error}</code>
              ))}
            </div>
          ) : null}
          <div className="section-label mono">{call.result.ok ? 'Tool result' : 'Tool error'}</div>
          <JsonBlock value={call.result.ok ? call.result.content : call.result.error} maxHeight={280} />
        </div>
      ) : null}
    </div>
  );
}

function Checks({ trial }: { trial: Trial }) {
  if (trial.checks.length === 0) return <p className="muted">No checks were recorded.</p>;
  return (
    <ol className="check-list">
      {trial.checks.map((check) => (
        <li key={check.id} className={check.ok ? 'check is-ok' : 'check is-bad'}>
          <span className="check-mark" aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
          <div>
            <div className="check-title">
              <strong>{check.label}</strong>
              <span className="mono tiny muted">{check.kind} · {check.id}</span>
            </div>
            <p className="check-detail">{check.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Diff({ diff }: { diff: StateDiff }) {
  if (diff.changes.length === 0) {
    return (
      <div className="no-diff">
        <p>{diff.summary}</p>
        <p className="muted small">An empty diff is the expected result for read-only and no-op tasks.</p>
      </div>
    );
  }
  return (
    <div className="diff">
      <p className="mono small muted">{diff.summary}</p>
      {diff.changes.map((change) => (
        <article className={`diff-entity diff-${change.kind}`} key={`${change.kind}-${change.entity}`}>
          <header>
            <span className="mono">{change.entity}</span>
            <span className={`chip chip-tiny chip-${change.kind}`}>{change.kind}</span>
          </header>
          <table className="diff-table">
            <tbody>
              {change.fields.map((field) => (
                <tr key={field.field}>
                  <th scope="row" className="mono tiny">{field.field}</th>
                  <td className="mono tiny before">{JSON.stringify(field.before)}</td>
                  <td className="mono tiny after">{JSON.stringify(field.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ))}
    </div>
  );
}

function RunNotes({ run }: { run: Run }) {
  const pairs: Array<[ConditionId, ConditionId]> = [
    ['original', 'descriptions'],
    ['original', 'adapted'],
    ['descriptions', 'adapted'],
  ];
  const pairResults = pairs.map(([left, right]) => {
    let leftWins = 0;
    let rightWins = 0;
    let ties = 0;
    let comparable = 0;
    for (const entry of run.summary.paired) {
      if (!entry.comparable) continue;
      const leftDecisive = entry.decisive[left] ?? 0;
      const rightDecisive = entry.decisive[right] ?? 0;
      if (leftDecisive === 0 || rightDecisive === 0) continue;
      comparable += 1;
      const leftRate = (entry.pass[left] ?? 0) / leftDecisive;
      const rightRate = (entry.pass[right] ?? 0) / rightDecisive;
      if (Math.abs(leftRate - rightRate) < 1e-9) ties += 1;
      else if (leftRate > rightRate) leftWins += 1;
      else rightWins += 1;
    }
    return { left, right, leftWins, rightWins, ties, comparable };
  });
  const totalTasks = run.summary.paired.length;
  return (
    <section className="run-notes">
      <div>
        <p className="mono eyebrow">Run notes</p>
        <ul>
          {run.summary.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li className="muted">
            Adapter source: {run.provenance.adapterSource} · task set {run.provenance.taskSetVersion} · additional limit: output
            mapping is not supported.
          </li>
        </ul>
      </div>
      <div className="paired-block">
        <p className="mono eyebrow">Paired on the same tasks</p>
        <div className="paired-grid">
          {pairResults.map((pair) => (
            <div className="paired-card" key={`${pair.left}-${pair.right}`}>
              <div className="paired-title mono">
                {CONDITION_LABEL[pair.left]} <span className="muted">vs</span> {CONDITION_LABEL[pair.right]}
              </div>
              {pair.comparable > 0 ? (
                <p className="paired-line">
                  <strong>{pair.leftWins}</strong> {CONDITION_LABEL[pair.left].toLowerCase()} wins ?{' '}
                  <strong>{pair.rightWins}</strong> {CONDITION_LABEL[pair.right].toLowerCase()} wins ? <strong>{pair.ties}</strong> ties
                </p>
              ) : (
                <p className="paired-line muted">No decisive outcome in both conditions.</p>
              )}
              <p className="mono tiny muted">
                {pair.comparable}/{totalTasks} tasks comparable
              </p>
            </div>
          ))}
        </div>
        <p className="tiny muted">
          Per-task comparison of the same task ids; a task is comparable only when both conditions have a decisive pass or fail.
          Counts are descriptive. No significance test is applied.
        </p>
      </div>
      <dl className="run-facts">
        <div>
          <dt>Temperature</dt>
          <dd>{run.config.model.temperature}</dd>
        </div>
        <div>
          <dt>Trials per task</dt>
          <dd>{run.config.trialsPerTask}</dd>
        </div>
        <div>
          <dt>Conditions</dt>
          <dd>{run.config.conditions.map((condition) => CONDITION_LABEL[condition]).join(' · ')}</dd>
        </div>
        <div>
          <dt>Adapter hash</dt>
          <dd className="mono tiny" title={run.provenance.adapterHash ?? ''}>{shortHash(run.provenance.adapterHash)}</dd>
        </div>
        <div>
          <dt>Provider cost</dt>
          <dd>{run.provenance.providerReportedCostAvailable ? 'reported per attempt' : 'unknown'}</dd>
        </div>
        <div>
          <dt>Evidence class</dt>
          <dd>{run.provenance.evidenceClass === 'live-model' ? 'live model' : 'scripted simulation'}</dd>
        </div>
      </dl>
    </section>
  );
}