/**
 * Copy-paste setup for the MCP clients people actually use. Every client that
 * launches stdio servers takes the same command + args; only the file and the
 * wrapper shape differ. Generated in one place so the README, the API, the
 * dashboard and exported bundles never drift apart.
 */

export interface ServerLaunch {
  name: string;
  command: string;
  args: string[];
}

export interface ClientSetup {
  id: string;
  client: string;
  where: string;
  /** `json` / `toml` / `shell`, for syntax highlighting. */
  format: 'json' | 'toml' | 'shell';
  snippet: string;
  note?: string;
}

/** The package spec that npx installs from. No clone needed; npm builds it on install. */
export const NPX_PACKAGE = 'github:Wali05/anvil';

export function npxLaunch(name: string, bin: 'anvil' | 'anvil-mcp', args: string[]): ServerLaunch {
  return { name, command: 'npx', args: ['-y', '-p', NPX_PACKAGE, bin, ...args] };
}

/** Windows launches npx through cmd so the .cmd shim resolves. */
export function windowsLaunch(launch: ServerLaunch): ServerLaunch {
  return launch.command === 'npx' ? { ...launch, command: 'cmd', args: ['/c', 'npx', ...launch.args] } : launch;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function clientSetups(launch: ServerLaunch): ClientSetup[] {
  const standard = JSON.stringify({ mcpServers: { [launch.name]: { command: launch.command, args: launch.args } } }, null, 2);
  const win = windowsLaunch(launch);
  return [
    {
      id: 'claude-code',
      client: 'Claude Code',
      where: 'terminal (or a project .mcp.json with the JSON below)',
      format: 'shell',
      snippet: `claude mcp add ${shellQuote(launch.name)} -- ${[launch.command, ...launch.args].map(shellQuote).join(' ')}`,
    },
    {
      id: 'claude-desktop',
      client: 'Claude Desktop',
      where: 'claude_desktop_config.json (Settings → Developer → Edit Config)',
      format: 'json',
      snippet: standard,
    },
    {
      id: 'cursor',
      client: 'Cursor',
      where: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json',
      format: 'json',
      snippet: standard,
    },
    {
      id: 'vscode',
      client: 'VS Code (Copilot agent mode)',
      where: '.vscode/mcp.json',
      format: 'json',
      snippet: JSON.stringify({ servers: { [launch.name]: { type: 'stdio', command: launch.command, args: launch.args } } }, null, 2),
    },
    {
      id: 'windsurf',
      client: 'Windsurf',
      where: '~/.codeium/windsurf/mcp_config.json',
      format: 'json',
      snippet: standard,
    },
    {
      id: 'codex',
      client: 'Codex CLI',
      where: '~/.codex/config.toml',
      format: 'toml',
      snippet: `[mcp_servers.${launch.name.replace(/[^A-Za-z0-9_-]/g, '_')}]\ncommand = ${tomlString(launch.command)}\nargs = [${launch.args.map(tomlString).join(', ')}]`,
    },
    {
      id: 'generic',
      client: 'Any other stdio MCP client',
      where: 'command + args',
      format: 'shell',
      snippet: [launch.command, ...launch.args].map(shellQuote).join(' '),
      note: `On Windows use command "${win.command}" with args ${JSON.stringify(win.args)}.`,
    },
  ];
}
