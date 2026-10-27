import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, shortHash } from '../api';
import { downloadHref, IS_REPLAY } from '../replay';
import type { AdapterIssue, DomainInfo, InterfaceResponse } from '../types';
import { Banner, CONDITION_LABEL, CONDITION_NOTE, JsonBlock, Spinner } from '../components';

interface AdapterToolShape {
  name: string;
  target: string;
  inputSchema: {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

interface AdapterShape {
  schema: string;
  domain: string;
  tools: AdapterToolShape[];
}

interface ValidationResponse {
  ok: boolean;
  issues?: AdapterIssue[];
  parseIssues?: AdapterIssue[];
  validation?: { ok: boolean; issues: AdapterIssue[]; toolCount: number; interfaceHash: string } | null;
  tools?: Array<{ name: string; target: string; summary: string[] }>;
}

interface PreviewResponse {
  ok: boolean;
  originalCall?: { tool: string | null; input: unknown } | null;
  lookupCall?: { tool: string; input: unknown; match: string[] } | null;
  notes?: string[];
  issues?: AdapterIssue[];
  inputErrors?: string[];
  executed?: boolean;
}

function parseAdapterText(text: string): { ok: true; spec: AdapterShape } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Adapter must be a JSON object.' };
    const spec = parsed as AdapterShape;
    if (!Array.isArray(spec.tools)) return { ok: false, error: 'Adapter needs a tools array.' };
    return { ok: true, spec };
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
}

function sampleValue(property: Record<string, unknown>): unknown {
  const enumValues = property.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const type = property.type;
  if (type === 'array') return [sampleValue((property.items ?? { type: 'string' }) as Record<string, unknown>)];
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    const props = (property.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, child] of Object.entries(props)) out[name] = sampleValue(child);
    return out;
  }
  if (type === 'boolean') return true;
  if (type === 'integer' || type === 'number') {
    return typeof property.minimum === 'number' ? property.minimum : 1;
  }
  if (typeof property.pattern === 'string' && property.pattern.includes('d{4}')) return '2026-11-02T09:00';
  if (property.format === 'email') return 'sam@acme.test';
  if (property.format === 'date-time') return '2026-11-02T09:00:00+05:30';
  return 'sample';
}

function sampleArgs(tool: AdapterToolShape | undefined): string {
  if (!tool) return '{}';
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
    out[name] = sampleValue(property);
  }
  return JSON.stringify(out, null, 2);
}

