import { useState } from 'react';
import type { RunListItem } from '../types';
import { Banner, StatusWord } from '../components';
import { formatTime } from '../api';

type Filter = 'all' | 'live' | 'simulation';

export function Experiments({
  runs,
  onOpen,
  onRefresh,
}: {
  runs: RunListItem[];
  onOpen: (run: RunListItem) => Promise<void>;
  onRefresh: () => Promise<RunListItem[]>;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const visible = runs.filter((run) => (filter === 'all' ? true : run.mode === filter));

  return (
    <div className="view">
      <div className="view-head">
        <p className="mono eyebrow">Saved evidence</p>
        <h2 className="view-title">Experiments</h2>
        <p className="lede">
          Every attempt is persisted, including failures, invalid attempts, provider errors and cancellations. A saved run is a replay,
          not a new model call. A simulation is a scripted rehearsal, never a live benchmark.
        </p>
      </div>

      <div className="filter-row">
        <div className="segmented" role="group" aria-label="Filter by evidence type">
          {(['all', 'live', 'simulation'] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'seg-btn is-active' : 'seg-btn'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? `All (${runs.length})` : value === 'live' ? `Live (${runs.filter((run) => run.mode === 'live').length})` : `Simulation (${runs.filter((run) => run.mode === 'simulation').length})`}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRefresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {runs.length === 0 ? (
        <section className="panel empty-panel">
          <p className="mono eyebrow">No runs</p>
          <h2>Nothing has been measured yet.</h2>
          <p>
            Start from the Workbench. The server persists completed attempts immediately and marks an unfinished run as interrupted after
            a restart.
          </p>
        </section>
      ) : visible.length === 0 ? (
        <section className="panel empty-panel">
          <p className="mono eyebrow">Filtered</p>
          <p>No {filter} runs are saved.</p>
        </section>
      ) : (
        <>
          {filter === 'simulation' ? (
            <Banner tone="warning" title="Simulation filter">
              These runs used the deterministic scripted policy. They validate the harness and interface mapping only. Do not read them as
              model performance.
            </Banner>
          ) : null}
          <section className="panel">
            <div className="table-scroll">
              <table className="data-table runs-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Evidence</th>
                    <th>Status</th>
                    <th>Model</th>
                    <th>Attempts</th>
                    <th>Outcomes</th>
                    <th>Created</th>
                    <th><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <span className="run-id mono">{run.id}</span>
                        <span className="cell-sub mono">
                          {run.domain} · {run.split}
                        </span>
                      </td>
                      <td>
                        <span className={`chip ${run.mode === 'simulation' ? 'chip-sim' : 'chip-live'}`}>
                          {run.mode === 'simulation' ? 'Simulation' : 'Live model'}
                        </span>
                      </td>
                      <td><StatusWord status={run.status} /></td>
                      <td className="mono small">{run.model}</td>
                      <td>{run.attempts}</td>
                      <td>
                        <span className="outcome-line mono tiny">
                          <span className="ok-text">{run.pass} pass</span>
                          <span className="err-text">{run.fail} fail</span>
                          <span>{run.invalid} invalid</span>
                          <span>{run.error} error</span>
                          <span>{run.canceled} canceled</span>
                        </span>
                      </td>
                      <td className="mono small">{formatTime(run.createdAt)}</td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-small" onClick={() => void onOpen(run)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="run-notes">
        <div>
          <p className="mono eyebrow">Reading a run</p>
          <ul>
            <li>Pass and fail are decisive verdicts from independent state assertions.</li>
            <li>Invalid means no verdict was possible, for example budget exhaustion or malformed model output.</li>
            <li>Error means a provider, runtime or validator error; canceled means the operator stopped it.</li>
            <li>Provider-reported cost stays unknown when the provider does not report it. Estimated cost is not invented.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}