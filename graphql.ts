// graphql.ts — a small hand-written GraphQL executor for the documents gh and
// github-mcp-server send (see sdk/conformance/checks-graphql.ts GRAPHQL_DOCUMENTS).
// Supports queries, mutations, variables, aliases, fragments, inline fragments,
// input objects, enum literals and __type introspection. Unknown fields produce a
// GraphQL-level errors array with HTTP 200, never an HTTP error.

import { type Forge, type Issue, type PullRequest, type Repo, globalId, decodeGlobalId } from './store.ts';

// -------------------------------------------------------------------------------- tokenizer

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'var' | 'spread';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if (ch === '$') {
      let end = index + 1;
      while (end < source.length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: 'var', value: source.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (ch === '"') {
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1];
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else value += escaped;
          end += 2;
        } else {
          value += source[end];
          end += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[index + 1] ?? ''))) {
      let end = index;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      let isFloat = false;
      if (source[end] === '.' && /[0-9]/.test(source[end + 1] ?? '')) {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < source.length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    throw new Error(`GraphQL parse error: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------- AST

export type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

export type Selection =
  | { kind: 'field'; name: string; alias: string; args: { name: string; value: Value }[]; selections: Selection[] }
  | { kind: 'fragment'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: Value | null }[];
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL parse error: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL parse error: expected ${value}, got ${token.value}`);
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`GraphQL parse error: expected ${what}, got ${token.value}`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        this.expectName('on');
        const typeCondition = this.expectName('a type condition');
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek()!;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const nextToken = this.peek();
      if (nextToken && nextToken.kind === 'name') name = this.next().value;
    } else if (token.kind === 'punct' && token.value === '{') {
      // Shorthand query.
    } else {
      throw new Error(`GraphQL parse error: expected an operation, got ${token.value}`);
    }
    const varDefs: { name: string; defaultValue: Value | null }[] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const varToken = this.next();
        if (varToken.kind !== 'var') throw new Error('GraphQL parse error: expected a variable');
        this.expectPunct(':');
        this.parseType();
        let defaultValue: Value | null = null;
        if (this.matchPunct('=')) defaultValue = this.parseValue();
        varDefs.push({ name: varToken.value, defaultValue });
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private parseType(): void {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type');
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const nextToken = this.peek();
      if (nextToken && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, selections };
      }
      if (nextToken && nextToken.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment', name };
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inline', typeCondition: null, selections };
    }
    let name = this.expectName('a field name');
    let alias = name;
    const nextToken = this.peek();
    if (nextToken && nextToken.kind === 'punct' && nextToken.value === ':') {
      this.next();
      alias = name;
      name = this.expectName('a field name');
    }
    const args: { name: string; value: Value }[] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selections: Selection[] = [];
    const after = this.peek();
    if (after && after.kind === 'punct' && after.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  /** Directives (@include, @skip, ...) are parsed and ignored. */
  private skipDirectives(): void {
    while (true) {
      const token = this.peek();
      if (!token || token.kind !== 'punct' || token.value !== '@') return;
      this.next();
      this.expectName('a directive name');
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          this.expectName('an argument name');
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'var') return { kind: 'var', name: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.matchPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL parse error: unexpected value ${token.value}`);
  }
}

// -------------------------------------------------------------------------------- schema tables

/** Fields each type exposes, used for validation and __type introspection. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  Viewer: ['login', 'id', 'name'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
    'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'closed'],
  PullRequest: [
    'id',
    'number',
    'headRefName',
    'baseRefName',
    'mergeable',
    'state',
    'merged',
    'files',
    'title',
    'body',
    'url',
    'mergedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RepositoryOwner: ['login', 'id'],
  Ref: ['name'],
  User: ['login', 'id', 'name'],
  PullRequestFile: ['path'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  Viewer: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestFileConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestFileEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  RepositoryOwner: 'OBJECT',
  Ref: 'OBJECT',
  User: 'OBJECT',
  PullRequestFile: 'OBJECT',
  IssueComment: 'OBJECT',
  SearchType: 'ENUM',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __InputValue: 'OBJECT',
  __Schema: 'OBJECT',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

// -------------------------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, FragmentDef>;
}

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { __typename: string; value: unknown };

function isNode(value: GqlValue): value is { __typename: string; value: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__typename' in value;
}

function node(typename: string, value: unknown): GqlValue {
  return { __typename: typename, value };
}

function resolveValue(valueNode: Value, ctx: Ctx): unknown {
  switch (valueNode.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return valueNode.value;
    case 'null':
      return null;
    case 'enum':
      return valueNode.value;
    case 'var': {
      const value = ctx.variables[valueNode.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return valueNode.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of valueNode.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argMap(args: { name: string; value: Value }[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  nodeValue: GqlValue;
}

function buildConnection(typename: string, edgeType: string, items: ConnectionItem[], first: unknown, after: unknown): GqlValue {
  const count = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const afterNumber = cursorNumber(after);
  let start = 0;
  if (afterNumber !== null) {
    const index = items.findIndex((item) => item.number === afterNumber);
    start = index >= 0 ? index + 1 : 0;
  }
  const page = items.slice(start, start + count);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? cursorFor(page[0].number) : null;
  return node(typename, {
    nodes: page.map((item) => item.nodeValue),
    edges: page.map((item) => node(edgeType, { node: item.nodeValue, cursor: cursorFor(item.number) })),
    pageInfo: node('PageInfo', { hasNextPage, hasPreviousPage: start > 0, startCursor, endCursor }),
    totalCount: items.length,
  });
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoByGlobalId(forge: Forge, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'repo') return forge.findRepoById(parsed.repoId) ?? null;
  return null;
}

function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const repo = forge.findRepoById(parsed.repoId);
  if (!repo) return null;
  const issue = forge.getIssue(repo, parsed.number);
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'pull') return null;
  const repo = forge.findRepoById(parsed.repoId);
  if (!repo) return null;
  const pull = forge.getPull(repo, parsed.number);
  return pull ? { repo, pull } : null;
}

/** Decode a global id (base64 "R:<repo>", "I:<repo>:<num>", "P:<repo>:<num>", "C:<repo>:<num>:<id>"). */
function parseGlobalId(id: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repoId: number; number: number; commentId?: number } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const repoId = Number.parseInt(decoded.parts[0] ?? '', 10);
  if (!Number.isInteger(repoId)) return null;
  if (decoded.kind === 'R' && decoded.parts.length === 1) return { kind: 'repo', repoId, number: 0 };
  const number = Number.parseInt(decoded.parts[1] ?? '', 10);
  if (!Number.isInteger(number)) return null;
  if (decoded.kind === 'I' && decoded.parts.length === 2) return { kind: 'issue', repoId, number };
  if (decoded.kind === 'P' && decoded.parts.length === 2) return { kind: 'pull', repoId, number };
  if (decoded.kind === 'C' && decoded.parts.length === 3) {
    const commentId = Number.parseInt(decoded.parts[2], 10);
    if (!Number.isInteger(commentId)) return null;
    return { kind: 'comment', repoId, number, commentId };
  }
  return null;
}

/** Resolve one field on a typed node. Returns a GqlValue (scalar, list, or node). */
function resolveField(typeName: string, parent: unknown, field: string, args: Record<string, unknown>, ctx: Ctx): GqlValue {
  const forge = ctx.forge;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return node('Viewer', forge.viewer);
      if (field === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== forge.viewer.login) return null;
        const repo = forge.getRepo(owner, name);
        return repo ? node('Repository', repo) : null;
      }
      if (field === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const parsed = parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.kind === 'repo') {
          const repo = forge.findRepoById(parsed.repoId);
          return repo ? node('Repository', repo) : null;
        }
        if (parsed.kind === 'issue') {
          const found = findIssueByGlobalId(forge, id);
          return found ? node('Issue', found.issue) : null;
        }
        if (parsed.kind === 'pull') {
          const found = findPullByGlobalId(forge, id);
          return found ? node('PullRequest', found.pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
        return node('__Type', name);
      }
      if (field === '__schema') return node('__Schema', null);
      return null;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field === 'createIssue') {
        const repositoryId = input.repositoryId;
        const title = input.title;
        if (typeof repositoryId !== 'string' || typeof title !== 'string') throw new Error('createIssue: repositoryId and title are required');
        const repo = findRepoByGlobalId(forge, repositoryId);
        if (!repo) throw new Error(`Could not resolve to a Repository with the id of ${repositoryId}`);
        const issue = forge.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
        if ('error' in issue) throw new Error(`unknown label: ${issue.label}`);
        return node('CreateIssuePayload', { issue });
      }
      if (field === 'closeIssue') {
        const issueId = input.issueId;
        if (typeof issueId !== 'string') throw new Error('closeIssue: issueId is required');
        const found = findIssueByGlobalId(forge, issueId);
        if (!found) throw new Error(`Could not resolve to an Issue with the id of ${issueId}`);
        forge.patchIssue(found.repo, found.issue.number, { state: 'closed' });
        return node('CloseIssuePayload', { issue: found.issue });
      }
      if (field === 'createPullRequest') {
        const repositoryId = input.repositoryId;
        const baseRefName = input.baseRefName;
        const headRefName = input.headRefName;
        const title = input.title;
        if (typeof repositoryId !== 'string' || typeof baseRefName !== 'string' || typeof headRefName !== 'string' || typeof title !== 'string') {
          throw new Error('createPullRequest: repositoryId, baseRefName, headRefName and title are required');
        }
        const repo = findRepoByGlobalId(forge, repositoryId);
        if (!repo) throw new Error(`Could not resolve to a Repository with the id of ${repositoryId}`);
        const pull = forge.createPull(repo, title, typeof input.body === 'string' ? input.body : '', headRefName, baseRefName);
        if ('error' in pull) throw new Error(pull.error);
        return node('CreatePullRequestPayload', { pull, repo });
      }
      if (field === 'mergePullRequest') {
        const pullRequestId = input.pullRequestId;
        if (typeof pullRequestId !== 'string') throw new Error('mergePullRequest: pullRequestId is required');
        const found = findPullByGlobalId(forge, pullRequestId);
        if (!found) throw new Error(`Could not resolve to a PullRequest with the id of ${pullRequestId}`);
        const result = forge.mergePull(found.repo, found.pull);
        if ('error' in result) throw new Error(result.error);
        return node('MergePullRequestPayload', { pull: found.pull });
      }
      if (field === 'addComment') {
        const subjectId = input.subjectId;
        const body = input.body;
        if (typeof subjectId !== 'string' || typeof body !== 'string') throw new Error('addComment: subjectId and body are required');
        const found = findIssueByGlobalId(forge, subjectId);
        if (!found) throw new Error(`Could not resolve to an Issue with the id of ${subjectId}`);
        const comment = forge.addComment(found.repo, found.issue.number, body);
        if (!comment) throw new Error(`Could not resolve to an Issue with the id of ${subjectId}`);
        return node('AddCommentPayload', { comment, commentGlobalId: forge.commentGlobalId(found.repo, found.issue, comment) });
      }
      return null;
    }
    case 'Viewer': {
      const viewer = parent as Forge['viewer'];
      if (field === 'login') return viewer.login;
      if (field === 'id') return viewer.id;
      if (field === 'name') return viewer.name;
      return null;
    }
    case 'Repository': {
      const repo = parent as Repo;
      switch (field) {
        case 'id':
          return globalId('R', [repo.id]);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return node('RepositoryOwner', repo.owner);
        case 'defaultBranchRef': {
          const sha = forge.branchTip(repo, repo.defaultBranch);
          return sha === null ? null : node('Ref', repo.defaultBranch);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const issue = forge.getIssue(repo, number);
          return issue ? node('Issue', issue) : null;
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const fieldName = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
          const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
          let state = 'all';
          if (states !== null) {
            if (states.includes('OPEN') && !states.includes('CLOSED')) state = 'open';
            else if (states.includes('CLOSED') && !states.includes('OPEN')) state = 'closed';
          }
          const issues = forge.listIssues(repo, { state, sort: 'created', direction: direction === 'DESC' ? 'desc' : 'asc', page: 1, perPage: 100000 }).issues;
          void fieldName;
          const items: ConnectionItem[] = issues.map((issue) => ({ number: issue.number, nodeValue: node('Issue', issue) }));
          return buildConnection('IssueConnection', 'IssueEdge', items, args.first, args.after);
        }
        case 'pullRequests': {
          const pulls = forge.listPulls(repo, { state: 'all', page: 1, perPage: 100000 }).pulls;
          const items: ConnectionItem[] = pulls.map((pull) => ({ number: pull.number, nodeValue: node('PullRequest', pull) }));
          return buildConnection('PullRequestConnection', 'PullRequestEdge', items, args.first, args.after);
        }
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const pull = forge.getPull(repo, number);
          return pull ? node('PullRequest', pull) : null;
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = parent as Issue;
      switch (field) {
        case 'id':
          return globalId('I', [issue.repoId, issue.number]);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body ?? '';
        case 'url':
          return `https://github.com/issues/${issue.number}`;
        case 'createdAt':
          return '2026-11-14T00:00:00Z';
        case 'closed':
          return issue.state === 'closed';
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const pull = parent as PullRequest;
      switch (field) {
        case 'id':
          return globalId('P', [pull.repoId, pull.number]);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body ?? '';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          const repo = forge.findRepoById(pull.repoId);
          if (!repo || pull.merged || pull.state !== 'open') return 'UNKNOWN';
          return forge.mergeable(repo, pull);
        }
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'url':
          return `https://github.com/pulls/${pull.number}`;
        case 'files': {
          const repo = forge.findRepoById(pull.repoId);
          if (!repo) return buildConnection('PullRequestFileConnection', 'PullRequestFileEdge', [], args.first, args.after);
          const files = forge.pullFiles(repo, pull);
          const items: ConnectionItem[] = files.map((file, index) => ({
            number: index + 1,
            nodeValue: node('PullRequestFile', file.filename),
          }));
          return buildConnection('PullRequestFileConnection', 'PullRequestFileEdge', items, args.first, args.after);
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      const connection = parent as Record<string, unknown>;
      if (field === 'nodes') return connection.nodes as GqlValue[];
      if (field === 'edges') return connection.edges as GqlValue[];
      if (field === 'pageInfo') return connection.pageInfo as GqlValue;
      if (field === 'totalCount') return connection.totalCount as number;
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestFileEdge': {
      const edge = parent as Record<string, unknown>;
      if (field === 'node') return edge.node as GqlValue;
      if (field === 'cursor') return edge.cursor as string;
      return null;
    }
    case 'PageInfo': {
      const info = parent as Record<string, unknown>;
      if (field === 'hasNextPage') return info.hasNextPage as boolean;
      if (field === 'hasPreviousPage') return info.hasPreviousPage as boolean;
      if (field === 'startCursor') return info.startCursor as string | null;
      if (field === 'endCursor') return info.endCursor as string | null;
      return null;
    }
    case 'RepositoryOwner': {
      const owner = parent as string;
      if (field === 'login') return owner;
      if (field === 'id') return 1000;
      return null;
    }
    case 'Ref': {
      const name = parent as string;
      if (field === 'name') return name;
      return null;
    }
    case 'User': {
      const viewer = parent as Forge['viewer'];
      if (field === 'login') return viewer.login;
      if (field === 'id') return viewer.id;
      if (field === 'name') return viewer.name;
      return null;
    }
    case 'PullRequestFile': {
      const path = parent as string;
      if (field === 'path') return path;
      return null;
    }
    case 'IssueComment': {
      const comment = parent as { globalId: string; body: string };
      if (field === 'id') return comment.globalId;
      if (field === 'body') return comment.body;
      return null;
    }
    case '__Type': {
      const name = parent as string;
      if (field === 'name') return name;
      if (field === 'kind') return TYPE_KINDS[name] ?? 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name] ?? [];
        return fields.map((fieldName) => node('__Field', fieldName));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[name] ?? [];
        return values.map((value) => node('__EnumValue', value));
      }
      return null;
    }
    case '__Field': {
      const name = parent as string;
      if (field === 'name') return name;
      if (field === 'description') return null;
      if (field === 'type') return node('__Type', 'String');
      if (field === 'args') return [];
      return null;
    }
    case '__EnumValue': {
      const name = parent as string;
      if (field === 'name') return name;
      if (field === 'description') return null;
      return null;
    }
    case '__InputValue': {
      const name = parent as string;
      if (field === 'name') return name;
      if (field === 'description') return null;
      if (field === 'type') return node('__Type', 'String');
      return null;
    }
    case '__Schema': {
      if (field === 'types') return Object.keys(TYPE_FIELDS).map((typeName) => node('__Type', typeName));
      if (field === 'queryType') return node('__Type', 'Query');
      if (field === 'mutationType') return node('__Type', 'Mutation');
      return null;
    }
    default:
      return null;
  }
}

