// The forge's in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments. Everything lives in Maps; there is no disk, no
// database and no outside service. All timestamps come from one deterministic
// counter (never the wall clock) so two runs over the same requests produce the
// same bytes.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author} ${opts.timestamp} +0000`, `committer ${opts.committer} ${opts.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target, blob -> nothing. Throws on a missing
 * object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag (possibly through nested tags) to the commit it names. */
export function peelToCommit(oid: string, lookup: (oid: string) => GitObject | undefined): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** True when `ancestor` is reachable from `tip` by following commit parents. */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Read one path out of a tree (recursive); null when absent. */
export function readPath(
  treeOid: string,
  path: string,
  lookup: (oid: string) => GitObject | undefined,
): { mode: string; oid: string } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = lookup(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Return a new tree oid with `path` set to `blobOid` (or removed when null).
 * Missing intermediate trees are created; empty trees left behind by a removal
 * are pruned. New objects are written through `put`.
 */
export function setPathInTree(
  treeOid: string | null,
  path: string,
  blobOid: string | null,
  lookup: (oid: string) => GitObject | undefined,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  const segments = path.split('/').filter((s) => s !== '');
  function build(tree: string | null, depth: number): string | null {
    const entries = tree === null ? [] : parseTree(lookup(tree)?.data ?? Buffer.alloc(0));
    const name = segments[depth] as string;
    const last = depth === segments.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (last) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const child = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as TreeEntry).oid : null;
      const next = build(child, depth + 1);
      if (next === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    if (entries.length === 0) return null;
    return put('tree', buildTree(entries));
  }
  const result = build(treeOid, 0);
  if (result === null) return put('tree', buildTree([]));
  return result;
}

/** Flatten a tree into (path, mode, oid) triples for every file, sorted by path. */
export function flattenTree(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
): Array<{ path: string; mode: string; oid: string }> {
  const out: Array<{ path: string; mode: string; oid: string }> = [];
  function walk(oid: string, prefix: string): void {
    const tree = lookup(oid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.push({ path, mode: entry.mode, oid: entry.oid });
    }
  }
  walk(treeOid, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count added/removed lines between two texts with a small LCS diff. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 2000 || newLines.length > 2000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

/** The changed files between two trees, with per-file change counts. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): DiffFile[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const base = new Map(flattenTree(baseTree, lookup).map((f) => [f.path, f]));
  const head = new Map(flattenTree(headTree, lookup).map((f) => [f.path, f]));
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: DiffFile[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = lookup(b.oid)?.data.toString('utf8') ?? '';
      const deletions = oldText === '' ? 0 : oldText.split('\n').length;
      out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const newText = lookup(h.oid)?.data.toString('utf8') ?? '';
      const additions = newText === '' ? 0 : newText.split('\n').length;
      out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const { additions, deletions } = lineDiff(
        lookup(b.oid)?.data.toString('utf8') ?? '',
        lookup(h.oid)?.data.toString('utf8') ?? '',
      );
      out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the store

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

/**
 * The whole forge. Repositories are keyed by name: the trial has one token and
 * therefore one owner, whose login is learned from the first request that names
 * one (the suite always names the token owner's login first).
 */
export class Store {
  reposByName = new Map<string, Repo>();
  ownerLogin: string | null = null;
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  private seq = 0;

  /** A deterministic timestamp: fixed epoch plus a per-mutation counter. */
  nextTimestamp(): number {
    this.seq += 1;
    return 1700000000 + this.seq;
  }

  nextIso(): string {
    return new Date(this.nextTimestamp() * 1000).toISOString();
  }

  /** Learn the token owner's login from the first owner-named request. */
  bindOwner(login: string): string {
    if (this.ownerLogin === null) this.ownerLogin = login;
    return this.ownerLogin;
  }

  /** True when `login` is the token owner's login (binding it when still unknown). */
  isOwner(login: string): boolean {
    if (this.ownerLogin === null) this.ownerLogin = login;
    return this.ownerLogin === login;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (!this.isOwner(owner)) return null;
    return this.reposByName.get(name) ?? null;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.reposByName.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): void {
    this.reposByName.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()];
  }

  /** The tip commit of a branch, or null when the branch has no commit. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit a ref name (branch, tag or full ref) resolves to, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (isOid(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Create a commit on `branch` that sets `path` to `content` (or deletes it). */
  commitFile(
    repo: Repo,
    opts: { branch: string; path: string; content: Buffer | null; message: string; author: string },
  ): { commitSha: string; blobSha: string | null } {
    const tip = this.branchTip(repo, opts.branch);
    let treeOid: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') throw new Error('branch tip is not a commit');
      treeOid = parseCommit(commit.data).tree;
      parents.push(tip);
    }
    let blobSha: string | null = null;
    if (opts.content !== null) blobSha = this.putObject(repo, 'blob', opts.content);
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const put = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    const newTree = setPathInTree(treeOid, opts.path, blobSha, lookup, put);
    const timestamp = this.nextTimestamp();
    const commitData = buildCommit({
      tree: newTree,
      parents,
      message: opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`,
      author: opts.author,
      committer: opts.author,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${opts.branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** The file content at a path on a commit, or null. */
  fileAt(repo: Repo, commitOid: string, path: string): { mode: string; oid: string; data: Buffer } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const tree = parseCommit(commit.data).tree;
    const found = readPath(tree, path, (oid) => repo.objects.get(oid));
    if (!found) return null;
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { mode: found.mode, oid: found.oid, data: blob.data };
  }

  /** Commits reachable from `tip`, tip first (depth-first, parents in order). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /** Three-way merge of trees; null when the merge conflicts. */
  threeWayMerge(
    repo: Repo,
    baseTree: string,
    headTree: string,
    tipTree: string,
  ): string | null {
    const base = new Map(flattenTree(baseTree, (oid) => repo.objects.get(oid)).map((f) => [f.path, f.oid]));
    const head = new Map(flattenTree(headTree, (oid) => repo.objects.get(oid)).map((f) => [f.path, f.oid]));
    const tip = new Map(flattenTree(tipTree, (oid) => repo.objects.get(oid)).map((f) => [f.path, f.oid]));
    const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
    const result = new Map<string, string>();
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      if (h === t) {
        if (h !== undefined) result.set(path, h);
      } else if (b === h) {
        if (t !== undefined) result.set(path, t);
      } else if (b === t) {
        if (h !== undefined) result.set(path, h);
      } else {
        return null; // both sides changed the path differently
      }
    }
    // Rebuild a tree from the flat result.
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const put = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    let tree: string | null = null;
    for (const [path, oid] of [...result.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      tree = setPathInTree(tree, path, oid, lookup, put);
    }
    return tree ?? put('tree', buildTree([]));
  }

  /** Whether merging `pr` onto the default branch would conflict. */
  prConflicts(repo: Repo, pr: PullRequest): boolean {
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (baseTip === null) return false;
    const baseCommit = repo.objects.get(pr.baseSha);
    const headCommit = repo.objects.get(pr.headSha);
    const tipCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return false;
    const merged = this.threeWayMerge(
      repo,
      parseCommit(baseCommit.data).tree,
      parseCommit(headCommit.data).tree,
      parseCommit(tipCommit.data).tree,
    );
    return merged === null;
  }

  /** Squash-merge `pr` onto its base branch; null when conflicted. */
  mergePullRequest(repo: Repo, pr: PullRequest, author: string): string | null {
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (baseTip === null) return null;
    const baseCommit = repo.objects.get(pr.baseSha);
    const headCommit = repo.objects.get(pr.headSha);
    const tipCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return null;
    const mergedTree = this.threeWayMerge(
      repo,
      parseCommit(baseCommit.data).tree,
      parseCommit(headCommit.data).tree,
      parseCommit(tipCommit.data).tree,
    );
    if (mergedTree === null) return null;
    const timestamp = this.nextTimestamp();
    const message = `${pr.title} (#${pr.number})\n`;
    const commitData = buildCommit({
      tree: mergedTree,
      parents: [baseTip],
      message,
      author,
      committer: author,
      timestamp,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = new Date(timestamp * 1000).toISOString();
    pr.mergeCommitSha = sha;
    pr.updatedAt = pr.mergedAt;
    return sha;
  }
}