export function Interfaces({
  domains,
  domainId,
  onChangeDomain,
}: {
  domains: DomainInfo[];
  domainId: string;
  onChangeDomain: (id: string) => void;
}) {
  const [data, setData] = useState<InterfaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewTool, setPreviewTool] = useState('');
  const [previewArgs, setPreviewArgs] = useState('{}');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const load = async (id: string) => {
    setLoading(true);
    setError(null);
    setValidation(null);
    setPreview(null);
    try {
      const response = await api.get<InterfaceResponse>(`/api/interfaces?domain=${encodeURIComponent(id)}`);
      setData(response);
      const pretty = JSON.stringify(response.adapter.spec, null, 2);
      setText(pretty);
      const parsed = parseAdapterText(pretty);
      const firstTool = parsed.ok ? parsed.spec.tools[0] : undefined;
      setPreviewTool(firstTool?.name ?? '');
      setPreviewArgs(sampleArgs(firstTool));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(domainId);
  }, [domainId]);

  const parsedText = useMemo(() => parseAdapterText(text), [text]);
  const adapterTools = parsedText.ok ? parsedText.spec.tools : [];
  const selectedTool = adapterTools.find((tool) => tool.name === previewTool);

  const runValidation = async () => {
    setJsonError(null);
    setValidation(null);
    const parsed = parseAdapterText(text);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }
    try {
      const response = await api.post<ValidationResponse>('/api/adapters/validate', { domain: domainId, adapter: parsed.spec });
      setValidation(response);
      setNotice(response.ok ? 'Adapter is valid. It has not been saved or run.' : null);
    } catch (caught) {
      setJsonError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    }
  };

  const saveAdapter = async () => {
    setJsonError(null);
    setSaving(true);
    try {
      const parsed = parseAdapterText(text);
      if (!parsed.ok) {
        setJsonError(parsed.error);
        return;
      }
      const response = await api.post<{ ok: boolean; savedAt: string }>('/api/adapters', { domain: domainId, adapter: parsed.spec });
      setNotice(`Saved adapter to the local data directory at ${new Date(response.savedAt).toLocaleTimeString()}.`);
      await load(domainId);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const detail = caught.detail as { path?: string; message?: string }[] | null;
        setJsonError(
          detail && Array.isArray(detail)
            ? `${caught.message} ${detail.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`
            : caught.message,
        );
      } else {
        setJsonError((caught as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const resetAdapter = async () => {
    if (!window.confirm('Delete the saved adapter and restore the built-in default?')) return;
    setSaving(true);
    try {
      await api.delete(`/api/adapters/${domainId}`);
      setNotice('Saved adapter removed; the built-in default is active.');
      await load(domainId);
    } catch (caught) {
      setJsonError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setPreview(null);
    setPreviewError(null);
    setPreviewBusy(true);
    try {
      const parsed = parseAdapterText(text);
      if (!parsed.ok) {
        setPreviewError(parsed.error);
        return;
      }
      let args: unknown;
      try {
        args = JSON.parse(previewArgs);
      } catch (caught) {
        setPreviewError(`Preview arguments are not valid JSON: ${(caught as Error).message}`);
        return;
      }
      const response = await api.post<PreviewResponse>('/api/adapters/preview', {
        domain: domainId,
        adapter: parsed.spec,
        tool: previewTool,
        args,
      });
      setPreview(response);
    } catch (caught) {
      setPreviewError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  };

  const issues = [...(validation?.parseIssues ?? []), ...(validation?.validation?.issues ?? validation?.issues ?? [])];
  const errorIssues = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return (
    <div className="view">
      <div className="view-head">
        <p className="mono eyebrow">The experimental variable</p>
        <h2 className="view-title">Tool interfaces</h2>
        <p className="lede">
          The original tools are deliberately realistic and awkward. The descriptions condition changes documentation only, preserving names,
          schemas, executors and permissions. The adapted condition compiles bounded JSON mappings into one original call; a v2 lookup tool first makes one read-only exact-match search, and writes nothing unless exactly one record matches.
        </p>
      </div>

      <div className="domain-tabs interface-tabs" role="tablist" aria-label="Domain">
        {domains.map((domain) => (
          <button
            key={domain.id}
            type="button"
            role="tab"
            aria-selected={domain.id === domainId}
            className={domain.id === domainId ? 'domain-tab is-active' : 'domain-tab'}
            onClick={() => onChangeDomain(domain.id)}
          >
            <span>{domain.name}</span>
            <span className="mono domain-count">{domain.taskSetVersion}</span>
          </button>
        ))}
      </div>

      {error ? <Banner tone="danger" title="Could not load interfaces">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}
      {loading || !data ? <Spinner label="Loading interface catalogs" /> : null}

      {data ? (
        <>
          <section className="panel adapter-panel">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">Executable adapter</p>
                <h2>
                  {data.adapter.source === 'saved' ? 'Saved local adapter' : 'Built-in adapter'}
                  <span className={`chip chip-inline ${data.adapter.source === 'saved' ? 'chip-live' : ''}`}>{data.adapter.source}</span>
                </h2>
                <p className="muted small">
                  {data.adapter.savedAt ? `Saved ${new Date(data.adapter.savedAt).toLocaleString()}. ` : ''}
                  Adapter hash <span className="mono">{shortHash(data.adapter.validation.interfaceHash)}</span>.
                </p>
              </div>
              <div className="adapter-actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => void runValidation()}>
                  Validate
                </button>
                {!IS_REPLAY ? (
                  <button type="button" className="btn btn-primary btn-small" onClick={() => void saveAdapter()} disabled={saving}>
                    {saving ? 'Saving…' : 'Save adapter'}
                  </button>
                ) : null}
                <button type="button" className="btn btn-ghost btn-small" onClick={() => importInput.current?.click()}>
                  Import JSON
                </button>
                <input
                  ref={importInput}
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  aria-label="Import adapter JSON file"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const content = await file.text();
                      setText(content);
                      setValidation(null);
                      setJsonError(null);
                      setNotice(`Imported ${file.name}. Validate it before saving or running.`);
                    } catch (caught) {
                      setJsonError(`Could not read ${file.name}: ${(caught as Error).message}`);
                    } finally {
                      event.target.value = '';
                    }
                  }}
                />
                {!IS_REPLAY ? (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => void resetAdapter()} disabled={saving}>
                    Reset to default
                  </button>
                ) : null}
              </div>
            </div>

            <div className="adapter-layout">
              <div className="adapter-editor">
                <label className="field-label mono" htmlFor="adapter-json">Adapter specification · anvil.adapter/v1 or v2</label>
                <textarea
                  id="adapter-json"
                  className="json-editor mono"
                  value={text}
                  spellCheck={false}
                  onChange={(event) => {
                    setText(event.target.value);
                    setValidation(null);
                  }}
                  rows={22}
                />
                <p className="tiny muted">
                  Only declared input mappings are supported. Compiled calls are validated against the original JSON Schema before execution.
                  No JavaScript, shell, eval or validator access exists.
                </p>
                {jsonError ? <Banner tone="danger" title="Adapter problem">{jsonError}</Banner> : null}
                {validation ? (
                  <div className="validation-summary" role="status">
                    <div className="validation-head">
                      <strong className={validation.ok ? 'ok-text' : 'err-text'}>
                        {validation.ok ? 'Valid adapter' : 'Adapter has errors'}
                      </strong>
                      <span className="mono tiny muted">
                        {validation.validation?.toolCount ?? adapterTools.length} tools · {errorIssues.length} errors · {warnings.length} warnings
                      </span>
                    </div>
                    {errorIssues.length === 0 && warnings.length === 0 ? (
                      <p className="small">All mappings compile a sample call and satisfy the target schemas.</p>
                    ) : null}
                    <ul className="issue-list">
                      {issues.map((issue, index) => (
                        <li key={`${issue.path}-${index}`} className={issue.severity === 'error' ? 'issue is-error' : 'issue is-warning'}>
                          <span className="mono tiny">{issue.path}</span>
                          <span>{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <aside className="adapter-side">
                <div>
                  <p className="mono eyebrow">Declared limits</p>
                  <ul className="limit-list">
                    {data.adapter.limits.map((limit) => (
                      <li key={limit}>{limit}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mono eyebrow">Export</p>
                  <div className="export-links">
                    <a className="btn btn-secondary btn-small" href={downloadHref(`/api/export/adapter?domain=${domainId}&kind=bundle`)} download>
                      Adapter bundle
                    </a>
                    <a className="btn btn-ghost btn-small" href={downloadHref(`/api/export/adapter?domain=${domainId}&kind=spec`)} download>
                      Spec only
                    </a>
                    <a className="btn btn-ghost btn-small" href={downloadHref(`/api/export/adapter?domain=${domainId}&kind=mcp-config`)} download>
                      MCP config
                    </a>
                  </div>
                  <p className="tiny muted">
                    Downloads are served by the local API with a JSON MIME type and filename. The bundle includes provenance, limits and a
                    runnable stdio command template.
                  </p>
                </div>
              </aside>
            </div>
          </section>

          <section className="panel preview-panel">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">Mapping preview</p>
                <h2>Compile without executing</h2>
              </div>
              <span className="mono muted small">no write</span>
            </div>
            <div className="preview-layout">
              <div>
                <label className="field-label mono" htmlFor="preview-tool">Adapted tool</label>
                <select
                  id="preview-tool"
                  className="input"
                  value={previewTool}
                  onChange={(event) => {
                    const next = adapterTools.find((tool) => tool.name === event.target.value);
                    setPreviewTool(event.target.value);
                    setPreviewArgs(sampleArgs(next));
                    setPreview(null);
                  }}
                >
                  {adapterTools.map((tool) => (
                    <option key={tool.name} value={tool.name}>{tool.name} → {tool.target}</option>
                  ))}
                </select>
                <label className="field-label mono" htmlFor="preview-args">Adapted arguments</label>
                <textarea
                  id="preview-args"
                  className="json-editor mono"
                  rows={10}
                  value={previewArgs}
                  spellCheck={false}
                  onChange={(event) => setPreviewArgs(event.target.value)}
                />
                <button type="button" className="btn btn-secondary" onClick={() => void runPreview()} disabled={previewBusy || !selectedTool}>
                  {previewBusy ? 'Compiling…' : 'Preview compiled call'}
                </button>
                {previewError ? <Banner tone="danger">{previewError}</Banner> : null}
              </div>
              <div className="preview-result" aria-live="polite">
                {preview ? (
                  <>
                    <div className="preview-status">
                      <strong className={preview.ok ? 'ok-text' : 'err-text'}>{preview.ok ? 'Compiles' : 'Does not compile'}</strong>
                      <span className="mono tiny muted">Not executed</span>
                    </div>
                    {preview.inputErrors?.length ? (
                      <Banner tone="danger" title="Adapted arguments invalid">
                        {preview.inputErrors.join('; ')}
                      </Banner>
                    ) : null}
                    {preview.lookupCall ? (
                      <>
                        <div className="section-label mono">Step 1 · read-only lookup · {preview.lookupCall.tool}</div>
                        <JsonBlock value={preview.lookupCall.input} maxHeight={200} />
                        <ul className="transform-notes mono tiny">
                          <li>Requires exactly one item where {preview.lookupCall.match.join(' and ')}</li>
                          <li>Zero or several matches: no write, candidates returned to the model</li>
                        </ul>
                      </>
                    ) : null}
                    {preview.originalCall ? (
                      <>
                        <div className="section-label mono">{preview.lookupCall ? 'Step 2 · ' : ''}Original call · {preview.originalCall.tool}</div>
                        <JsonBlock value={preview.originalCall.input} maxHeight={260} />
                      </>
                    ) : null}
                    {preview.notes?.length ? (
                      <ul className="transform-notes mono tiny">
                        {preview.notes.map((note) => <li key={note}>{note}</li>)}
                      </ul>
                    ) : null}
                    {preview.issues?.length ? (
                      <ul className="issue-list">
                        {preview.issues.map((issue, index) => (
                          <li key={`${issue.path}-${index}`} className="issue is-error">
                            <span className="mono tiny">{issue.path}</span>
                            <span>{issue.message}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : (
                  <p className="muted small">
                    Choose a tool, edit arguments, and compile. This shows the exact original call Anvil would run. It does not touch fixture
                    state.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="schema-section">
            <div className="panel-head">
              <div>
                <p className="mono eyebrow">Exact schemas</p>
                <h2>Three interfaces, one executor</h2>
              </div>
              <p className="muted small schema-note">
                Descriptions differ; schema equivalence is checked after stripping documentation fields. Adapted tools are public wrappers,
                not a second executor.
              </p>
            </div>
            <div className="schema-grid">
              {data.conditions.map((condition) => (
                <div className={`schema-column schema-${condition.condition}`} key={condition.condition}>
                  <header className="schema-head">
                    <div>
                      <p className="mono eyebrow">{condition.condition === 'adapted' ? 'Executable adapter' : 'Direct tools'}</p>
                      <h3>{CONDITION_LABEL[condition.condition]}</h3>
                    </div>
                    <span className="mono hash" title={condition.hash}>{shortHash(condition.hash)}</span>
                  </header>
                  <p className="condition-note">{CONDITION_NOTE[condition.condition]}</p>
                  <ul className="limit-list compact">
                    {condition.limits.map((limit) => <li key={limit}>{limit}</li>)}
                  </ul>
                  <div className="schema-tools">
                    {condition.tools.map((tool) => (
                      <details className="schema-tool" key={tool.name}>
                        <summary>
                          <span className="mono tool-name">{tool.name}</span>
                          <span className="mono tiny muted">
                            {Object.keys(tool.inputSchema.properties ?? {}).length} fields
                          </span>
                        </summary>
                        <p className="schema-description">{tool.description}</p>
                        <p className="mono tiny muted">{tool.permissions.map((permission) => permission.scope).join(' · ') || 'no external permission'}</p>
                        <JsonBlock value={tool.inputSchema} label="input schema" maxHeight={360} />
                        <p className="tiny muted">Output: {tool.outputDescription}</p>
                      </details>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}