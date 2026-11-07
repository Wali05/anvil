/**
 * Tiny fixture MCP server used to demonstrate Anvil proxy mode.
 * Tools are intentionally awkward (nested envelopes, terse errors, id-required
 * cancel) so an adapter can flatten them. Local in-memory state only.
 */
import { serveStdioMcp, objectSchema, type McpTool } from './common.js';

export interface DeskTicket {
  id: string;
  title: string;
  status: 'O' | 'C';
  priority: { level: '1' | '2' | '3' };
  assignee?: { email: string };
  workspace: string;
}

export interface DeskState {
  nextId: number;
  tickets: DeskTicket[];
}

export function createInitialDeskState(): DeskState {
  return {
    nextId: 1004,
    tickets: [
      {
        id: 'T-1001',
        title: 'Broken login redirect',
        status: 'O',
        priority: { level: '2' },
        assignee: { email: 'sam@acme.test' },
        workspace: 'acme',
      },
      {
        id: 'T-1002',
        title: 'Broken login redirect',
        status: 'O',
        priority: { level: '3' },
        workspace: 'acme',
      },
      {
        id: 'T-1000',
        title: 'Legacy invoice export',
        status: 'C',
        priority: { level: '1' },
        assignee: { email: 'ops@acme.test' },
        workspace: 'acme',
      },
      {
        id: 'T-1003',
        title: 'Unique billing glitch',
        status: 'O',
        priority: { level: '2' },
        workspace: 'acme',
      },
    ],
  };
}

function fail(message: string): never {
  const error = new Error(message);
  (error as Error & { code?: string }).code = 'desk_error';
  throw error;
}

export function buildSampleUpstreamTools(state: DeskState = createInitialDeskState()): McpTool[] {
  return [
    {
      name: 'desk_list_tickets',
      description: 'List tickets. Requires nested query.workspace. Status codes are O|C. Max page 20.',
      inputSchema: objectSchema(
        {
          query: {
            type: 'object',
            additionalProperties: false,
            required: ['workspace'],
            properties: {
              workspace: { type: 'string', minLength: 1, description: 'Workspace slug.' },
              status: { type: 'string', enum: ['O', 'C'], description: 'O=open, C=closed.' },
              title_eq: { type: 'string', description: 'Exact title filter.' },
            },
          },
          max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Page size (max 20).' },
        },
        ['query'],
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler(args) {
        const query = args.query as { workspace?: string; status?: 'O' | 'C'; title_eq?: string } | undefined;
        if (!query || typeof query.workspace !== 'string' || !query.workspace.trim()) {
          fail('ERR_QUERY: workspace required');
        }
        const max = typeof args.max_results === 'number' ? args.max_results : 20;
        if (max > 20) fail('ERR_LIMIT: max 20');
        let items = state.tickets.filter((ticket) => ticket.workspace === query.workspace);
        if (query.status) items = items.filter((ticket) => ticket.status === query.status);
        if (typeof query.title_eq === 'string' && query.title_eq.length > 0) {
          items = items.filter((ticket) => ticket.title === query.title_eq);
        }
        return { kind: 'desk#ticketList', items: items.slice(0, max) };
      },
    },
    {
      name: 'desk_open_ticket',
      description: 'Open a ticket. Requires nested ticket resource with priority.level as "1"|"2"|"3".',
      inputSchema: objectSchema(
        {
          workspace: { type: 'string', minLength: 1 },
          ticket: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'priority'],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              priority: {
                type: 'object',
                additionalProperties: false,
                required: ['level'],
                properties: {
                  level: { type: 'string', enum: ['1', '2', '3'] },
                },
              },
              assignee: {
                type: 'object',
                additionalProperties: false,
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          },
        },
        ['workspace', 'ticket'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler(args) {
        const workspace = String(args.workspace ?? '');
        const ticket = args.ticket as {
          title?: string;
          priority?: { level?: string };
          assignee?: { email?: string };
        };
        if (!workspace) fail('ERR_WS');
        if (!ticket?.title || !ticket.priority?.level) fail('ERR_BODY');
        if (!['1', '2', '3'].includes(ticket.priority.level)) fail('ERR_PRI');
        const created: DeskTicket = {
          id: `T-${state.nextId++}`,
          title: ticket.title,
          status: 'O',
          priority: { level: ticket.priority.level as '1' | '2' | '3' },
          workspace,
          ...(ticket.assignee?.email ? { assignee: { email: ticket.assignee.email } } : {}),
        };
        state.tickets.push(created);
        return created;
      },
    },
    {
      name: 'desk_cancel_ticket',
      description: 'Cancel (close) a ticket by opaque ticket_id. Requires workspace for audit. No title lookup.',
      inputSchema: objectSchema(
        {
          workspace: { type: 'string', minLength: 1, description: 'Workspace slug (audit only).' },
          ticket_id: { type: 'string', minLength: 1, description: 'Opaque ticket id, e.g. T-1001.' },
        },
        ['workspace', 'ticket_id'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler(args) {
        const workspace = String(args.workspace ?? '');
        const id = String(args.ticket_id ?? '');
        if (!workspace) fail('ERR_WS');
        const ticket = state.tickets.find((item) => item.id === id);
        if (!ticket) fail('ERR_NF');
        if (ticket.workspace !== workspace) fail('ERR_WS_MISMATCH');
        if (ticket.status === 'C') fail('ERR_ALREADY');
        ticket.status = 'C';
        return ticket;
      },
    },
  ];
}

export async function runSampleUpstream(): Promise<void> {
  const tools = buildSampleUpstreamTools();
  await serveStdioMcp({
    name: 'anvil-sample-upstream',
    version: '0.1.0',
    instructions:
      'Sample awkward ticket-desk MCP for Anvil proxy demos. In-memory only; not a real helpdesk.',
    tools,
  });
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /sampleUpstream\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  try {
    await runSampleUpstream();
  } catch (error) {
    process.stderr.write(`[anvil-sample-upstream] failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
