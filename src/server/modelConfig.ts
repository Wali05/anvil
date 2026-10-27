import type { ModelConfig, ModelStatus } from '../core/types.js';
import { AnvilError } from '../core/errors.js';
import { DEFAULT_MODEL } from '../core/runner.js';

export interface ConfigureModelInput {
  provider?: 'ollama' | 'openai-compatible';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokensPerCompletion?: number;
}

/**
 * Process-memory model configuration. The API key is intentionally never
 * written to disk, logged, or included in a run record or export.
 */
export class ModelConfigManager {
  private config: ModelConfig = { ...DEFAULT_MODEL };
  private configured = false;

  configure(input: ConfigureModelInput): ModelStatus {
    const provider = input.provider ?? 'ollama';
    if (provider !== 'ollama' && provider !== 'openai-compatible') {
      throw new AnvilError('invalid_provider', 'provider must be "ollama" or "openai-compatible".');
    }
    const baseUrl = (input.baseUrl ?? (provider === 'ollama' ? DEFAULT_MODEL.baseUrl : '')).trim().replace(/\/+$/, '');
    if (!baseUrl) throw new AnvilError('missing_base_url', 'An endpoint base URL is required.');
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new AnvilError('invalid_base_url', 'baseUrl must be an absolute http(s) URL.');
    }
    const model = (input.model ?? '').trim();
    if (!model) throw new AnvilError('missing_model', 'Choose a model id.');
    if (model.length > 200) throw new AnvilError('invalid_model', 'model id is too long.');
    const temperature = input.temperature ?? 0;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new AnvilError('invalid_temperature', 'temperature must be between 0 and 2.');
    }
    const maxTokens = input.maxTokensPerCompletion ?? DEFAULT_MODEL.maxTokensPerCompletion;
    if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 16_000) {
      throw new AnvilError('invalid_max_tokens', 'maxTokensPerCompletion must be an integer between 32 and 16000.');
    }
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
      throw new AnvilError('invalid_api_key', 'apiKey must be a string.');
    }
    this.config = {
      provider,
      baseUrl,
      model,
      temperature,
      maxTokensPerCompletion: maxTokens,
      ...(input.apiKey && input.apiKey.trim().length > 0 ? { apiKey: input.apiKey.trim() } : {}),
    };
    this.configured = true;
    return this.status();
  }

  /** Explicit opt-in configuration from the process environment (MCP/CLI use). */
  applyEnvironment(env: NodeJS.ProcessEnv): boolean {
    const provider = env.ANVIL_MODEL_PROVIDER;
    const baseUrl = env.ANVIL_MODEL_BASE_URL;
    const model = env.ANVIL_MODEL;
    if (!provider && !baseUrl && !model) return false;
    try {
      this.configure({
        provider: provider === 'openai-compatible' ? 'openai-compatible' : 'ollama',
        baseUrl: baseUrl ?? DEFAULT_MODEL.baseUrl,
        model: model ?? DEFAULT_MODEL.model,
        apiKey: env.ANVIL_MODEL_API_KEY,
        temperature: 0,
        maxTokensPerCompletion: DEFAULT_MODEL.maxTokensPerCompletion,
      });
      return true;
    } catch {
      return false;
    }
  }

  clear(): ModelStatus {
    this.config = { ...DEFAULT_MODEL };
    this.configured = false;
    return this.status();
  }

  isConfigured(): boolean {
    return this.configured;
  }

  get(): ModelConfig {
    return { ...this.config };
  }

  requireConfigured(): ModelConfig {
    if (!this.configured) {
      throw new AnvilError('model_not_configured', 'Configure a local Ollama model or an OpenAI-compatible endpoint before a live run.');
    }
    return this.get();
  }

  status(): ModelStatus {
    return {
      configured: this.configured,
      provider: this.configured ? this.config.provider : null,
      baseUrl: this.configured ? this.config.baseUrl : null,
      model: this.configured ? this.config.model : null,
      keyInMemory: Boolean(this.config.apiKey),
      keyPersisted: false,
    };
  }
}