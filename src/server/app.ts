import express, { type Express, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { AdapterSpec, ConditionId, RunRecord, Split } from '../core/types.js';
import { CONDITIONS } from '../core/types.js';
import { AnvilError, errorMessage } from '../core/errors.js';
import type { Store } from '../core/store.js';
import type { ExperimentRunner, StartExperimentInput } from '../core/runner.js';
import { plannedAttempts, normalizeBudget, DEFAULT_BUDGET } from '../core/runner.js';
import type { ModelConfigManager } from './modelConfig.js';
import { domainList, requireDomain } from '../domains/index.js';
import { getDefaultAdapter } from '../domains/adapters.js';
import { buildConditionInterface, rawToolSchemaMap, readOnlyToolNames } from '../core/interfaces.js';
import { previewAdapterCall, describeAdapterLimits, parseAdapterSpec, validateAdapter } from '../core/adapter.js';
import { validateAgainstSchema } from '../core/schema.js';
import { createTransport } from '../core/model.js';
import { hashJson, nowIso } from '../core/util.js';
import { APP_VERSION, APP_NAME } from '../core/version.js';
import { adapterBundle, bundleFileName, evidenceFileName } from '../mcp/export.js';
import { smokeStdioMcp, type McpSmokeResult } from '../mcp/smoke.js';

export interface AppDeps {
  store: Store;
  runner: ExperimentRunner;
  models: ModelConfigManager;
  rootDir: string;
  webDir: string;
}

function jsonError(res: Response, error: unknown): void {
  if (error instanceof AnvilError) {
    res.status(error.status).json({ ok: false, error: error.message, code: error.code, detail: error.detail });
    return;
  }
  res.status(500).json({ ok: false, error: errorMessage(error) });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new AnvilError('invalid_request', `${field} must be a non-empty string.`);
  return value.trim();
}

function split(value: unknown): Split {
  if (value === 'dev' || value === 'eval' || value === 'eval2') return value;
  throw new AnvilError('invalid_split', 'split must be "dev", "eval" or "eval2".');
}

function conditions(value: unknown): ConditionId[] {
  if (value === undefined) return [...CONDITIONS];
  if (!Array.isArray(value) || value.length === 0) throw new AnvilError('invalid_conditions', 'conditions must be a non-empty array.');
  const unique = [...new Set(value)];
  for (const entry of unique) {
    if (!CONDITIONS.includes(entry as ConditionId)) throw new AnvilError('invalid_conditions', `Unknown condition "${String(entry)}".`);
  }
  return unique as ConditionId[];
}

function taskMetadata(domainId: string) {
  const domain = requireDomain(domainId);
  return domain.tasks.map((task) => ({
    id: task.id,
    domain: task.domain,
    family: task.family,
    split: task.split,
    title: task.title,
    prompt: task.prompt,
    outputContract: task.outputContract ? { description: task.outputContract.description, example: task.outputContract.example } : null,
    notes: task.notes ?? null,
  }));
}

function selectedTasks(domainId: string, selectedSplit: Split, taskIds: unknown): string[] {
  const domain = requireDomain(domainId);
  const available = domain.tasks.filter((task) => task.split === selectedSplit).map((task) => task.id);
  if (taskIds === undefined) return available;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    throw new AnvilError('invalid_tasks', 'taskIds must be a non-empty array when provided.');
  }
  const ids = [...new Set(taskIds.map((id) => String(id)))];
  const missing = ids.filter((id) => !available.includes(id));
  if (missing.length > 0) throw new AnvilError('invalid_tasks', `Tasks are not in the ${selectedSplit} split: ${missing.join(', ')}.`);
  return ids;
}

function bundleFor(domainId: string, adapterSource: 'default' | 'saved', savedSpec: AdapterSpec | null, rootDir: string, run?: RunRecord | null) {
  const domain = requireDomain(domainId);
  const spec = adapterSource === 'saved' ? savedSpec : getDefaultAdapter(domainId);
  if (!spec) throw new AnvilError('adapter_missing', `No adapter is available for ${domain.id}.`);
  return adapterBundle({ spec, adapterSource, rootDir, run: run ?? null });
}

