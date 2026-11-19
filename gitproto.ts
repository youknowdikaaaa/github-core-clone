// gitproto.ts — git smart HTTP: info/refs advertisements (v2 + v0), ls-refs, fetch (v2 + v0)
// and receive-pack. Implements the wire exactly as sdk/conformance/git-client.ts speaks it.

import {
  ZERO_OID,
  collectReachable,
  collectReachableStoppingAt,
  decodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  splitCommands,
  writePack,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './gitobj.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';

const AGENT = 'git-core-clone/1.0';
const UPLOAD_CAPS_V0 = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS_V0 = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function json404(): HttpResult {
  return { status: 404, contentType: 'application/json', body: buf(JSON.stringify({ message: 'Not Found' })) };
}

function json400(message: string): HttpResult {
  return { status: 400, contentType: 'application/json', body: buf(JSON.stringify({ message })) };
}

/** All refs of a repo, sorted by name, with peeled targets for annotated tags. */
function repoRefList(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      entry.peeled = peelToCommit(repo.objects, oid);
    }
    out.push(entry);
  }
  return out;
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// -------------------------------------------------------------------------------- advertisements

function v2Advertisement(): Buffer {
  const lines = [
    `# service=git-upload-pack\n`,
    `version 2\n`,
    `ls-refs=unborn\n`,
    `fetch=shallow\n`,
    `agent=${AGENT}\n`,
    `object-format=sha1\n`,
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const tip = defaultTip(repo);
  const refs = repoRefList(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = tip ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolVersion2: boolean,
): HttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json404();
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return json404();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocolVersion2) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack') };
}

// -------------------------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: Repo, packets: { kind: string; payload: Buffer }[]): HttpResult {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  const refs = repoRefList(repo);
  if (refs.length === 0) {
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (keep('HEAD') && symrefs && tip !== null) {
      parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Walk `wants` (commits; tags peel to their commit) to a depth limit. Returns included commit oids. */
function walkDepth(repo: Repo, wantCommits: readonly string[], depth: number): Set<string> {
  const included = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const oid of wantCommits) {
    if (!distance.has(oid)) {
      distance.set(oid, 0);
      queue.push(oid);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const dist = distance.get(oid)!;
    if (dist >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    for (const parent of parseCommit(object.data).parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  return included;
}

function computeFetch(repo: Repo, args: FetchArgs): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const objects = repo.objects;
  // The have-closure stops at the client's shallow boundaries: the client holds those
  // commits but not their ancestors, so their ancestors must still be sendable (deepen).
  const haveClosure = collectReachableStoppingAt(objects, args.haves, new Set(args.shallow));
  const wantTags: string[] = [];
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const object = objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      wantTags.push(want);
      wantCommits.push(peelToCommit(objects, want));
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  let send = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth === null) {
    send = collectReachable(objects, [...wantTags, ...wantCommits]);
  } else {
    const included = walkDepth(repo, wantCommits, args.depth);
    // The included commits plus their trees, plus any wanted tag objects.
    const seeds = [...included, ...wantTags];
    for (const oid of seeds) {
      const object = objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        send.add(oid);
        for (const next of collectReachable(objects, [parseCommit(object.data).tree])) send.add(next);
      } else {
        send.add(oid);
      }
    }
    // Boundary: included commits with a parent outside (haveClosure ∪ included).
    for (const oid of included) {
      const object = objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !haveClosure.has(parent) && !included.has(parent));
      if (cut) shallow.push(oid);
    }
    // Unshallow: an old boundary whose parents are all present now.
    for (const old of args.shallow) {
      const object = objects.get(old);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => haveClosure.has(parent) || included.has(parent))) unshallow.push(old);
    }
  }
  for (const oid of haveClosure) send.delete(oid);
  const out = new Map<string, GitObject>();
  for (const oid of send) {
    const object = objects.get(oid);
    if (object) out.set(oid, object);
  }
  return { objects: out, shallow, unshallow };
}

/** Sideband-wrap pack bytes: band-1 packets of at most 65515 data bytes each. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function packFromObjects(objects: Map<string, GitObject>): Buffer {
  const list = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, object]) => object);
  return writePack(list);
}

function handleFetchV2(repo: Repo, packets: { kind: string; payload: Buffer }[]): HttpResult {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const pack = packFromObjects(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const knownHave = args.haves.find((have) => repo.objects.has(have));
  if (knownHave !== undefined) {
    parts.push(pktLine(`ACK ${knownHave}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(repo: Repo, packets: { kind: string; payload: Buffer }[]): HttpResult {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const pack = packFromObjects(objects);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const knownHave = args.haves.find((have) => repo.objects.has(have));
  if (knownHave !== undefined) parts.push(pktLine(`ACK ${knownHave}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleUploadPack(forge: Forge, owner: string, repoName: string, body: Buffer, gitProtocolVersion2: boolean): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return json404();
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command === 'command=ls-refs') {
    if (!gitProtocolVersion2) return json400('ls-refs needs protocol v2');
    return handleLsRefs(repo, packets);
  }
  if (command === 'command=fetch') {
    if (!gitProtocolVersion2) return json400('fetch v2 needs protocol v2');
    return handleFetchV2(repo, packets);
  }
  // v0 fetch: the first data line is a want line.
  if (command.startsWith('want ')) return handleFetchV0(repo, packets);
  return json400('unknown upload-pack command');
}

// -------------------------------------------------------------------------------- receive-pack

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return json404();
  let split;
  try {
    split = splitCommands(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sideband = false;
  let reportV2 = false;
  for (const packet of split.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    let caps = '';
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) return json400('bad receive-pack command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    if (caps !== '') {
      const capSet = new Set(caps.trim().split(/\s+/));
      if (capSet.has('side-band-64k')) sideband = true;
      if (capSet.has('report-status-v2')) reportV2 = true;
    }
  }
  void reportV2;
  if (commands.length === 0) return json400('no receive-pack commands');

  // Unpack first: a refused update must still unpack (the non-fast-forward check requires it).
  const packBytes = split.rest;
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      forge.storeObjects(repo, read.objects);
      if (!read.checksumOk) unpackError = 'pack checksum mismatch';
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let ok = false;
      let reason = '';
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
        reason = 'invalid object id';
      } else if (command.oldOid !== current) {
        reason = 'invalid old value';
      } else if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) reason = 'ref does not exist';
        else {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== ZERO_OID) reason = 'already exists';
        else if (!repo.objects.has(command.newOid)) reason = 'missing object';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else {
        if (!repo.objects.has(command.newOid)) reason = 'missing object';
        else if (command.newOid === command.oldOid) ok = true;
        else if (forge.isAncestor(repo, command.oldOid, command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        } else {
          reason = 'non-fast-forward';
        }
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
  }

  const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
  let bodyOut: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    if (report.length === 0) {
      parts.push(pktLine(Buffer.from([1])));
    } else {
      for (let offset = 0; offset < report.length; offset += CHUNK) {
        const chunk = report.subarray(offset, Math.min(report.length, offset + CHUNK));
        parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
    }
    parts.push(PKT_FLUSH);
    bodyOut = Buffer.concat(parts);
  } else {
    bodyOut = Buffer.concat([report, PKT_FLUSH]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

export { hashObject };
