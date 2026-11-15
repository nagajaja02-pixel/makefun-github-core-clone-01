// git smart HTTP, implemented from the protocol itself on node:zlib and
// node:crypto: no git binary, no vendored library. upload-pack speaks protocol
// v2 (and v0 when the client does not ask for v2); receive-pack is v0 only.
// Packs are written without deltas; packs read back resolve both ofs-delta and
// ref-delta entries.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

export const AGENT = 'github-core-clone/1.0';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Decode a whole pkt-line stream into packets (flush/delim/end included). */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

// ---------------------------------------------------------------- packfile

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type] as number;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, no deltas) from plain objects. */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos] as number, pos += 1;
      if (op & 0x02) offset |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x04) offset |= (delta[pos] as number) << 16, pos += 1;
      if (op & 0x08) offset |= (delta[pos] as number) << 24, pos += 1;
      if (op & 0x10) size = delta[pos] as number, pos += 1;
      if (op & 0x20) size |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x40) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Adler-32, the checksum a zlib stream ends with. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * How many input bytes the zlib stream at `start` consumes. The fast path
 * re-deflates the inflated bytes (Node's deflate is deterministic for the same
 * input and options, and the suite writes packs with the same defaults) and
 * verifies the trailing Adler-32; the fallback binary-searches with the same
 * Adler check, so a wrong guess can never slip through.
 */
function zlibStreamLength(pack: Buffer, start: number, data: Buffer): number {
  const adler = adler32(data);
  const guess = deflateSync(data).length;
  if (start + guess <= pack.length && pack.readUInt32BE(start + guess - 4) === adler) return guess;
  let lo = 1;
  let hi = pack.length - start;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const trial = inflateSync(pack.subarray(start, start + mid));
      ok = trial.length === data.length && trial.equals(data) && pack.readUInt32BE(start + mid - 4) === adler;
    } catch {
      ok = false;
    }
    if (ok) {
      found = mid;
      hi = mid - 1;
    } else {
      // A too-short prefix throws; a too-long one inflates fine but its
      // trailing bytes are not this stream's Adler-32. Either way, test
      // whether the prefix is at least long enough to inflate.
      let inflates = false;
      try {
        inflates = inflateSync(pack.subarray(start, start + mid)).length === data.length;
      } catch {
        inflates = false;
      }
      if (inflates) hi = mid - 1;
      else lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('could not bound a pack object stream');
  return found;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/** Read a packfile, resolving ofs-delta and ref-delta entries. */
export function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    // Object header varint: type in bits 4-6 of the first byte, size low 4 bits.
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: GitObjectType | null = CODE_TYPE[typeCode] ?? null;
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      // ofs-delta: base offset encoded backwards.
      byte = pack[offset] as number;
      offset += 1;
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - base;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (type === null) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const data = inflateSync(pack.subarray(offset));
    if (data.length !== size) throw new Error('pack object size mismatch');
    offset += zlibStreamLength(pack, offset, data);
    if (typeCode === 6 || typeCode === 7) {
      const base =
        baseOffset !== null
          ? byOffset.get(baseOffset)
          : baseOid !== null
            ? lookup(baseOid) ?? entries.find((e) => e.oid === baseOid)
            : undefined;
      if (!base) throw new Error('delta base is missing');
      const resolved = applyDelta(base.data, data);
      const entry: PackEntry = { type: base.type, data: resolved, oid: hashObject(base.type, resolved) };
      entries.push(entry);
      byOffset.set(entryStart, entry);
    } else {
      const entry: PackEntry = { type: type as GitObjectType, data, oid: hashObject(type as GitObjectType, data) };
      entries.push(entry);
      byOffset.set(entryStart, entry);
    }
  }
  return entries;
}

// ---------------------------------------------------------------- advertisements

