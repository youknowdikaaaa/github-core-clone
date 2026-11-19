// rest.ts — GitHub REST v3 API under /api/v3. All replies are JSON with X-GitHub-Request-Id
// (set by app.ts); errors are {"message": string}.

import { type Forge, type Repo, restRepo, restIssue, restComment, restLabel, restPull } from './store.ts';
import { parseCommit } from './gitobj.ts';

export interface RestRequest {
  method: string;
  /** URL-decoded path segments under /api/v3 (e.g. ['repos','adaiversen','x','issues']). */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyPresent: boolean;
  origin: string;
}

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  /** null → empty body (used for 204). */
  body: unknown;
}

type Json = Record<string, unknown>;

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, headers, body };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Json | null {
  return isObject(value) ? value : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Link headers for a paginated list with a known total. */
function pageLinks(total: number, query: URLSearchParams, origin: string, basePath: string): Record<string, string> {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const build = (p: number): string => {
    const url = new URL(basePath, origin);
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    url.search = params.toString();
    return url.toString();
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  return { link: links.join(', ') };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, basePath: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { page: slice, headers: pageLinks(items.length, query, origin, basePath) };
}

/** A repo lookup: owner must be the token's login; anything else is 404 (never 403). */
function lookupRepo(forge: Forge, owner: string, repoName: string): Repo | null {
  if (owner !== forge.viewer.login) return null;
  return forge.getRepo(owner, repoName) ?? null;
}

export function handleRest(forge: Forge, req: RestRequest): RestResult {
  const segments = req.segments;
  const method = req.method;

  // GET /api/v3/ and /api/v3/meta and /api/v3/user
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {}, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    const viewer = forge.viewer;
    return ok(200, {
      login: viewer.login,
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      type: 'User',
      html_url: `https://github.com/${viewer.login}`,
    });
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length !== 2) return err(404, 'Not Found');
    if (method === 'GET') {
      const repos = forge.listViewerRepos().map((repo) => restRepo(forge, repo));
      const { page, headers } = paginate(repos, req.query, req.origin, '/api/v3/user/repos');
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const body = asObject(req.body);
      const name = body ? str(body.name) : undefined;
      if (!name) return err(422, 'name is required');
      if (forge.getRepo(forge.viewer.login, name)) return err(422, 'Repository already exists');
      const repo = forge.createRepo(name, body?.private === true, str(body?.description) ?? '');
      if (!repo) return err(422, 'Repository already exists');
      return ok(201, restRepo(forge, repo));
    }
    return err(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = segments[1];
  const repoName = segments[2];
  const repo = lookupRepo(forge, owner, repoName);
  if (!repo) return err(404, 'Not Found');
  const rest = segments.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, restRepo(forge, repo));
    if (method === 'PATCH') {
      const body = asObject(req.body);
      const description = body ? str(body.description) : undefined;
      if (description !== undefined) repo.description = description;
      const defaultBranch = body ? str(body.default_branch) : undefined;
      if (defaultBranch !== undefined && repo.refs.has(`refs/heads/${defaultBranch}`)) repo.defaultBranch = defaultBranch;
      return ok(200, restRepo(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0];

  // ---- branches -----------------------------------------------------------
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      return ok(
        200,
        forge.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
      );
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === null) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  // ---- commits ------------------------------------------------------------
  if (head === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return err(404, 'Not Found');
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveRef(repo, ref);
    if (tip === null) return ok(200, []);
    const commits = forge.listCommits(repo, tip).map((oid) => {
      const object = repo.objects.get(oid);
      const message = object && object.type === 'commit' ? parseCommit(object.data).message.replace(/\n+$/, '') : '';
      return { sha: oid, commit: { message } };
    });
    const { page } = paginate(commits, req.query, req.origin, `/api/v3/repos/${owner}/${repoName}/commits`);
    return ok(200, page);
  }

  // ---- git/refs -----------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = asObject(req.body);
      const ref = body ? str(body.ref) : undefined;
      const sha = body ? str(body.sha) : undefined;
      if (!ref || !sha) return err(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === null) return err(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  // ---- contents -----------------------------------------------------------
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (path === '') return err(404, 'Not Found');
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const read = forge.readContent(repo, ref, path);
      if (read === null) return err(404, 'Not Found');
      if (read.kind === 'file') {
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: read.data.length,
          name: path.split('/').pop(),
          path,
          content: read.data.toString('base64'),
          sha: read.blobSha,
        });
      }
      return ok(200, read.entries);
    }
    if (method === 'PUT') {
      const body = asObject(req.body);
      if (!body) return err(400, 'Invalid JSON');
      const content = str(body.content);
      if (content === undefined) return err(422, 'content is required');
      const data = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const branch = req.query.get('branch') ?? str(body.branch) ?? repo.defaultBranch;
      const existing = forge.readContent(repo, branch, path);
      const result = forge.putContent(repo, branch, path, data, str(body.message) ?? '', str(body.sha));
      if ('error' in result) {
        if (result.error === 'stale') return err(409, 'sha does not match');
        return err(422, 'file already exists; provide sha');
      }
      return ok(existing === null ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.blobSha, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha, message: str(body.message) ?? '' },
      });
    }
    if (method === 'DELETE') {
      const body = asObject(req.body);
      const branch = req.query.get('branch') ?? (body ? str(body.branch) ?? repo.defaultBranch : repo.defaultBranch);
      const result = forge.deleteContent(repo, branch, path, body ? str(body.message) ?? '' : '');
      if ('error' in result) return err(404, 'Not Found');
      return ok(200, { commit: { sha: result.commitSha } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels -------------------------------------------------------------
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = asObject(req.body);
      const name = body ? str(body.name) : undefined;
      if (!name) return err(422, 'name is required');
      const label = forge.createLabel(repo, name, body ? str(body.color) ?? 'ededed' : 'ededed');
      return ok(201, restLabel(label));
    }
    return err(404, 'Not Found');
  }

  // ---- issues -------------------------------------------------------------
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = asObject(req.body);
        const title = body ? str(body.title) : undefined;
        if (!title) return err(422, 'title is required');
        const labels = Array.isArray(body?.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
        const result = forge.createIssue(repo, title, str(body?.body) ?? '', labels);
        if ('error' in result) return err(422, `unknown label: ${result.label}`);
        return ok(201, restIssue(forge, repo, result));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        const { page, perPage } = pageParams(req.query);
        const { issues, total } = forge.listIssues(repo, { state, sort, direction, page, perPage });
        const headers = pageLinks(total, req.query, req.origin, `/api/v3/repos/${owner}/${repoName}/issues`);
        return ok(200, issues.map((issue) => restIssue(forge, repo, issue)), headers);
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1], 10);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const issue = forge.getIssue(repo, number);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!issue) return err(404, 'Not Found');
        return ok(200, restIssue(forge, repo, issue));
      }
      if (method === 'PATCH') {
        if (!issue) return err(404, 'Not Found');
        const body = asObject(req.body) ?? {};
        const updated = forge.patchIssue(repo, number, body);
        if (!updated) return err(404, 'Not Found');
        return ok(200, restIssue(forge, repo, updated));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'POST') {
        const body = asObject(req.body);
        const text = body ? str(body.body) : undefined;
        if (!text) return err(422, 'body is required');
        const comment = forge.addComment(repo, number, text);
        if (!comment) return err(404, 'Not Found');
        return ok(201, restComment(forge, comment));
      }
      if (method === 'GET') {
        const { page } = paginate(
          issue.comments.map((comment) => restComment(forge, comment)),
          req.query,
          req.origin,
          `/api/v3/repos/${owner}/${repoName}/issues/${number}/comments`,
        );
        return ok(200, page);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pulls --------------------------------------------------------------
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = asObject(req.body);
        const title = body ? str(body.title) : undefined;
        const headBranch = body ? str(body.head) : undefined;
        const baseBranch = body ? str(body.base) : undefined;
        if (!title || !headBranch || !baseBranch) return err(422, 'title, head and base are required');
        const result = forge.createPull(repo, title, str(body?.body) ?? '', headBranch, baseBranch);
        if ('error' in result) return err(422, result.error);
        return ok(201, restPull(forge, repo, result));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const { page, perPage } = pageParams(req.query);
        const { pulls, total } = forge.listPulls(repo, { state, page, perPage });
        const headers = pageLinks(total, req.query, req.origin, `/api/v3/repos/${owner}/${repoName}/pulls`);
        return ok(200, pulls.map((pull) => restPull(forge, repo, pull)), headers);
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1], 10);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pull = forge.getPull(repo, number);
    if (rest.length === 2) {
      if (method !== 'GET') return err(404, 'Not Found');
      if (!pull) return err(404, 'Not Found');
      return ok(200, restPull(forge, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (!pull) return err(404, 'Not Found');
      return ok(200, forge.pullFiles(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return err(404, 'Not Found');
      if (!pull) return err(404, 'Not Found');
      const result = forge.mergePull(repo, pull);
      if ('error' in result) {
        if (result.error === 'conflict') return err(405, 'merge conflict');
        return err(409, result.error);
      }
      return ok(200, {
        sha: result.mergeSha,
        merged: true,
        message: `Merge pull request #${number} from ${repo.owner}/${pull.headRef}`,
      });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
