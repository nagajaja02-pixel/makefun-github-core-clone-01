// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable
// HTTP. It speaks the modern 2026-07-28 era (server/discover, every request
// declaring its revision in _meta) and the legacy handshake era (initialize +
// notifications/initialized), and its tools act on the same store as REST.

import { type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export const SERVER_NAME = 'github-core-clone';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function textResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOf(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  let repo = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (repo === '' && full !== '') {
    const parts = full.split('/');
    if (parts.length === 2) repo = parts[1] as string;
  }
  if (owner === '' || repo === '') return null;
  return store.getRepo(owner, repo);
}

function repoJson(repo: Repo, owner: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, owner: string, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updatedAt: issue.updatedAt,
    html_url: `/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function prJson(repo: Repo, owner: string, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${owner}:${pr.baseRef}` },
    html_url: `/${owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`,
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const name = String(args.name ?? '');
      if (name === '') return errorResult('create_repo: a repository name is required');
      if (store.reposByName.has(name)) return errorResult(`create_repo: a repository named ${name} already exists`);
      const repo = store.createRepo(name, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      const owner = store.ownerLogin ?? '';
      return textResult(repoJson(repo, owner));
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === null) return errorResult('get_repo: the repository was not found');
      const owner = typeof args.owner === 'string' ? args.owner : '';
      return textResult(repoJson(repo, owner));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === null) return errorResult('create_issue: the repository was not found');
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const title = String(args.title ?? '');
      const body = typeof args.body === 'string' ? args.body : '';
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return errorResult(`create_issue: label ${label} does not exist`);
      }
      const issue: Issue = {
        id: store.nextIssueId,
        number: repo.nextNumber,
        title,
        body,
        state: 'open',
        labels,
        comments: [],
        seq: repo.nextNumber,
        createdAt: store.nextIso(),
        updatedAt: '',
      };
      store.nextIssueId += 1;
      repo.nextNumber += 1;
      issue.updatedAt = issue.createdAt;
      repo.issues.push(issue);
      return textResult(issueJson(repo, owner, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === null) return errorResult('list_issues: the repository was not found');
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return textResult(list.map((i) => issueJson(repo, owner, i)));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === null) return errorResult('create_pull_request: the repository was not found');
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = store.branchTip(repo, headRef);
      const baseSha = store.branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) return errorResult('create_pull_request: the head or base branch was not found');
      const pr: PullRequest = {
        id: store.nextPullId,
        number: repo.nextNumber,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        seq: repo.nextNumber,
        createdAt: store.nextIso(),
        updatedAt: '',
      };
      store.nextPullId += 1;
      repo.nextNumber += 1;
      pr.updatedAt = pr.createdAt;
      repo.pulls.push(pr);
      return textResult(prJson(repo, owner, pr));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      if (repo === null) return errorResult('merge_pull_request: the repository was not found');
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return errorResult(`merge_pull_request: pull request #${number} was not found`);
      if (pr.merged) return errorResult(`merge_pull_request: pull request #${number} is already merged`);
      const author = `${store.ownerLogin ?? 'forge'} <${store.ownerLogin ?? 'forge'}@example.invalid>`;
      const sha = store.mergePullRequest(repo, pr, author);
      if (sha === null) return errorResult(`merge_pull_request: pull request #${number} conflicts with its base branch`);
      return textResult({ ...prJson(repo, owner, pr), sha, merged: true });
    },
  },
];

/** The tools/list payload, built once so two calls answer byte for byte. */
export const TOOLS_LIST_PAYLOAD: Record<string, unknown> = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
};

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } };
}

const METHOD_NOT_FOUND: RpcError = { code: -32601, message: 'Method not found' };
const INVALID_PARAMS: RpcError = { code: -32602, message: 'Invalid params' };

/**
 * Handle one parsed JSON-RPC request object. Returns the response object, or
 * null for a notification (no id) that needs no answer.
 */
export function handleMcpRequest(store: Store, request: unknown): Record<string, unknown> | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, { code: -32600, message: 'Invalid Request' });
  }
  const req = request as Record<string, unknown>;
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = (params.protocolVersion as string | undefined) ?? '';
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, TOOLS_LIST_PAYLOAD);
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) return rpcError(id, { code: -32602, message: `Unknown tool: ${name}` });
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcError(id, { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` });
    }
    try {
      const result = tool.run(store, args);
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, errorResult(err instanceof Error ? err.message : String(err)));
    }
  }
  if (isNotification) return null;
  return rpcError(id, METHOD_NOT_FOUND);
}

export { INVALID_PARAMS };
