import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Alan plugin package', () => {
  it('contains a structurally consistent manifest, marketplace entry and MCP template', async () => {
    const manifest = JSON.parse(await readFile('plugins/anvil/.cursor-plugin/plugin.json', 'utf8')) as Record<string, unknown>;
    expect(manifest.name).toBe('anvil');
    expect(manifest.mcpServers).toBe('./mcp.json');
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.license).toBe('MIT');

    const marketplace = JSON.parse(await readFile('.cursor-plugin/marketplace.json', 'utf8')) as {
      plugins: Array<{ name: string; source: string }>;
    };
    const entry = marketplace.plugins.find((plugin) => plugin.name === 'anvil');
    expect(entry?.source).toBe('plugins/anvil');

    const mcp = JSON.parse(await readFile('plugins/anvil/mcp.json', 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string }>;
    };
    const server = mcp.mcpServers.anvil;
    expect(server?.type).toBe('http');
    expect(server?.url.startsWith('https://')).toBe(true);
    // The reserved .invalid TLD is deliberate: no public deployment exists.
    expect(new URL(server!.url).hostname.endsWith('.invalid')).toBe(true);

    const skill = await readFile('plugins/anvil/skills/anvil-workbench/SKILL.md', 'utf8');
    expect(skill.startsWith('---\nname: anvil-workbench')).toBe(true);
    expect(skill).toContain('Never describe a **simulation** as model evidence');
  });

  it('does not claim installation or a live deployment in package docs', async () => {
    const readme = await readFile('plugins/anvil/README.md', 'utf8');
    expect(readme).toContain('not deployed and not installed');
    expect(readme).toContain('anvil-mcp.invalid');
    expect(readme).toContain('A file in this repository is not an installed Alan integration');
  });
});