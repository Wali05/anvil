import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { Store } from '../core/store.js';
import { ExperimentRunner } from '../core/runner.js';
import { ModelConfigManager } from './modelConfig.js';
import { createApp } from './app.js';

export interface StartServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  rootDir?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  host: string;
  url: string;
  store: Store;
  runner: ExperimentRunner;
  models: ModelConfigManager;
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const dataDir = resolve(options.dataDir ?? process.env.ANVIL_DATA_DIR ?? '.anvil');
  const port = options.port ?? Number(process.env.ANVIL_PORT ?? 4317);
  const host = options.host ?? process.env.ANVIL_HOST ?? '127.0.0.1';
  const store = new Store(dataDir);
  await store.init();
  const models = new ModelConfigManager();
  models.applyEnvironment(process.env);
  const runner = new ExperimentRunner({ store });
  const webDir = resolve(rootDir, 'dist', 'web');
  const app = createApp({ store, runner, models, rootDir, webDir });

  const server = app.listen(port, host);
  await new Promise<void>((resolveListening, reject) => {
    server.once('listening', () => resolveListening());
    server.once('error', reject);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  process.stdout.write(`[anvil] API ${url} · data ${dataDir}\n`);
  if (existsSync(webDir)) process.stdout.write(`[anvil] dashboard served from ${webDir}\n`);
  else process.stdout.write('[anvil] no compiled dashboard yet (run npm run build, or use npm run dev for Vite)\n');

  return {
    server,
    port: actualPort,
    host,
    url,
    store,
    runner,
    models,
    async close() {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}