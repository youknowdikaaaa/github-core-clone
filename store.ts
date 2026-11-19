// store.ts — the forge's in-memory store and business logic. No clocks, no randomness:
// every id and timestamp derives from counters, so two runs fed the same requests behave identically.

import {
  buildCommit,
  buildTreesFromFlat,
  collectReachable,
  countLineDiff,
  diffTrees,
  flattenTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  ZERO_OID,
  type FlatEntry,
  type FileChange,
  type GitObject,
} from './gitobj.ts';

export const DEFAULT_BRANCH = 'main';
const COMMIT_EPOCH = 1_700_000_000;
const FIXED_DATE = '2026-11-14T00:00:00Z';

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  objectSeq: Map<string, number>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssueNumber: number;
  nextPullNumber: number;
  seq: number;
}

export interface UserInfo {
  login: string;
  id: number;
  name: string;
  email: string;
}

export function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Forge {
  readonly viewer: UserInfo;
  readonly repos = new Map<string, Repo>();
  private idSeq = 1;
  private commitSeq = 0;
  private objectSeqCounter = 0;

  constructor(viewerLogin: string) {
    this.viewer = { login: viewerLogin, id: 1000, name: 'ada iversen', email: 'adaiversen@users.noreply.github.com' };
  }

  private nextId(): number {
    return this.idSeq++;
  }

  private serverIdentity(): { author: string; committer: string } {
    const ts = COMMIT_EPOCH + this.commitSeq++;
    const line = `${this.viewer.name} <${this.viewer.email}> ${ts} +0000`;
    return { author: line, committer: line };
  }

  private repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // -------------------------------------------------------------------------------- repos

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextId(),
      name,
      owner: this.viewer.login,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      objectSeq: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      seq: this.objectSeqCounter++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repo only when the owner is the token's login; another owner's same name is never visible. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === this.viewer.login)
      .sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------------- objects & refs

  storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.objectSeq.set(oid, this.objectSeqCounter++);
    }
    return oid;
  }

  storeObjects(repo: Repo, objects: ReadonlyMap<string, GitObject> | readonly GitObject[]): void {
    const list = Array.isArray(objects) ? objects : [...objects.values()];
    for (const object of list) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, { type: object.type, data: object.data });
        repo.objectSeq.set(oid, this.objectSeqCounter++);
      }
    }
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, a full ref, or a raw oid to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const branchRef = `refs/heads/${ref}`;
    if (repo.refs.has(branchRef)) return repo.refs.get(branchRef)!;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Ancestors of a commit (itself included), via parent links. */
  ancestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  /** Is `ancestor` an ancestor of `descendant` (or equal)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(repo, descendant).has(ancestor);
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = this.ancestors(repo, a);
    if (aAncestors.has(b)) return b;
    // Breadth-first from b, preferring newer commits, so the first hit is the nearest common ancestor.
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      // Newer parents first (higher insertion sequence).
      parents.sort((x, y) => (repo.objectSeq.get(y) ?? 0) - (repo.objectSeq.get(x) ?? 0));
      for (const parent of parents) queue.push(parent);
    }
    return null;
  }

  /** Commits reachable from a tip, newest first (by insertion sequence). */
  listCommits(repo: Repo, tip: string): string[] {
    const set = this.ancestors(repo, tip);
    return [...set].sort((a, b) => (repo.objectSeq.get(b) ?? 0) - (repo.objectSeq.get(a) ?? 0));
  }

  headCommitOfBranch(repo: Repo, branch: string): string | null {
    return this.branchTip(repo, branch);
  }

  // -------------------------------------------------------------------------------- contents commits

  private makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const { author, committer } = this.serverIdentity();
    const data = buildCommit({ tree: treeOid, parents, author, committer, message });
    return this.storeObject(repo, 'commit', data);
  }

  /**
   * Write (create/update) one file on a branch through the contents API.
   * Returns the new commit and blob shas, or an error string:
   *   'stale' (sha given but does not match the current blob), 'exists' (file exists, no sha given).
   */
  putContent(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; blobSha: string } | { error: string } {
    let tip = this.branchTip(repo, branch);
    if (tip === null) {
      // A missing branch starts at the default branch's tip (or unborn).
      tip = this.branchTip(repo, repo.defaultBranch);
      if (tip !== null) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const baseTree = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const flat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo.objects, baseTree);
    const current = flat.get(path);
    if (expectedSha !== undefined) {
      if (!current || current.oid.toLowerCase() !== expectedSha.toLowerCase()) return { error: 'stale' };
    } else if (current) {
      return { error: 'exists' };
    }
    const blobSha = this.storeObject(repo, 'blob', content);
    flat.set(path, { oid: blobSha, mode: '100644' });
    const { rootOid, trees } = buildTreesFromFlat(flat);
    for (const [oid, object] of trees) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        repo.objectSeq.set(oid, this.objectSeqCounter++);
      }
    }
    const commitSha = this.makeCommit(repo, rootOid, tip === null ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete one file on a branch. Returns the new commit sha, or an error string. */
  deleteContent(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | { error: string } {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return { error: 'not-found' };
    const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const flat = flattenTree(repo.objects, baseTree);
    if (!flat.has(path)) return { error: 'not-found' };
    flat.delete(path);
    const { rootOid, trees } = buildTreesFromFlat(flat);
    for (const [oid, object] of trees) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        repo.objectSeq.set(oid, this.objectSeqCounter++);
      }
    }
    const commitSha = this.makeCommit(repo, rootOid, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Read a file or directory at a ref. Returns null when the ref or the path does not exist. */
  readContent(
    repo: Repo,
    ref: string,
    path: string,
  ):
    | { kind: 'file'; blobSha: string; data: Buffer }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    if (path === '' || path === '/') {
      return { kind: 'dir', entries: this.dirEntries(repo, treeOid, '') };
    }
    const flat = flattenTree(repo.objects, treeOid);
    const file = flat.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob) return null;
      return { kind: 'file', blobSha: file.oid, data: blob.data };
    }
    // A directory: walk the tree to the sub-tree for this path.
    const segments = path.split('/');
    let currentOid = treeOid;
    for (const segment of segments) {
      const object = repo.objects.get(currentOid);
      if (!object || object.type !== 'tree') return null;
      const entries = parseTree(object.data);
      const found = entries.find((entry) => entry.name === segment);
      if (!found || found.mode !== '40000') return null;
      currentOid = found.oid;
    }
    return { kind: 'dir', entries: this.dirEntries(repo, currentOid, path) };
  }

  private dirEntries(repo: Repo, treeOid: string, prefix: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    const entries = parseTree(object.data);
    return entries
      .map((entry) => ({
        type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: entry.name,
        path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        sha: entry.oid,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // -------------------------------------------------------------------------------- labels & issues

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextId(), name, color: color === '' ? 'ededed' : color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string; label: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: 'bad-label', label: name };
    }
    const issue: Issue = {
      id: this.nextId(),
      repoId: repo.id,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      seq: this.objectSeqCounter++,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(
    repo: Repo,
    options: { state: string; sort: string; direction: string; page: number; perPage: number },
  ): { issues: Issue[]; total: number } {
    let list = [...repo.issues];
    if (options.state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (options.state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => (options.direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const total = list.length;
    const start = (options.page - 1) * options.perPage;
    return { issues: list.slice(start, start + options.perPage), total };
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined {
    const issue = this.getIssue(repo, number);
    if (!issue) return undefined;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): IssueComment | undefined {
    const issue = this.getIssue(repo, number);
    if (!issue) return undefined;
    const comment: IssueComment = { id: this.nextId(), body, seq: this.objectSeqCounter++ };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null || baseSha === null) return { error: 'unknown-branch' };
    if (head === base) return { error: 'same-branch' };
    const duplicate = repo.pulls.find((pr) => pr.headRef === head && pr.baseRef === base && pr.state === 'open');
    if (duplicate) return { error: 'duplicate' };
    const pr: PullRequest = {
      id: this.nextId(),
      repoId: repo.id,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      seq: this.objectSeqCounter++,
    };
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pr) => pr.number === number);
  }

  listPulls(repo: Repo, options: { state: string; page: number; perPage: number }): { pulls: PullRequest[]; total: number } {
    let list = [...repo.pulls];
    if (options.state === 'open') list = list.filter((pr) => pr.state === 'open');
    else if (options.state === 'closed') list = list.filter((pr) => pr.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    const total = list.length;
    const start = (options.page - 1) * options.perPage;
    return { pulls: list.slice(start, start + options.perPage), total };
  }

  pullHeadSha(repo: Repo, pr: PullRequest): string | null {
    return this.branchTip(repo, pr.headRef);
  }

  pullBaseSha(repo: Repo, pr: PullRequest): string | null {
    return this.branchTip(repo, pr.baseRef);
  }

  /** The changed files of a pull request: merge-base tree vs head tree, with line counts. */
  pullFiles(repo: Repo, pr: PullRequest): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headSha = this.pullHeadSha(repo, pr);
    const baseSha = this.pullBaseSha(repo, pr);
    if (headSha === null || baseSha === null) return [];
    const base = this.mergeBase(repo, headSha, baseSha);
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    const changes = diffTrees(repo.objects, baseTree, headTree);
    return changes.map((change) => {
      let additions = 0;
      let deletions = 0;
      if (change.status === 'added' && change.newOid !== null) {
        const blob = repo.objects.get(change.newOid);
        const text = blob ? blob.data.toString('utf8') : '';
        const lines = text === '' ? [] : text.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        additions = lines.length;
      } else if (change.status === 'removed' && change.oldOid !== null) {
        const blob = repo.objects.get(change.oldOid);
        const text = blob ? blob.data.toString('utf8') : '';
        const lines = text === '' ? [] : text.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        deletions = lines.length;
      } else if (change.status === 'modified' && change.oldOid !== null && change.newOid !== null) {
        const oldBlob = repo.objects.get(change.oldOid);
        const newBlob = repo.objects.get(change.newOid);
        const counts = countLineDiff(oldBlob ? oldBlob.data.toString('utf8') : '', newBlob ? newBlob.data.toString('utf8') : '');
        additions = counts.additions;
        deletions = counts.deletions;
      }
      return {
        filename: change.path,
        status: change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  /** Three-way merge of base/ours/theirs trees. Returns the merged tree oid, or null on conflict. */
  threeWayMerge(repo: Repo, baseTreeOid: string | null, oursTreeOid: string, theirsTreeOid: string): { treeOid: string } | null {
    const base = baseTreeOid === null ? new Map<string, FlatEntry>() : flattenTree(repo.objects, baseTreeOid);
    const ours = flattenTree(repo.objects, oursTreeOid);
    const theirs = flattenTree(repo.objects, theirsTreeOid);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, FlatEntry>();
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const bOid = b?.oid ?? null;
      const oOid = o?.oid ?? null;
      const tOid = t?.oid ?? null;
      if (oOid === tOid) {
        if (o !== undefined) merged.set(path, o);
      } else if (bOid === oOid) {
        if (t !== undefined) merged.set(path, t);
      } else if (bOid === tOid) {
        if (o !== undefined) merged.set(path, o);
      } else {
        return null;
      }
    }
    const { rootOid, trees } = buildTreesFromFlat(merged);
    for (const [oid, object] of trees) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        repo.objectSeq.set(oid, this.objectSeqCounter++);
      }
    }
    return { treeOid: rootOid };
  }

  /** Whether a pull request merges cleanly right now. */
  mergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    const headSha = this.pullHeadSha(repo, pr);
    const baseSha = this.pullBaseSha(repo, pr);
    if (headSha === null || baseSha === null) return 'UNKNOWN';
    const base = this.mergeBase(repo, headSha, baseSha);
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const baseTreeNow = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    // A dry-run three-way merge against the CURRENT base tip: if it conflicts, the PR is conflicted.
    const probe = this.threeWayMergeDry(repo, baseTree, baseTreeNow, headTree);
    return probe ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** The three-way merge decision without writing objects. */
  private threeWayMergeDry(repo: Repo, baseTreeOid: string | null, oursTreeOid: string, theirsTreeOid: string): boolean {
    const base = baseTreeOid === null ? new Map<string, FlatEntry>() : flattenTree(repo.objects, baseTreeOid);
    const ours = flattenTree(repo.objects, oursTreeOid);
    const theirs = flattenTree(repo.objects, theirsTreeOid);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const bOid = base.get(path)?.oid ?? null;
      const oOid = ours.get(path)?.oid ?? null;
      const tOid = theirs.get(path)?.oid ?? null;
      if (oOid === tOid) continue;
      if (bOid === oOid) continue;
      if (bOid === tOid) continue;
      return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha,
   * or an error string: 'conflict', 'already-merged', 'unknown-branch'.
   */
  mergePull(repo: Repo, pr: PullRequest): { mergeSha: string } | { error: string } {
    if (pr.state !== 'open') return { error: pr.merged ? 'already-merged' : 'not-open' };
    const headSha = this.pullHeadSha(repo, pr);
    const baseSha = this.pullBaseSha(repo, pr);
    if (headSha === null || baseSha === null) return { error: 'unknown-branch' };
    const base = this.mergeBase(repo, headSha, baseSha);
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const baseTreeNow = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    const merged = this.threeWayMerge(repo, baseTree, baseTreeNow, headTree);
    if (merged === null) return { error: 'conflict' };
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
    const mergeSha = this.makeCommit(repo, merged.treeOid, [baseSha], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_DATE;
    pr.mergeCommitSha = mergeSha;
    return { mergeSha };
  }

  // -------------------------------------------------------------------------------- global ids

  repoGlobalId(repo: Repo): string {
    return globalId('R', [repo.id]);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('I', [repo.id, issue.number]);
  }

  pullGlobalId(repo: Repo, pr: PullRequest): string {
    return globalId('P', [repo.id, pr.number]);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return globalId('C', [repo.id, issue.number, comment.id]);
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** The commit message as the REST API renders it (no trailing newline). */
  static restMessage(message: string): string {
    return message.replace(/\n+$/, '');
  }
}

/** Whether `value` is an error return ({ error: string }). */
export function isError<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value && typeof (value as { error: unknown }).error === 'string';
}

// -------------------------------------------------------------------------------- REST shapes

export function restRepo(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: forge.viewer.id, type: 'User' },
    fork: false,
    has_issues: true,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

export function restLabel(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color };
}

export function restIssue(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? restLabel(label) : { name };
    }),
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

export function restComment(forge: Forge, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

export function restPull(forge: Forge, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = forge.pullHeadSha(repo, pr);
  const baseSha = forge.pullBaseSha(repo, pr);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: forge.mergeable(repo, pr) === 'MERGEABLE',
    head: { ref: pr.headRef, sha: headSha ?? ZERO_OID, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: baseSha ?? ZERO_OID, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

export { collectReachable, peelToCommit, parseCommit, parseTag };
