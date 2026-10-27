import { rm } from 'node:fs/promises';

await rm('.anvil-e2e', { recursive: true, force: true });
console.log('cleared .anvil-e2e');