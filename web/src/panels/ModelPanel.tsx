import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { ModelStatus } from '../types';
import { Banner, Modal } from '../components';

const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';
const OLLAMA_MODEL = 'qwen2.5:7b';

export function ModelPanel({
  open,
  status,
  onClose,
  onSaved,
}: {
  open: boolean;
  status: ModelStatus | null;
  onClose: () => void;
  onSaved: (status: ModelStatus) => void;
}) {
  const [provider, setProvider] = useState<'ollama' | 'openai-compatible'>('ollama');
  const [baseUrl, setBaseUrl] = useState(OLLAMA_BASE);
  const [modelName, setModelName] = useState(OLLAMA_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [temperature, setTemperature] = useState('0');
  const [maxTokens, setMaxTokens] = useState('900');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ modelCount: number; models: string[]; latencyMs: number } | null>(null);
  const [savedStatus, setSavedStatus] = useState<ModelStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider(status?.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama');
    setBaseUrl(status?.baseUrl ?? OLLAMA_BASE);
    setModelName(status?.model ?? OLLAMA_MODEL);
    setApiKey('');
    setTemperature('0');
    setMaxTokens('900');
    setError(null);
    setNotice(null);
    setTestResult(null);
    setSavedStatus(status);
    // The panel intentionally refreshes only when it opens; saving updates local state without clearing the inline result.
  }, [open]);

  const save = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const response = await api.post<{ status: ModelStatus }>('/api/config/model', {
        provider,
        baseUrl: baseUrl.trim(),
        model: modelName.trim(),
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
        temperature: Number(temperature),
        maxTokensPerCompletion: Number(maxTokens),
      });
      setSavedStatus(response.status);
      setApiKey('');
      setNotice('Model configuration saved in the server process memory. The API key was not written to disk.');
      onSaved(response.status);
      setTestResult(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const response = await api.post<{ modelCount: number; models: string[]; latencyMs: number }>('/api/config/test');
      setTestResult(response);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    setError(null);
    try {
      const response = await api.delete<{ status: ModelStatus }>('/api/config/model');
      setSavedStatus(response.status);
      setTestResult(null);
      setNotice('Model configuration cleared from this process.');
      onSaved(response.status);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    }
  };

  return (
    <Modal
      open={open}
      title="Model and endpoint"
      subtitle="One open model, identical across all three conditions. Keys stay in this server process."
      onClose={onClose}
      width={720}
    >
      <div className="form-grid">
        <div className="field">
          <label className="field-label mono" htmlFor="provider">Provider</label>
          <select
            id="provider"
            className="input"
            value={provider}
            onChange={(event) => {
              const next = event.target.value as 'ollama' | 'openai-compatible';
              setProvider(next);
              if (next === 'ollama') {
                setBaseUrl(OLLAMA_BASE);
                setModelName((current) => (current === 'sample-model' ? OLLAMA_MODEL : current));
              }
            }}
          >
            <option value="ollama">Local Ollama (OpenAI-compatible /v1)</option>
            <option value="openai-compatible">User-supplied OpenAI-compatible endpoint</option>
          </select>
          <p className="field-hint">
            {provider === 'ollama'
              ? 'Uses the local Ollama server. A local model must already be installed; Anvil does not download one.'
              : 'Anvil never falls back to a proprietary provider. The key is sent only to the endpoint you configure.'}
          </p>
        </div>

        <div className="field">
          <label className="field-label mono" htmlFor="base-url">Base URL</label>
          <input
            id="base-url"
            className="input mono"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            autoComplete="off"
          />
          <p className="field-hint">The transport appends <span className="mono">/chat/completions</span> and <span className="mono">/models</span>.</p>
        </div>

        <div className="field">
          <label className="field-label mono" htmlFor="model-id">Model id</label>
          <input
            id="model-id"
            className="input mono"
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            placeholder="qwen2.5:7b"
            autoComplete="off"
          />
          <p className="field-hint">This exact id is recorded as requested. The provider-reported id is recorded separately when available.</p>
        </div>

        <div className="field">
          <label className="field-label mono" htmlFor="api-key">API key · optional for local endpoints</label>
          <input
            id="api-key"
            className="input mono"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={savedStatus?.keyInMemory ? 'A key is already held in memory; leave blank to keep it' : 'Not stored'}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="field-hint">
            Kept in server memory only. Never written to <span className="mono">.anvil/</span>, runs, logs or exports. The browser never
            persists it in localStorage.
          </p>
        </div>

        <div className="field-row">
          <div className="field">
            <label className="field-label mono" htmlFor="temperature">Temperature</label>
            <input
              id="temperature"
              className="input mono"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label mono" htmlFor="max-tokens">Max tokens / completion</label>
            <input
              id="max-tokens"
              className="input mono"
              type="number"
              min="32"
              max="16000"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </div>
        </div>
      </div>

      {error ? <Banner tone="danger" title="Model configuration failed">{error}</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      <div className="panel-status-line">
        <span className={`chip ${savedStatus?.configured ? 'chip-live' : 'chip-sim'}`}>
          {savedStatus?.configured ? 'Configured in memory' : 'Not configured'}
        </span>
        {savedStatus?.configured ? (
          <span className="mono tiny muted">
            {savedStatus.model} · {savedStatus.baseUrl} · key {savedStatus.keyInMemory ? 'held in memory' : 'not set'}
          </span>
        ) : (
          <span className="mono tiny muted">Simulation is always available; live runs require this step.</span>
        )}
      </div>

      {testResult ? (
        <div className="model-test-result">
          <div className="validation-head">
            <strong className="ok-text">Endpoint reachable</strong>
            <span className="mono tiny muted">{testResult.modelCount} models · {testResult.latencyMs} ms</span>
          </div>
          <ul className="tool-chip-list">
            {testResult.models.slice(0, 12).map((id) => (
              <li key={id} className="chip chip-tool mono">{id}</li>
            ))}
            {testResult.models.length > 12 ? <li className="chip mono">+{testResult.models.length - 12} more</li> : null}
          </ul>
          <p className="tiny muted">Listing models does not run a completion or spend tokens.</p>
        </div>
      ) : null}

      <footer className="modal-foot">
        <div className="foot-left">
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void clear()} disabled={!savedStatus?.configured}>
            Clear configuration
          </button>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void test()} disabled={!savedStatus?.configured || testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        <div className="foot-right">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save configuration'}
          </button>
        </div>
      </footer>
    </Modal>
  );
}