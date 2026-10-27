import { startServer } from './start.js';
import { loadProjectEnv } from '../core/env.js';

loadProjectEnv();
const running = await startServer();
let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  process.stdout.write(`[anvil] ${signal} received; closing server\n`);
  await running.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));