function mcpTarget(rootDir: string): { cliPath: string; built: boolean } {
  const cliPath = resolve(rootDir, 'dist', 'cli.js');
  return { cliPath, built: existsSync(cliPath) };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  let mcpCheckCache: { at: number; result: McpSmokeResult } | null = null;

  app.get('/api/health', (_req, res) => {
    const { cliPath, built } = mcpTarget(deps.rootDir);
    res.json({
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      time: nowIso(),
      storage: { dataDir: deps.store.dataDir, runs: deps.store.listRuns().length },
      model: deps.models.status(),
      mcp: {
        cliBuilt: built,
        cliPath,
        workbenchCommand: `node "${cliPath}" workbench-mcp`,
        checked: mcpCheckCache?.result.ok ?? null,
        note: mcpCheckCache
          ? mcpCheckCache.result.ok
            ? `Handshake succeeded with ${mcpCheckCache.result.tools.length} tools.`
            : `Last handshake failed: ${mcpCheckCache.result.error}`
          : 'Not checked yet. Run the MCP handshake to verify.',
      },
    });
  });

  app.get('/api/config/model', (_req, res) => {
    res.json({ ok: true, status: deps.models.status() });
  });

  app.post('/api/config/model', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = deps.models.configure({
        provider: body.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama',
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0,
        maxTokensPerCompletion: typeof body.maxTokensPerCompletion === 'number' ? body.maxTokensPerCompletion : undefined,
      });
      res.json({ ok: true, status });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.delete('/api/config/model', (_req, res) => {
    res.json({ ok: true, status: deps.models.clear() });
  });

  app.post('/api/config/test', async (_req, res) => {
    try {
      const config = deps.models.requireConfigured();
      const started = Date.now();
      const transport = createTransport(config, 20_000);
      const models = await transport.listModels();
      res.json({ ok: true, modelCount: models.length, models: models.slice(0, 60), latencyMs: Date.now() - started });
    } catch (error) {
      if (error instanceof AnvilError) return jsonError(res, error);
      res.status(502).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/domains', (_req, res) => {
    res.json({
      ok: true,
      domains: domainList.map((domain) => ({
        id: domain.id,
        name: domain.name,
        shortName: domain.shortName,
        description: domain.description,
        environment: domain.environment,
        taskSetVersion: domain.taskSetVersion,
        tasks: {
          dev: domain.tasks.filter((task) => task.split === 'dev').length,
          eval: domain.tasks.filter((task) => task.split === 'eval').length,
          eval2: domain.tasks.filter((task) => task.split === 'eval2').length,
        },
        families: [...new Set(domain.tasks.map((task) => task.family))],
      })),
    });
  });

  app.get('/api/tasks', (req, res) => {
    try {
      const domainId = requireString(req.query.domain, 'domain');
      res.json({ ok: true, tasks: taskMetadata(domainId) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/api/interfaces', async (req, res) => {
    try {
      const domainId = requireString(req.query.domain, 'domain');
      const domain = requireDomain(domainId);
      const saved = await deps.store.getSavedAdapter(domain.id);
      const adapter = saved?.spec ?? getDefaultAdapter(domain.id);
      if (!adapter) throw new AnvilError('adapter_missing', `No adapter exists for ${domain.id}.`);
      const validation = validateAdapter(adapter, {
        toolSchemas: rawToolSchemaMap(domain),
        rawToolNames: domain.tools.map((tool) => tool.name),
        readOnlyTools: readOnlyToolNames(domain),
      });
      res.json({
        ok: true,
        domain: domain.id,
        environment: domain.environment,
        conditions: CONDITIONS.map((condition) => {
          const iface = buildConditionInterface(domain, condition, condition === 'adapted' ? adapter : null);
          return {
            condition,
            hash: iface.hash,
            tools: iface.tools,
            limits: condition === 'adapted' ? describeAdapterLimits(adapter) : ['Original tool executor, validation and permissions are unchanged.'],
          };
        }),
        adapter: {
          spec: adapter,
          source: saved ? 'saved' : 'default',
          savedAt: saved?.savedAt ?? null,
          validation,
          limits: describeAdapterLimits(adapter),
        },
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/api/adapters/validate', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const domain = requireDomain(requireString(body.domain, 'domain'));
      const parsed = parseAdapterSpec(body.adapter);
      if (!parsed.ok || !parsed.spec) {
        res.json({ ok: false, parseIssues: parsed.issues, issues: parsed.issues, validation: null });
        return;
      }
      if (parsed.spec.domain !== domain.id) {
        throw new AnvilError('adapter_domain_mismatch', `Adapter targets ${parsed.spec.domain}, not ${domain.id}.`);
      }
      const validation = validateAdapter(parsed.spec, {
        toolSchemas: rawToolSchemaMap(domain),
        rawToolNames: domain.tools.map((tool) => tool.name),
        readOnlyTools: readOnlyToolNames(domain),
      });
      res.json({
        ok: validation.ok,
        parseIssues: parsed.issues,
        issues: validation.issues,
        validation,
        tools: parsed.spec.tools.map((tool) => ({ name: tool.name, target: tool.target, summary: tool.arguments.map((arg) => `${arg.from ?? 'const'} → ${arg.to}`) })),
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/api/adapters/preview', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const domain = requireDomain(requireString(body.domain, 'domain'));
      let spec: AdapterSpec;
      if (body.adapter !== undefined) {
        const parsed = parseAdapterSpec(body.adapter);
        if (!parsed.ok || !parsed.spec) return res.json({ ok: false, issues: parsed.issues, originalCall: null });
        spec = parsed.spec;
        if (spec.domain !== domain.id) throw new AnvilError('adapter_domain_mismatch', `Adapter targets ${spec.domain}, not ${domain.id}.`);
      } else {
        const saved = await deps.store.getSavedAdapter(domain.id);
        const fallback = saved?.spec ?? getDefaultAdapter(domain.id);
        if (!fallback) throw new AnvilError('adapter_missing', `No adapter for ${domain.id}.`);
        spec = fallback;
      }
      const toolName = requireString(body.tool, 'tool');
      const adapted = spec.tools.find((tool) => tool.name === toolName);
      if (!adapted) throw new AnvilError('tool_not_found', `Adapter has no tool "${toolName}".`, 404);
      const args = body.args ?? {};
      const inputValidation = validateAgainstSchema(adapted.inputSchema, args);
      if (!inputValidation.ok) {
        return res.json({ ok: false, inputErrors: inputValidation.errors, issues: [], originalCall: null });
      }
      const preview = previewAdapterCall(adapted, args as Record<string, unknown>, rawToolSchemaMap(domain));
      res.json({
        ok: preview.ok,
        lookupCall: preview.lookupCall,
        originalCall: preview.originalCall,
        notes: preview.notes,
        issues: preview.errors,
        executed: false,
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/api/adapters/:domain', async (req, res) => {
    try {
      const domain = requireDomain(String(req.params.domain));
      const saved = await deps.store.getSavedAdapter(domain.id);
      const fallback = getDefaultAdapter(domain.id);
      res.json({
        ok: true,
        saved,
        defaultAvailable: Boolean(fallback),
        current: saved?.spec ?? fallback ?? null,
        source: saved ? 'saved' : 'default',
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/api/adapters', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const domain = requireDomain(requireString(body.domain, 'domain'));
      const parsed = parseAdapterSpec(body.adapter);
      if (!parsed.ok || !parsed.spec) {
        res.status(400).json({ ok: false, error: 'The adapter is invalid.', issues: parsed.issues.filter((issue) => issue.severity === 'error') });
        return;
      }
      if (parsed.spec.domain !== domain.id) throw new AnvilError('adapter_domain_mismatch', `Adapter targets ${parsed.spec.domain}, not ${domain.id}.`);
      const validation = validateAdapter(parsed.spec, {
        toolSchemas: rawToolSchemaMap(domain),
        rawToolNames: domain.tools.map((tool) => tool.name),
        readOnlyTools: readOnlyToolNames(domain),
      });
      if (!validation.ok) {
        res.status(400).json({ ok: false, error: 'The adapter is invalid.', issues: validation.issues.filter((issue) => issue.severity === 'error') });
        return;
      }
      const saved = await deps.store.saveAdapter(domain.id, parsed.spec);
      res.json({ ok: true, savedAt: saved.savedAt, validation, adapterHash: hashJson(parsed.spec) });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.delete('/api/adapters/:domain', async (req, res) => {
    try {
      const domain = requireDomain(String(req.params.domain));
      await deps.store.deleteSavedAdapter(domain.id);
      res.json({ ok: true, source: 'default' });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/api/runs/plan', (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const domainId = requireString(body.domain, 'domain');
      const domain = requireDomain(domainId);
      const selectedSplit = split(body.split);
      const tasks = selectedTasks(domainId, selectedSplit, body.taskIds);
      const selectedConditions = conditions(body.conditions);
      const trialsPerTask = Math.min(5, Math.max(1, Number(body.trialsPerTask ?? 1)));
      const plannedTrials = tasks.length * selectedConditions.length * trialsPerTask;
      const budget = normalizeBudget(body.budget as Record<string, number> | undefined, plannedTrials);
      const attempts = plannedAttempts({ trialsPerTask, conditions: selectedConditions, taskIds: tasks }, tasks.length);
      res.json({
        ok: true,
        domain: domain.id,
        tasks,
        conditions: selectedConditions,
        trialsPerTask,
        plannedTrials,
        maxUnderlyingToolCalls: Math.min(budget.maxUnderlyingToolCallsTotal, attempts.maxUnderlyingToolCalls),
        budget,
        defaultBudget: DEFAULT_BUDGET,
      });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const mode = body.mode === 'simulation' ? 'simulation' : 'live';
      const domainId = requireString(body.domain, 'domain');
      requireDomain(domainId);
      const input: StartExperimentInput = {
        mode,
        domain: domainId,
        split: split(body.split),
        ...(body.taskIds !== undefined ? { taskIds: selectedTasks(domainId, split(body.split), body.taskIds) } : {}),
        conditions: conditions(body.conditions),
        trialsPerTask: Math.min(5, Math.max(1, Number(body.trialsPerTask ?? 1))),
        budget: (body.budget ?? {}) as Record<string, number>,
        adapterSource: body.adapterSource === 'saved' ? 'saved' : 'default',
        ...(typeof body.sessionNote === 'string' ? { sessionNote: body.sessionNote.slice(0, 300) } : {}),
      };
      const modelConfig = mode === 'live' ? deps.models.requireConfigured() : deps.models.get();
      const run = await deps.runner.start(input, modelConfig, { startedBy: 'workbench' });
      res.status(201).json({ ok: true, run });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/api/runs', (_req, res) => {
    res.json({ ok: true, runs: deps.store.listRuns() });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = deps.store.getRun(String(req.params.id));
    if (!run) return jsonError(res, new AnvilError('run_not_found', 'Run not found.', 404));
    res.json({ ok: true, run });
  });

  app.get('/api/runs/:id/events', (req: Request, res: Response) => {
    const run = deps.store.getRun(String(req.params.id));
    if (!run) return jsonError(res, new AnvilError('run_not_found', 'Run not found.', 404));
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders();
    const send = (value: RunRecord) => {
      res.write(`event: run\ndata: ${JSON.stringify(value)}\n\n`);
    };
    send(run);
    if (run.status !== 'running') {
      res.end();
      return;
    }
    const unsubscribe = deps.runner.subscribe(run.id, send);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  app.post('/api/runs/:id/cancel', async (req, res) => {
    try {
      const run = await deps.runner.cancel(String(req.params.id));
      res.json({ ok: true, run });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/api/runs/:id/export', async (req, res) => {
    try {
      const run = deps.store.getRun(String(req.params.id));
      if (!run) throw new AnvilError('run_not_found', 'Run not found.', 404);
      const saved = await deps.store.getSavedAdapter(run.config.domain);
      const source = run.provenance.adapterSource === 'saved' ? 'saved' : 'default';
      const candidate = source === 'saved' ? saved?.spec ?? null : getDefaultAdapter(run.config.domain) ?? null;
      const candidateHash = candidate ? hashJson(candidate) : null;
      if (run.provenance.adapterHash !== null && candidateHash !== run.provenance.adapterHash) {
        throw new AnvilError(
          'adapter_mismatch',
          `The ${source} adapter for ${run.config.domain} no longer matches the adapter this run used (adapterHash ${run.provenance.adapterHash}). Exporting now would silently bundle a different adapter, so this export is blocked.`,
          409,
        );
      }
      const bundle = bundleFor(run.config.domain, source, saved?.spec ?? null, deps.rootDir, run);
      const content = `${JSON.stringify(
        {
          ...bundle,
          exportedAt: nowIso(),
          exportNotes: [
            'Evidence export contains the persisted run, interface hashes, adapter and summary.',
            run.mode === 'simulation'
              ? 'This run is a scripted simulation, not live model evidence.'
              : 'This run is live model evidence for the model identity recorded in the run.',
            'No API key is present in this export. Provider-reported cost is null when the provider did not report it.',
          ],
        },
        null,
        2,
      )}\n`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${evidenceFileName(run)}"`);
      res.send(content);
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/api/export/adapter', async (req, res) => {
    try {
      const domainId = requireString(req.query.domain, 'domain');
      const domain = requireDomain(domainId);
      const saved = await deps.store.getSavedAdapter(domain.id);
      const source = req.query.source === 'default' ? 'default' : saved ? 'saved' : 'default';
      const bundle = bundleFor(domain.id, source, saved?.spec ?? null, deps.rootDir);
      const kind = req.query.kind === 'spec' ? 'spec' : req.query.kind === 'mcp-config' ? 'mcp-config' : 'bundle';
      const payload = kind === 'spec' ? bundle.adapter : kind === 'mcp-config' ? bundle.mcpConfig : bundle;
      const suffix = kind === 'bundle' ? '' : `-${kind}`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${bundleFileName(domain.id, suffix)}"`);
      res.send(`${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/api/integration', (_req, res) => {
    const { cliPath, built } = mcpTarget(deps.rootDir);
    const pluginDir = join(deps.rootDir, 'plugins', 'anvil');
    const manifest = join(pluginDir, '.cursor-plugin', 'plugin.json');
    const marketplace = join(deps.rootDir, '.cursor-plugin', 'marketplace.json');
    const mcpJson = join(pluginDir, 'mcp.json');
    let pluginManifest: unknown = null;
    try {
      pluginManifest = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      pluginManifest = null;
    }
    res.json({
      ok: true,
      local: {
        cliBuilt: built,
        cliPath,
        workbenchCommand: `node "${cliPath}" workbench-mcp`,
        calendarAdapterCommand: `node "${cliPath}" mcp --domain calendar --adapter default`,
        issuesAdapterCommand: `node "${cliPath}" mcp --domain issues --adapter default`,
        fileAdapterCommand: `node "${cliPath}" mcp --domain calendar --adapter file --adapter-file "<PATH_TO_BUNDLE_JSON>"`,
        compatibleWith: 'Local MCP clients that can launch a stdio server (for example Claude Desktop, Cursor, or an MCP inspector).',
        alanDesktopStatus:
          'Alan desktop runs custom stdio MCP connectors: Command `npx`, args `-y -p github:Wali05/anvil anvil-mcp --domain calendar` (Windows: Command `cmd`, args `/c npx -y -p github:Wali05/anvil anvil-mcp --domain calendar`). A run inside Alan has not been recorded yet.',
      },
      plugin: {
        directory: pluginDir,
        manifestPath: manifest,
        marketplacePath: marketplace,
        mcpPath: mcpJson,
        manifestPresent: existsSync(manifest) && Boolean(pluginManifest),
        manifest: pluginManifest,
        installed: false,
        note: 'The plugin package is in the repository and its mcp.json launches the stdio adapter server with npx. It is not installed in Alan.',
      },
      deployment: {
        deployed: false,
        requiredTransport: 'stdio',
        placeholderUrl: '',
        note: 'The MCP server is local stdio, launched by the client (Alan desktop custom connector, Claude Desktop, Cursor). There is no hosted HTTPS endpoint.',
      },
      lastCheck: mcpCheckCache
        ? { at: new Date(mcpCheckCache.at).toISOString(), ...mcpCheckCache.result }
        : null,
    });
  });

  app.post('/api/integration/check', async (_req, res) => {
    try {
      const { cliPath, built } = mcpTarget(deps.rootDir);
      if (!built) {
        throw new AnvilError('mcp_not_built', 'The MCP CLI has not been built yet. Run npm run build first.', 409);
      }
      if (mcpCheckCache && Date.now() - mcpCheckCache.at < 20_000) {
        res.json({ ok: true, result: mcpCheckCache.result, cached: true });
        return;
      }
      const result = await smokeStdioMcp({
        command: process.execPath,
        args: [cliPath, 'workbench-mcp'],
        env: { ANVIL_DATA_DIR: deps.store.dataDir },
        timeoutMs: 20_000,
        callListDomains: true,
      });
      mcpCheckCache = { at: Date.now(), result };
      res.json({ ok: result.ok, result, cached: false });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'Unknown API route.' });
  });

  if (existsSync(deps.webDir)) {
    app.use(express.static(deps.webDir, { index: false, maxAge: 0 }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      const index = join(deps.webDir, 'index.html');
      if (!existsSync(index)) return next();
      res.sendFile(index);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found.' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    jsonError(res, error);
  });

  return app;
}