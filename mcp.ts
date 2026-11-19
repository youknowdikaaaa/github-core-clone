// mcp.ts — Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 Streamable HTTP
// (plain JSON answers, no SSE). Modern era (2026-07-28) via server/discover, with the
// legacy initialize handshake as a fallback. Six tools act on the same store as REST.

import { type Forge, restRepo, restIssue, restPull, type Repo } from './store.ts';

export interface McpResult {
  status: number;
  /** null → empty body. */
  body: unknown;
  headers?: Record<string, string>;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by squash.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolText(text: string): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text }], isError: true };
}

type Args = Record<string, unknown>;

function strArg(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function intArg(args: Args, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

/** Split owner/repo out of the args (owner, owner_login, full_name, repository...). */
function ownerRepo(args: Args): { owner: string | undefined; repo: string | undefined } {
  let owner = strArg(args, 'owner', 'owner_login', 'ownerLogin');
  let repo = strArg(args, 'repo', 'repository', 'repo_name', 'name');
  const fullName = strArg(args, 'full_name', 'fullName');
  if ((!owner || !repo) && fullName && fullName.includes('/')) {
    const [head, ...tail] = fullName.split('/');
    if (!owner) owner = head;
    if (!repo) repo = tail.join('/');
  }
  return { owner, repo };
}

function lookup(forge: Forge, owner: string, repoName: string): Repo | null {
  if (owner !== forge.viewer.login) return null;
  return forge.getRepo(owner, repoName);
}

function callTool(forge: Forge, name: string, args: Args): { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const missing = (field: string): { content: { type: string; text: string }[]; isError: boolean } =>
    toolError(`Missing required argument: ${field}`);
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (!repoName) return missing('name');
      const owner = strArg(args, 'owner') ?? forge.viewer.login;
      if (owner !== forge.viewer.login) return toolError(`Cannot create a repository for owner ${owner}`);
      if (forge.getRepo(owner, repoName)) return toolError(`Repository ${owner}/${repoName} already exists`);
      const repo = forge.createRepo(repoName, args.private === true, strArg(args, 'description') ?? '');
      if (!repo) return toolError(`Repository ${owner}/${repoName} already exists`);
      const shape = restRepo(forge, repo);
      return { ...toolText(JSON.stringify(shape)), structuredContent: shape };
    }
    case 'get_repo': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const repo = lookup(forge, owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const shape = restRepo(forge, repo);
      return { ...toolText(JSON.stringify(shape)), structuredContent: shape };
    }
    case 'create_issue': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const title = strArg(args, 'title');
      if (!title) return missing('title');
      const repo = lookup(forge, owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const result = forge.createIssue(repo, title, strArg(args, 'body') ?? '', []);
      if ('error' in result) return toolError(`unknown label: ${result.label}`);
      const shape = restIssue(forge, repo, result);
      return { ...toolText(JSON.stringify(shape)), structuredContent: shape };
    }
    case 'list_issues': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const repo = lookup(forge, owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = strArg(args, 'state') ?? 'open';
      const issues = forge.listIssues(repo, { state, sort: 'created', direction: 'desc', page: 1, perPage: 100000 }).issues;
      const shapes = issues.map((issue) => restIssue(forge, repo, issue));
      return { ...toolText(JSON.stringify(shapes)), structuredContent: { issues: shapes } };
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const title = strArg(args, 'title');
      if (!title) return missing('title');
      const head = strArg(args, 'head', 'head_ref', 'headRef');
      if (!head) return missing('head');
      const base = strArg(args, 'base', 'base_ref', 'baseRef');
      if (!base) return missing('base');
      const repo = lookup(forge, owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const result = forge.createPull(repo, title, strArg(args, 'body') ?? '', head, base);
      if ('error' in result) return toolError(result.error);
      const shape = restPull(forge, repo, result);
      return { ...toolText(JSON.stringify(shape)), structuredContent: shape };
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (!owner) return missing('owner');
      if (!repoName) return missing('repo');
      const number = intArg(args, 'pull_number', 'pullNumber', 'number');
      if (number === undefined) return missing('pull_number');
      const repo = lookup(forge, owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const pull = forge.getPull(repo, number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      const result = forge.mergePull(repo, pull);
      if ('error' in result) return toolError(result.error);
      const shape = { sha: result.mergeSha, merged: true, message: `Merge pull request #${number} from ${repo.owner}/${pull.headRef}` };
      return { ...toolText(JSON.stringify(shape)), structuredContent: shape };
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp body. `rawBody` is the unparsed request body (for the parse-error path).
 * Auth is enforced by app.ts before this is called.
 */
export function handleMcp(forge: Forge, rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const request = parsed as { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in request ? request.id : undefined;
  const method = request.method;
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params = (request.params ?? {}) as Args;

  // Notifications carry no id: acknowledge and answer nothing.
  if (id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const version = offered && SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
      return {
        status: 200,
        headers: { 'mcp-session-id': 'forge-1' },
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        },
      };
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : undefined;
      if (!toolName) return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Args;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return rpcError(id, -32602, 'Invalid params: arguments must be an object');
      }
      const required = (tool.inputSchema.required ?? []) as string[];
      const missingArg = required.find((field) => {
        if (field === 'pull_number') return intArg(args, 'pull_number', 'pullNumber', 'number') === undefined;
        if (field === 'owner' || field === 'repo') {
          const { owner, repo } = ownerRepo(args);
          return field === 'owner' ? owner === undefined : repo === undefined;
        }
        return strArg(args, field) === undefined;
      });
      if (missingArg !== undefined) {
        return rpcResult(id, toolError(`Missing required argument: ${missingArg}`));
      }
      const result = callTool(forge, toolName, args);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
