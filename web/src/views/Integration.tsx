import { useEffect, useState } from 'react';
import { api, ApiError, formatTime } from '../api';
import type { IntegrationInfo, McpCheck, ModelStatus } from '../types';
import { Banner, CopyButton, JsonBlock, Spinner } from '../components';

export function Integration({ model }: { model: ModelStatus | null }) {
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<McpCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkAt, setCheckAt] = useState<string | null>(null);

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

  return (
    <div className="view">
      <div className="view-head">
        <p className="mono eyebrow">Real status, no placeholders presented as live</p>
        <h2 className="view-title">Integration</h2>
        <p className="lede">
          Anvil ships a genuine MCP executor and workbench interface over local stdio. Alan desktop runs custom stdio MCP connectors, so
          the adapted tools can be added to Alan with an npx command. There is no hosted HTTPS endpoint.
        </p>
      </div>

      {error ? <Banner tone="danger" title="Could not load integration status">{error}</Banner> : null}
      {!info && !error ? <Spinner label="Loading integration status" /> : null}

      {info ? (
        <>
          <div className="integration-grid">
            <section className="panel integration-card">
              <div className="panel-head">
                <div>
                  <p className="mono eyebrow">Local MCP</p>
                  <h2>Adapter executor</h2>
                </div>
                <span className={`chip ${info.local.cliBuilt ? 'chip-live' : 'chip-sim'}`}>
                  {info.local.cliBuilt ? 'CLI built' : 'Build required'}
                </span>
              </div>
              <p>
                The packaged MCP server exposes the selected domain interface over stdio. Adapted calls are compiled, validated and executed by
                the same fixture executor used in experiments. Tool calls are logged to stderr, never mixed with MCP protocol on stdout.
              </p>
              <div className="command-block">
                <div className="command-head">
                  <span className="mono tiny muted">Workbench MCP</span>
                  <CopyButton text={info.local.workbenchCommand} compact />
                </div>
                <code className="mono command">{info.local.workbenchCommand}</code>
              </div>
              <div className="command-block">
                <div className="command-head">
                  <span className="mono tiny muted">Calendar adapted executor</span>
                  <CopyButton text={info.local.calendarAdapterCommand} compact />
                </div>
                <code className="mono command">{info.local.calendarAdapterCommand}</code>
              </div>
              <div className="command-block">
                <div className="command-head">
                  <span className="mono tiny muted">Issues adapted executor</span>
                  <CopyButton text={info.local.issuesAdapterCommand} compact />
                </div>
                <code className="mono command">{info.local.issuesAdapterCommand}</code>
              </div>
              <div className="command-block">
                <div className="command-head">
                  <span className="mono tiny muted">Exported bundle executor</span>
                  <CopyButton text={info.local.fileAdapterCommand} compact />
                </div>
                <code className="mono command">{info.local.fileAdapterCommand}</code>
              </div>
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
                  <p className="mono eyebrow">Alan marketplace</p>
                  <h2>Plugin package</h2>
                </div>
                <span className="chip chip-sim">Not installed</span>
              </div>
              <p>
                The repository includes a plugin manifest, `mcp.json`, marketplace entry and a workbench skill. `mcp.json` launches the stdio
                adapter server with npx. A file on disk is not an installed integration.
              </p>
              <dl className="meta-grid compact-grid">
                <div>
                  <dt>Manifest</dt>
                  <dd className="mono tiny">{info.plugin.manifestPath}</dd>
                </div>
                <div>
                  <dt>Manifest present</dt>
                  <dd>{info.plugin.manifestPresent ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt>Installed in Alan</dt>
                  <dd>no</dd>
                </div>
                <div>
                  <dt>Transport</dt>
                  <dd className="mono">stdio (custom connector)</dd>
                </div>
                <div>
                  <dt>Hosted endpoint</dt>
                  <dd className="mono tiny">none</dd>
                </div>
              </dl>
              <div className="pending-remote">
                <span className="mono tiny">Alan desktop · custom connector · macOS / Linux</span>
                <code className="mono">Command: npx · Args: -y -p github:Wali05/anvil anvil-mcp --domain calendar</code>
                <span className="mono tiny">Windows</span>
                <code className="mono">Command: cmd · Args: /c npx -y -p github:Wali05/anvil anvil-mcp --domain calendar</code>
                <p className="small">
                  Add a second connector with <code>--domain issues</code> for the issue tracker. The <code>github:</code> package spec resolves once the
                  repository is public; until then, point the command at a local checkout (<code>node bin/anvil-mcp.mjs --domain calendar</code>).
                </p>
              </div>
              <p className="small muted">A run of these tools inside Alan has not been recorded yet.</p>
              {info.plugin.manifest ? (
                <details>
                  <summary className="mono small">Plugin manifest</summary>
                  <JsonBlock value={info.plugin.manifest} maxHeight={320} />
                </details>
              ) : null}
            </section>

            <section className="panel integration-card">
              <div className="panel-head">
                <div>
                  <p className="mono eyebrow">Model transport</p>
                  <h2>Open-model configuration</h2>
                </div>
                <span className={`chip ${model?.configured ? 'chip-live' : 'chip-sim'}`}>
                  {model?.configured ? 'Configured in memory' : 'Not configured'}
                </span>
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
                Only user-supplied OpenAI-compatible endpoints or an installed local Ollama model are used. Anvil does not fall back to a
                proprietary provider, scrape Alan authentication or assume an undocumented inference API.
              </p>
            </section>

            <section className="panel integration-card">
              <div className="panel-head">
                <div>
                  <p className="mono eyebrow">Boundaries</p>
                  <h2>What is and is not proven</h2>
                </div>
              </div>
              <ul className="limit-list">
                <li>Fixture execution is real; compatibility with production Google Calendar or GitHub APIs is not claimed.</li>
                <li>No hosted MCP endpoint, no recorded run inside Alan and no real-user adoption exist yet.</li>
                <li>Simulation results are rehearsals. Live uplift remains unmeasured until a sanctioned model run is recorded.</li>
                <li>Protocol interoperability is verified only by the MCP handshake and tool calls run from this checkout.</li>
                <li>Proxying Alan's own OAuth-backed connectors may require credentials held by Alan; Anvil does not attempt to extract them.</li>
              </ul>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}