const V0_UPLOAD_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow agent=' + AGENT;
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v0 ref advertisement body for a service. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n`);
  } else {
    const symref = service === 'git-upload-pack' ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${head} HEAD\0${caps}${symref}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(oid, (o) => repo.objects.get(o));
        if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
}

/** The v2 capability advertisement body. */
export function advertisementV2(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------- fetch selection

export interface FetchSelection {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects to send for a fetch: the closure of `wants` (depth-limited when
 * `depth` is set), minus the objects the client already holds (the closure of
 * `haves`, truncated at the client's shallow boundaries).
 */
export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(shallowBoundaries);

  // What the client already holds: haves, not crossing a shallow boundary.
  const held = new Set<string>();
  {
    const queue: string[] = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  // The wanted closure, with an optional depth limit (commit generations).
  const wanted = new Set<string>();
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    for (const oid of collectReachable(wants, lookup, { allowMissing: true })) wanted.add(oid);
  } else {
    // BFS over commit parents from the wants, tracking generations.
    const commitDepth = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = [];
    for (const want of wants) {
      const object = lookup(want);
      if (!object) continue;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = lookup(target);
        if (targetObject?.type === 'commit') queue.push({ oid: target, d: 0 });
        wanted.add(want);
        continue;
      }
      if (object.type === 'commit') queue.push({ oid: want, d: 0 });
      else wanted.add(want);
    }
    const boundary = new Set<string>();
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (commitDepth.has(oid)) continue;
      commitDepth.set(oid, d);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (d === depth - 1) {
        if (commit.parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, d: d + 1 });
    }
    // Wanted = the tree closure of commits within the depth, plus the commits
    // themselves; commits deeper than depth - 1 are excluded.
    wanted.clear();
    for (const [oid, d] of commitDepth.entries()) {
      if (d > depth - 1) continue;
      wanted.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      // Tree closure only (no parents).
      const treeQueue = [commit.tree];
      while (treeQueue.length > 0) {
        const treeOid = treeQueue.pop() as string;
        if (wanted.has(treeOid)) continue;
        const treeObject = lookup(treeOid);
        if (!treeObject) continue;
        wanted.add(treeOid);
        if (treeObject.type === 'tree') {
          for (const entry of parseTree(treeObject.data)) {
            if (entry.mode !== '160000') treeQueue.push(entry.oid);
          }
        }
      }
    }
    for (const oid of boundary) newShallow.push(oid);
    for (const old of shallowSet) {
      if (commitDepth.has(old) && !boundary.has(old)) unshallow.push(old);
    }
  }

  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of [...wanted].sort()) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: newShallow.sort(), unshallow: unshallow.sort() };
}

/** Wrap pack bytes in sideband band-1 pkt-lines. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

export interface UploadPackRequest {
  command: 'ls-refs' | 'fetch' | null;
  args: string[];
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse an upload-pack POST body (pkt-lines) into a request. */
export function parseUploadPack(body: Buffer): UploadPackRequest {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const req: UploadPackRequest = { command: null, args: [], wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('command=')) {
      req.command = text.slice('command='.length) as 'ls-refs' | 'fetch';
      continue;
    }
    if (text === '') {
      inArgs = true;
      continue;
    }
    if (req.command === 'ls-refs') {
      req.args.push(text);
      continue;
    }
    if (req.command === 'fetch') {
      if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) req.depth = parseInt(text.slice(7).trim(), 10);
      else if (text.startsWith('deepen-since ')) req.depth = null;
      else req.args.push(text);
      continue;
    }
    // v0 fetch: want/have lines directly.
    if (text.startsWith('want ')) req.wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = parseInt(text.slice(7).trim(), 10);
    else req.args.push(text);
  }
  void inArgs;
  return req;
}

/** Answer an ls-refs command. */
export function answerLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Array<string | 'flush'> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headIncluded = keep('HEAD');
  if (headIncluded) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (symrefs && name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(oid, (o) => repo.objects.get(o));
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
}

/** Answer a v2 fetch command. */
export function answerFetchV2(repo: Repo, req: UploadPackRequest): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments: only when the client sent haves (a fresh clone sends
  // none, and git expects the packfile section straight away then).
  if (req.haves.length > 0) {
    const ackLines: string[] = ['acknowledgments\n'];
    let known = 0;
    for (const have of req.haves) {
      if (repo.objects.has(have)) {
        ackLines.push(`ACK ${have}\n`);
        known += 1;
      }
    }
    if (known === 0) ackLines.push('NAK\n');
    else ackLines.push('ready\n');
    parts.push(pktLines([...ackLines, 'delim']));
  }
  const selection = selectFetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  parts.push(pktLines(['packfile\n']));
  const pack = writePack(selection.objects);
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

/** Answer a v0 fetch (no sections: NAK/ACK lines, then sideband pack). */
export function answerFetchV0(repo: Repo, req: UploadPackRequest): Buffer {
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (req.haves.length === 0) lines.push('NAK\n');
  else {
    for (const have of req.haves) {
      if (repo.objects.has(have)) lines.push(`ACK ${have}\n`);
    }
    lines.push('NAK\n');
  }
  const selection = selectFetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(pktLines(lines));
  const pack = writePack(selection.objects);
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

/** Parse a receive-pack POST body into commands plus the pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const packets = decodePktLines(body);
  const commands: PushCommand[] = [];
  let consumed = 0;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length < 3) throw new Error('bad push command line');
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  // The pack starts after the flush packet (4 bytes). Recompute by scanning.
  let offset = 0;
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) break;
    offset += len;
  }
  void consumed;
  void sawFlush;
  const pack = packStart >= 0 && packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack };
}

/** Apply a push: store the pack's objects, then apply the ref updates. */
export function applyPush(store: Store, repo: Repo, commands: PushCommand[], pack: Buffer | null): PushOutcome {
  const outcome: PushOutcome = { unpackOk: true, unpackDetail: 'ok', refs: [] };
  let entries: Array<{ type: GitObjectType; data: Buffer; oid: string }> = [];
  if (pack !== null && pack.length > 0) {
    try {
      entries = readPack(pack, (oid) => repo.objects.get(oid));
    } catch (err) {
      outcome.unpackOk = false;
      outcome.unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      for (const command of commands) {
        outcome.refs.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      }
      return outcome;
    }
    for (const entry of entries) {
      if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const fail = (reason: string): void => {
      outcome.refs.push({ ref: command.ref, ok: false, reason });
    };
    if (!isOid(command.oldOid) || !isOid(command.newOid)) {
      fail('invalid object id');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        fail('no such ref');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('old oid mismatch');
        continue;
      }
      repo.refs.delete(command.ref);
      outcome.refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObject = lookup(command.newOid);
    if (!newObject) {
      fail('object not found');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        fail('already exists');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      outcome.refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      fail('no such ref');
      continue;
    }
    if (command.oldOid !== current) {
      fail('old oid mismatch');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const newCommit = lookup(command.newOid);
      if (!newCommit || newCommit.type !== 'commit') {
        fail('new tip is not a commit');
        continue;
      }
      if (!isAncestor(command.oldOid, command.newOid, lookup)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    outcome.refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  return outcome;
}

/** The report-status body, wrapped in sideband band 1. */
export function pushReport(outcome: PushOutcome): Buffer {
  const lines: Array<string | 'flush'> = [`unpack ${outcome.unpackOk ? 'ok' : outcome.unpackDetail}\n`];
  for (const ref of outcome.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  lines.push('flush');
  const report = pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
}