/** Payload fields on mutation results (createIssue.issue, closeIssue.issue, ...). */
function resolvePayload(typeName: string, payload: Record<string, unknown>, field: string, ctx: Ctx): GqlValue {
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field === 'issue') return node('Issue', payload.issue as Issue);
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return node('PullRequest', payload.pull as PullRequest);
  }
  if (typeName === 'AddCommentPayload') {
    if (field === 'commentEdge') {
      const comment = payload.comment as { body: string };
      return node('IssueEdge', {
        node: node('IssueComment', { globalId: payload.commentGlobalId as string, body: comment.body }),
        cursor: cursorFor(1),
      });
    }
  }
  void ctx;
  return null;
}

function executeSelections(typeName: string, parent: unknown, selections: Selection[], ctx: Ctx): Record<string, GqlValue> {
  const out: Record<string, GqlValue> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      Object.assign(out, executeSelections(typeName, parent, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, parent, selection.selections, ctx));
      }
      continue;
    }
    const fields = TYPE_FIELDS[typeName];
    if (fields !== undefined && !fields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    const args = argMap(selection.args, ctx);
    let value: GqlValue;
    if (typeName.endsWith('Payload')) {
      value = resolvePayload(typeName, parent as Record<string, unknown>, selection.name, ctx);
    } else {
      value = resolveField(typeName, parent, selection.name, args, ctx);
    }
    out[selection.alias] = executeValue(value, selection.selections, ctx);
  }
  return out;
}

