import { useEffect, useState } from 'react';
import { api, ApiError, formatTime } from '../api';
import type { IntegrationInfo, McpCheck, ModelStatus } from '../types';
import { Banner, CopyButton, Spinner } from '../components';

function Command({ label, text }: { label: string; text: string }) {
  return (
    <div className="command-block">
      <div className="command-head">
        <span className="mono tiny muted">{label}</span>
        <CopyButton text={text} compact />
      </div>
      <code className="mono command">{text}</code>
    </div>
  );
}

export function Integration({ model }: { model: ModelStatus | null }) {
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<McpCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkAt, setCheckAt] = useState<string | null>(null);
  const [clientId, setClientId] = useState('claude-code');

  useEffect(() => {
    void (async () => {
      try {
        const response = await api.get<IntegrationInfo>('/api/integration');
        setInfo(response);
        if (response.lastCheck?.ok !== undefined) {
          setCheck(response.lastCheck as unknown as McpCheck);
          setCheckAt(response.lastCheck.at ?? null);
        }
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }, []);

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    setCheck(null);
    try {
      const response = await api.post<{ ok: boolean; result: McpCheck }>('/api/integration/check');
      setCheck(response.result);
      setCheckAt(new Date().toISOString());
      if (!response.result.ok) setCheckError(response.result.error);
    } catch (caught) {
      setCheckError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const client = info?.clients.find((entry) => entry.id === clientId) ?? info?.clients[0];

  return (
    <div className="view">
      <div className="view-head">
        <p className="mono eyebrow">Any MCP client, any MCP server</p>
        <h2 className="view-title">Integration</h2>
        <p className="lede">
          Anvil is a standard MCP server. Your client launches it over stdio (or you start it with <code>--http</code>), and it either serves
          the built-in fixtures or sits in front of your own MCP server as a proxy that adapts, filters and logs its tools.
        </p>
      </div>

      {error ? <Banner tone="danger" title="Could not load integration status">{error}</Banner> : null}
      {!info && !error ? <Spinner label="Loading integration status" /> : null}

      {info ? (
        <div className="integration-grid">
          <section className="panel integration-card">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">Your own tools</p>
                <h2>Put Anvil in front of an MCP server</h2>
              </div>
            </div>
            <ol className="step-list">
              <li>
                <strong>Inspect</strong> the server&apos;s tools for patterns that make models fail: deep nesting, undocumented limits, opaque
                ids on writes, free-text query dialects, missing date formats, oversized catalogs.
              </li>
              <li>
                <strong>Scaffold</strong> a starter adapter that flattens nested inputs, then edit it: friendlier names, enum maps, date
                transforms, a lookup that finds a record by name instead of asking the model for its id.
              </li>
              <li>
                <strong>Proxy</strong> the server through the adapter. Adapted tools replace the originals they call; the rest pass through,
                filtered and re-described. Every call is logged as the original call it compiled to.
              </li>
            </ol>
            <Command label="1 · inspect" text={info.local.inspectCommand} />
            <Command label="2 · scaffold" text={info.local.scaffoldCommand} />
            <Command label="3 · proxy" text={info.local.proxyCommand} />
            <p className="small muted">
              Upstreams can be a command (stdio) or a URL (<code>--url https://…/mcp</code>, Streamable HTTP with SSE fallback). Reference tokens as{' '}
              <code>{'${VAR}'}</code> in headers and configs; they are read from the environment and never logged. <code>anvil report calls.jsonl</code>{' '}
              summarizes which tools fail and why.
            </p>
          </section>

          <section className="panel integration-card">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">Client setup</p>
                <h2>Add the calendar fixture to your client</h2>
              </div>
            </div>
            <div className="client-tabs" role="group" aria-label="MCP client">
              {info.clients.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={entry.id === client?.id ? 'seg-btn is-active' : 'seg-btn'}
                  aria-pressed={entry.id === client?.id}
                  onClick={() => setClientId(entry.id)}
                >
                  {entry.client}
                </button>
              ))}
            </div>
            {client ? (
              <>
                <Command label={client.where} text={client.snippet} />
                {client.note ? <p className="small muted">{client.note}</p> : null}
              </>
            ) : null}
            <p className="small muted">
              Nothing to clone: npm installs and builds <code>{info.npx.package}</code> on first start (about 30 s). Use <code>--domain issues</code>{' '}
              for the issue tracker. For a proxy, swap the args for <code>anvil proxy …</code>, e.g.{' '}
              <code>{[info.npx.proxyExample.command, ...info.npx.proxyExample.args].join(' ')}</code>.
            </p>
            <p className="small muted">{info.transports.streamableHttp}.</p>
          </section>

          <section className="panel integration-card">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">This checkout</p>
                <h2>Local MCP servers</h2>
              </div>
              <span className={`chip ${info.local.cliBuilt ? 'chip-live' : 'chip-sim'}`}>{info.local.cliBuilt ? 'CLI built' : 'Build required'}</span>
            </div>
            <p>
              The fixture servers expose one domain interface. Adapted calls are compiled, validated and executed by the same fixture executor used
              in experiments, and logged to stderr, never mixed with protocol output on stdout.
            </p>
            <Command label="Workbench MCP" text={info.local.workbenchCommand} />
            <Command label="Calendar adapted executor" text={info.local.calendarAdapterCommand} />
            <Command label="Issues adapted executor" text={info.local.issuesAdapterCommand} />
            <Command label="Exported bundle executor" text={info.local.fileAdapterCommand} />
            <p className="small muted">{info.local.compatibleWith}</p>
            <div className="check-zone">
              <button type="button" className="btn btn-primary btn-small" onClick={() => void runCheck()} disabled={checking || !info.local.cliBuilt}>
                {checking ? 'Running handshake…' : 'Run MCP handshake'}
              </button>
              {!info.local.cliBuilt ? <span className="mono tiny muted">Run npm run build first.</span> : null}
              <span className="mono tiny muted">{checkAt ? `Last checked ${formatTime(checkAt)}` : 'Not checked yet'}</span>
            </div>
            {checkError ? <Banner tone="danger" title="MCP handshake failed">{checkError}</Banner> : null}
            {check?.ok ? (
              <div className="mcp-result">
                <div className="mcp-result-head">
                  <strong className="ok-text">Handshake succeeded</strong>
                  <span className="mono tiny muted">
                    {check.serverName} {check.serverVersion} · {check.latencyMs} ms
                  </span>
                </div>
                <ul className="tool-chip-list">
                  {check.tools.map((tool) => (
                    <li key={tool.name} className="chip chip-tool">{tool.name}</li>
                  ))}
                </ul>
                <p className="tiny muted">Client listed {check.tools.length} tools and invoked anvil_list_domains.</p>
                {check.stderrTail ? (
                  <details>
                    <summary className="mono tiny">Server stderr tail</summary>
                    <pre className="json mono" tabIndex={0}>{check.stderrTail}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="panel integration-card">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">Model transport</p>
                <h2>Experiment model</h2>
              </div>
              <span className={`chip ${model?.configured ? 'chip-live' : 'chip-sim'}`}>{model?.configured ? 'Configured in memory' : 'Not configured'}</span>
            </div>
            <dl className="meta-grid compact-grid">
              <div>
                <dt>Provider</dt>
                <dd className="mono">{model?.provider ?? '—'}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd className="mono">{model?.model ?? '—'}</dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd className="mono tiny">{model?.baseUrl ?? '—'}</dd>
              </div>
              <div>
                <dt>Key in process memory</dt>
                <dd>{model?.keyInMemory ? 'yes' : 'no'}</dd>
              </div>
              <div>
                <dt>Key persisted</dt>
                <dd>never</dd>
              </div>
            </dl>
            <p className="small muted">
              Experiments call only the endpoint you configure: any OpenAI-compatible API (OpenRouter, Together, Groq, vLLM, LM Studio, a hosted
              provider) or a local Ollama model. The proxy itself never calls a model.
            </p>
            <h3 className="small">Boundaries</h3>
            <ul className="limit-list compact">
              <li>Fixture runs are real tool executions against local, resettable data, not Google Calendar or GitHub.</li>
              <li>The proxy maps inputs only; upstream outputs are returned unchanged.</li>
              <li>Simulation results are rehearsals with a scripted policy and are never counted as model evidence.</li>
              <li>{info.deployment.note}</li>
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}
