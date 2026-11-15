// A small GraphQL executor for the documents gh and github-mcp-server send:
// queries over viewer/repository/node/__type, issue and pull-request reads,
// and the create/close/merge/comment mutations. It parses the document text
// (selection sets, arguments, variables, input objects, inline fragments and
// aliases), validates every field against a fixed schema, and resolves against
// the same store the REST surface uses.

import {
  diffTrees,
  parseCommit,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- parsing

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface Selection {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: Selection[] | null;
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: GqlValue | null }>;
  selections: Selection[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipSpace(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== ch) throw new ParseError(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }

  private matchWord(word: string): boolean {
    this.skipSpace();
    if (!this.text.startsWith(word, this.pos)) return false;
    const after = this.text[this.pos + word.length] ?? '';
    if (/[A-Za-z0-9_]/.test(after)) return false;
    this.pos += word.length;
    return true;
  }

  private readName(): string {
    this.skipSpace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipSpace();
    if (this.text[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos] as string;
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new ParseError('unterminated string');
  }

  private readValue(): GqlValue {
    this.skipSpace();
    const ch = this.text[this.pos] ?? '';
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.readValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.readValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    const word = /^[A-Za-z0-9_.-]+/.exec(this.text.slice(this.pos))?.[0] ?? '';
    if (word === '') throw new ParseError(`expected a value at ${this.pos}`);
    this.pos += word.length;
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(word)) return { kind: 'int', value: parseInt(word, 10) };
    if (/^-?\d+\.\d+$/.test(word)) return { kind: 'float', value: parseFloat(word) };
    return { kind: 'enum', value: word };
  }

  private readArguments(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.readValue() });
    }
    this.expect(')');
    return args;
  }

  private readType(): string {
    this.skipSpace();
    let type = '';
    if (this.peek() === '[') {
      this.pos += 1;
      type = `[${this.readType()}]`;
    } else {
      type = this.readName();
    }
    if (this.peek() === '!') {
      this.pos += 1;
      type += '!';
    }
    return type;
  }

  private readVariableDefinitions(): Array<{ name: string; type: string; defaultValue: GqlValue | null }> {
    const defs: Array<{ name: string; type: string; defaultValue: GqlValue | null }> = [];
    if (this.peek() !== '(') return defs;
    this.pos += 1;
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.readName();
      this.expect(':');
      const type = this.readType();
      let defaultValue: GqlValue | null = null;
      if (this.peek() === '=') {
        this.pos += 1;
        defaultValue = this.readValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  private readSelections(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipSpace();
        if (this.matchWord('on')) {
          const fragmentType = this.readName();
          const inner = this.readSelections();
          selections.push({ alias: null, name: '', args: [], selections: inner, fragmentType });
        } else {
          // A named fragment spread: not used by the suite's documents; skip
          // its name and treat the following selection set as inlined.
          this.readName();
          if (this.peek() === '{') {
            const inner = this.readSelections();
            selections.push({ alias: null, name: '', args: [], selections: inner, fragmentType: null });
          }
        }
        continue;
      }
      let name = this.readName();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.pos += 1;
        alias = name;
        name = this.readName();
      }
      const args = this.readArguments();
      let inner: Selection[] | null = null;
      if (this.peek() === '{') inner = this.readSelections();
      selections.push({ alias, name, args, selections: inner, fragmentType: null });
    }
    this.expect('}');
    return selections;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== '') {
      let kind: 'query' | 'mutation' = 'query';
      if (this.matchWord('query')) kind = 'query';
      else if (this.matchWord('mutation')) kind = 'mutation';
      else if (this.matchWord('fragment')) {
        // Fragment definitions are not used by the suite; skip one.
        this.readName();
        if (this.matchWord('on')) this.readName();
        this.readSelections();
        continue;
      }
      let name: string | null = null;
      const next = this.peek();
      if (/[A-Za-z_]/.test(next)) name = this.readName();
      const variables = this.readVariableDefinitions();
      const selections = this.readSelections();
      operations.push({ kind, name, variables, selections });
    }
    return operations;
  }
}

// ---------------------------------------------------------------- schema

interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User' },
    repository: { type: 'Repository', args: { owner: 'String', name: 'String' } },
    node: { type: 'Node', args: { id: 'ID' } },
    __type: { type: '__Type', args: { name: 'String' } },
    __schema: { type: '__Schema' },
  },
  User: {
    id: { type: 'ID' },
    login: { type: 'String' },
    name: { type: 'String' },
  },
  Repository: {
    id: { type: 'ID' },
    databaseId: { type: 'Int' },
    name: { type: 'String' },
    nameWithOwner: { type: 'String' },
    owner: { type: 'User' },
    defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'String' },
    hasIssuesEnabled: { type: 'Boolean' },
    issue: { type: 'Issue', args: { number: 'Int' } },
    issues: { type: 'IssueConnection', args: { first: 'Int', after: 'String', states: '[IssueState]', orderBy: 'IssueOrder' } },
    pullRequests: { type: 'PullRequestConnection', args: { first: 'Int', after: 'String' } },
    pullRequest: { type: 'PullRequest', args: { number: 'Int' } },
  },
  Issue: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    state: { type: 'String' },
    body: { type: 'String' },
    url: { type: 'String' },
  },
  IssueConnection: {
    nodes: { type: '[Issue]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequest: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    body: { type: 'String' },
    state: { type: 'String' },
    merged: { type: 'Boolean' },
    mergeable: { type: 'String' },
    headRefName: { type: 'String' },
    baseRefName: { type: 'String' },
    files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int' } },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequestChangedFile: {
    path: { type: 'String' },
    additions: { type: 'Int' },
    deletions: { type: 'Int' },
    changeType: { type: 'String' },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean' },
    hasPreviousPage: { type: 'Boolean' },
    endCursor: { type: 'String' },
    startCursor: { type: 'String' },
  },
  Ref: {
    name: { type: 'String' },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput' } },
    closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput' } },
    createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput' } },
    mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput' } },
    addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput' } },
  },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  AddCommentPayload: { commentEdge: { type: 'IssueCommentEdge' } },
  IssueCommentEdge: { node: { type: 'IssueComment' } },
  IssueComment: { id: { type: 'ID' }, body: { type: 'String' } },
  Node: { id: { type: 'ID' } },
  __Type: {
    name: { type: 'String' },
    kind: { type: 'String' },
    fields: { type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
    enumValues: { type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
  },
  __Field: { name: { type: 'String' } },
  __EnumValue: { name: { type: 'String' } },
  __Schema: {
    queryType: { type: '__Type' },
    mutationType: { type: '__Type' },
    types: { type: '[__Type]' },
  },
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'WIKI'];

// ---------------------------------------------------------------- global ids

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string | null {
  try {
    return Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64encode(`R:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64encode(`I:${repo.id}:${issue.number}`);
}

export function prGlobalId(repo: Repo, pr: PullRequest): string {
  return b64encode(`P:${repo.id}:${pr.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64encode(`C:${repo.id}:${issue.number}:${commentId}`);
}

interface DecodedId {
  kind: string;
  repoId: number;
  number: number;
  extra: number;
}

export function decodeGlobalId(id: string): DecodedId | null {
  const text = b64decode(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0] as string;
  const repoId = parseInt(parts[1] as string, 10);
  if (!Number.isFinite(repoId)) return null;
  return {
    kind,
    repoId,
    number: parts.length > 2 ? parseInt(parts[2] as string, 10) : 0,
    extra: parts.length > 3 ? parseInt(parts[3] as string, 10) : 0,
  };
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

type Value = unknown;

function resolveValue(node: GqlValue, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(sel: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of sel.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function baseType(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

/** The concrete type of a resolved value, for fragment matching. */
function concreteType(value: Value): string | null {
  if (value !== null && typeof value === 'object') {
    const kind = (value as Record<string, unknown>).__typename;
    if (typeof kind === 'string') return kind;
  }
  return null;
}

function executeSelections(
  ctx: Ctx,
  typeName: string,
  value: Value,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[typeName] ?? {};
  for (const sel of selections) {
    if (sel.fragmentType !== null) {
      // Inline fragment: apply when the type matches (or the fragment is on
      // an interface the value implements, e.g. `... on Repository`).
      const target = sel.fragmentType;
      const actual = concreteType(value) ?? typeName;
      if (target !== actual && !(typeName === 'Node' && target === 'Repository' && actual === 'Repository')) {
        continue;
      }
      const inner = executeSelections(ctx, target, value, sel.selections ?? [], variables);
      Object.assign(out, inner);
      continue;
    }
    if (sel.name === '') continue;
    const key = sel.alias ?? sel.name;
    const def = fields[sel.name];
    if (def === undefined) {
      if (sel.name.startsWith('__')) {
        out[key] = null;
        continue;
      }
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = argsOf(sel, variables);
    const resolved = resolveField(ctx, typeName, value, sel.name, args);
    const childType = baseType(def.type);
    if (sel.selections !== null && resolved !== null && typeof resolved === 'object') {
      if (Array.isArray(resolved)) {
        const itemType = childType;
        out[key] = resolved.map((item) => executeSelections(ctx, itemType, item, sel.selections as Selection[], variables));
      } else {
        out[key] = executeSelections(ctx, childType, resolved, sel.selections, variables);
      }
    } else {
      out[key] = resolved;
    }
  }
  return out;
}

function findRepoById(ctx: Ctx, repoId: number): Repo | null {
  for (const repo of ctx.store.listRepos()) if (repo.id === repoId) return repo;
  return null;
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `/repos/${repo.name}/issues/${issue.number}`,
  };
}

function prJson(ctx: Ctx, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const mergeable = ctx.store.prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
  const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    id: prGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state,
    merged: pr.merged,
    mergeable,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    __headSha: pr.headSha,
    __baseSha: pr.baseSha,
    __repo: repo,
    __pr: pr,
  };
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const owner = ctx.store.ownerLogin ?? '';
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { __typename: 'User', login: owner, id: b64encode(`U:${owner}`), name: owner },
    defaultBranchRef: ctx.store.branchTip(repo, repo.defaultBranch) === null ? null : { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
  };
}

function resolveField(ctx: Ctx, typeName: string, value: Value, field: string, args: Record<string, unknown>): Value {
  const record = (value ?? {}) as Record<string, unknown>;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') {
        const login = ctx.store.ownerLogin ?? '';
        return { __typename: 'User', login, id: b64encode(`U:${login}`), name: login };
      }
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        return ctx.store.getRepo(owner, name) === null ? null : repoJson(ctx, ctx.store.getRepo(owner, name) as Repo);
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'R') {
          const repo = findRepoById(ctx, decoded.repoId);
          return repo === null ? null : repoJson(ctx, repo);
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (name === 'SearchType') return { __typename: '__Type', name, kind: 'ENUM', __enumValues: SEARCH_TYPE_VALUES };
        const fields = SCHEMA[name];
        if (fields === undefined) return null;
        return { __typename: '__Type', name, kind: 'OBJECT', __fields: Object.keys(fields) };
      }
      if (field === '__schema') {
        return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' } };
      }
      return null;
    }
    case 'Repository': {
      const repo = record.__repo as Repo;
      if (field === 'issue') {
        const issue = repo.issues.find((i) => i.number === (args.number as number));
        return issue === undefined ? null : issueJson(ctx, repo, issue);
      }
      if (field === 'issues') {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const desc = orderBy !== undefined && String(orderBy.direction ?? '').toUpperCase() === 'DESC';
        list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
        const after = args.after as string | null | undefined;
        let start = 0;
        if (typeof after === 'string' && after !== '') {
          const decoded = b64decode(after);
          const seq = decoded !== null && decoded.startsWith('cursor:') ? parseInt(decoded.slice(7), 10) : NaN;
          if (Number.isFinite(seq)) {
            const idx = list.findIndex((i) => i.seq === seq);
            if (idx >= 0) start = idx + 1;
          }
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(start, start + first);
        const endCursor = page.length > 0 ? b64encode(`cursor:${(page[page.length - 1] as Issue).seq}`) : null;
        return {
          __typename: 'IssueConnection',
          nodes: page.map((i) => issueJson(ctx, repo, i)),
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: start + page.length < list.length,
            hasPreviousPage: start > 0,
            endCursor,
            startCursor: page.length > 0 ? b64encode(`cursor:${(page[0] as Issue).seq}`) : null,
          },
          totalCount: list.length,
        };
      }
      if (field === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
        const page = repo.pulls.slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((p) => prJson(ctx, repo, p)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: repo.pulls.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
          totalCount: repo.pulls.length,
        };
      }
      if (field === 'pullRequest') {
        const pr = repo.pulls.find((p) => p.number === (args.number as number));
        return pr === undefined ? null : prJson(ctx, repo, pr);
      }
      return record[field] ?? null;
    }
    case 'Issue':
      return record[field] ?? null;
    case 'PullRequest': {
      if (field === 'files') {
        const pr = record.__pr as PullRequest;
        const repo = record.__repo as Repo;
        const baseCommit = repo.objects.get(pr.baseSha);
        const headCommit = repo.objects.get(pr.headSha);
        if (!baseCommit || !headCommit) {
          return { __typename: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }, totalCount: 0 };
        }
        const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status }));
        return { __typename: 'PullRequestChangedFileConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, hasPreviousPage: false, endCursor: null, startCursor: null }, totalCount: files.length };
      }
      return record[field] ?? null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'PageInfo':
    case 'Ref':
    case 'User':
    case 'IssueComment':
    case 'PullRequestChangedFile':
    case '__Field':
    case '__EnumValue':
      return record[field] ?? null;
    case '__Type': {
      if (field === 'fields') {
        const names = (record.__fields as string[] | undefined) ?? [];
        return names.map((name) => ({ __typename: '__Field', name }));
      }
      if (field === 'enumValues') {
        const values = (record.__enumValues as string[] | undefined) ?? [];
        return values.map((name) => ({ __typename: '__EnumValue', name }));
      }
      return record[field] ?? null;
    }
    case '__Schema': {
      if (field === 'types') return [];
      return record[field] ?? null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'R') throw new Error('createIssue: unknown repository id');
        const repo = findRepoById(ctx, decoded.repoId);
        if (repo === null) throw new Error('createIssue: unknown repository');
        const title = String(input.title ?? '');
        const body = typeof input.body === 'string' ? input.body : '';
        const issue: Issue = {
          id: ctx.store.nextIssueId,
          number: repo.nextNumber,
          title,
          body,
          state: 'open',
          labels: [],
          comments: [],
          seq: repo.nextNumber,
          createdAt: ctx.store.nextIso(),
          updatedAt: '',
        };
        ctx.store.nextIssueId += 1;
        repo.nextNumber += 1;
        issue.updatedAt = issue.createdAt;
        repo.issues.push(issue);
        return { __typename: 'CreateIssuePayload', issue: issueJson(ctx, repo, issue) };
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null || decoded.kind !== 'I') throw new Error('closeIssue: unknown issue id');
        const repo = findRepoById(ctx, decoded.repoId);
        const issue = repo?.issues.find((i) => i.number === decoded.number);
        if (repo === undefined || repo === null || issue === undefined) throw new Error('closeIssue: unknown issue');
        issue.state = 'closed';
        issue.updatedAt = ctx.store.nextIso();
        return { __typename: 'CloseIssuePayload', issue: issueJson(ctx, repo, issue) };
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'R') throw new Error('createPullRequest: unknown repository id');
        const repo = findRepoById(ctx, decoded.repoId);
        if (repo === null) throw new Error('createPullRequest: unknown repository');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = ctx.store.branchTip(repo, headRef);
        const baseSha = ctx.store.branchTip(repo, baseRef);
        if (headSha === null || baseSha === null) throw new Error('createPullRequest: unknown branch');
        const pr: PullRequest = {
          id: ctx.store.nextPullId,
          number: repo.nextNumber,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef,
          baseRef,
          headSha,
          baseSha,
          seq: repo.nextNumber,
          createdAt: ctx.store.nextIso(),
          updatedAt: '',
        };
        ctx.store.nextPullId += 1;
        repo.nextNumber += 1;
        pr.updatedAt = pr.createdAt;
        repo.pulls.push(pr);
        return { __typename: 'CreatePullRequestPayload', pullRequest: prJson(ctx, repo, pr) };
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null || decoded.kind !== 'P') throw new Error('mergePullRequest: unknown pull request id');
        const repo = findRepoById(ctx, decoded.repoId);
        const pr = repo?.pulls.find((p) => p.number === decoded.number);
        if (repo === undefined || repo === null || pr === undefined) throw new Error('mergePullRequest: unknown pull request');
        const author = `${ctx.store.ownerLogin ?? 'forge'} <${ctx.store.ownerLogin ?? 'forge'}@example.invalid>`;
        const sha = ctx.store.mergePullRequest(repo, pr, author);
        if (sha === null) throw new Error('mergePullRequest: the pull request conflicts');
        return { __typename: 'MergePullRequestPayload', pullRequest: prJson(ctx, repo, pr) };
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null || decoded.kind !== 'I') throw new Error('addComment: unknown subject id');
        const repo = findRepoById(ctx, decoded.repoId);
        const issue = repo?.issues.find((i) => i.number === decoded.number);
        if (repo === undefined || repo === null || issue === undefined) throw new Error('addComment: unknown issue');
        const body = String(input.body ?? '');
        const commentId = repo.nextCommentId;
        repo.nextCommentId += 1;
        const createdAt = ctx.store.nextIso();
        issue.comments.push({ id: commentId, body, createdAt });
        issue.updatedAt = createdAt;
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', id: commentGlobalId(repo, issue, commentId), body },
          },
        };
      }
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
    case 'IssueCommentEdge':
      return record[field] ?? null;
    default:
      return record[field] ?? null;
  }
}

/** Execute one parsed operation. */
export function executeOperation(
  store: Store,
  operation: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, errors: [] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.variables) {
    if (!(def.name in mergedVariables) && def.defaultValue !== null) {
      mergedVariables[def.name] = resolveValue(def.defaultValue, {});
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelections(ctx, rootType, {}, operation.selections, mergedVariables);
    return { data, errors: ctx.errors };
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return { data: null, errors: ctx.errors };
  }
}

/**
 * Handle a GraphQL HTTP body (one operation object, or an array of them for
 * batching). Returns the response body object (or array).
 */
export function handleGraphQL(store: Store, body: unknown): unknown {
  const runOne = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { data: null, errors: [{ message: 'the request body must be a JSON object with a query string' }] };
    }
    const record = item as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'the request carries no query string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: `the query does not parse: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'the query holds no operation' }] };
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation = operations[0] as Operation;
    if (operationName !== null) {
      const found = operations.find((op) => op.name === operationName);
      if (found !== undefined) operation = found;
    }
    const result = executeOperation(store, operation, variables);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