function executeValue(value: GqlValue, selections: Selection[], ctx: Ctx): GqlValue {
  if (selections.length === 0) return value;
  if (isNode(value)) {
    return executeSelections(value.__typename, value.value, selections, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => executeValue(item, selections, ctx));
  }
  return value;
}

function executeOperation(document: Document, operation: Operation, variables: Record<string, unknown>, forge: Forge): { data: unknown; errors?: { message: string }[] } {
  const ctx: Ctx = { forge, variables: { ...variables }, errors: [], fragments: document.fragments };
  for (const varDef of operation.varDefs) {
    if (!(varDef.name in ctx.variables) && varDef.defaultValue !== null) {
      ctx.variables[varDef.name] = resolveValue(varDef.defaultValue, ctx);
    }
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelections(rootType, null, operation.selections, ctx);
    if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message }] };
  }
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one GraphQL operation (or a batch array). Returns the response body. */
export function handleGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  const requests: GraphQLRequest[] = Array.isArray(body) ? body : [body as GraphQLRequest];
  const results = requests.map((request) => {
    if (!request || typeof request !== 'object' || typeof request.query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL request must carry a query string.' }] };
    }
    let document: Document;
    try {
      document = new Parser(tokenize(request.query)).parseDocument();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: null, errors: [{ message }] };
    }
    if (document.operations.length === 0) {
      return { data: null, errors: [{ message: 'No operation in the document.' }] };
    }
    let operation = document.operations[0];
    if (document.operations.length > 1) {
      const named = document.operations.find((candidate) => candidate.name === request.operationName);
      if (!named) return { data: null, errors: [{ message: 'Multiple operations require an operationName.' }] };
      operation = named;
    }
    return executeOperation(document, operation, request.variables ?? {}, forge);
  });
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}
