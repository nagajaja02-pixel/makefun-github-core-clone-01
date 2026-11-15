// The forge's HTTP server: one Node http server serving git smart HTTP, the
// REST v3 API, GraphQL v4 and MCP from the shared store. Every REST reply is
// JSON with an X-GitHub-Request-Id; errors are JSON with a string message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  answerFetchV0,
  answerFetchV2,
  answerLsRefs,
  advertisementV0,
  advertisementV2,
  applyPush,
  parseReceivePack,
  parseUploadPack,
  pushReport,
} from './git.ts';
import { handleGraphQL, issueGlobalId, prGlobalId } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import {
  ZERO_OID,
  diffTrees,
  flattenTree,
  parseCommit,
  parseTree,
  readPath,
  type Issue,
  type PullRequest,
  type Repo,
  Store,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

export interface AppOptions {
  token: string;
}

export function createApp(options: AppOptions = { token: process.env.MAKEFUN_SHOP_TOKEN ?? '' }): Server {
  const store = new Store();
  const token = options.token;
  let requestCounter = 0;

  function requestId(): string {
    requestCounter += 1;
    return `req-${requestCounter}`;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId(),
      ...extra,
    });
    res.end(text);
  }

  function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': requestId(),
    });
    res.end(body);
  }

  function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { message });
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length);
    if (token === '') return presented !== '';
    return presented === token;
  }

  function pathOf(req: IncomingMessage): string {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  }

  function queryOf(req: IncomingMessage): URLSearchParams {
    try {
      return new URL(req.url ?? '/', 'http://entry').searchParams;
    } catch {
      return new URLSearchParams();
    }
  }

  function segmentsOf(path: string): string[] {
    return path.split('/').filter((s) => s !== '').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) {
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /** Parse a JSON body; null when there is no body, throws on malformed JSON. */
  function parseJsonBody(raw: Buffer): unknown {
    const text = raw.toString('utf8').trim();
    if (text === '') return null;
    return JSON.parse(text);
  }

  function ownerLogin(): string {
    return store.ownerLogin ?? '';
  }

  function authorLine(): string {
    const login = ownerLogin() || 'forge';
    return `${login} <${login}@example.invalid>`;
  }

  function repoJson(repo: Repo): Record<string, unknown> {
    const login = ownerLogin();
    const createdAt = new Date((1700000000 + repo.id) * 1000).toISOString();
    return {
      id: repo.id,
      node_id: b64encode(`R:${repo.id}`),
      name: repo.name,
      full_name: `${login}/${repo.name}`,
      owner: { login, id: 1, type: 'User', html_url: `/${login}`, url: `/api/v3/users/${login}` },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `/${login}/${repo.name}`,
      url: `/api/v3/repos/${login}/${repo.name}`,
      created_at: createdAt,
      updated_at: createdAt,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      has_pages: false,
      has_downloads: true,
      archived: false,
      disabled: false,
      visibility: repo.private ? 'private' : 'public',
      fork: false,
      forks_count: 0,
      open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
      watchers_count: 0,
      stargazers_count: 0,
      size: 0,
      language: null,
      license: null,
    };
  }

  function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    const login = ownerLogin();
    return {
      id: issue.id,
      node_id: issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: { login, id: 1, type: 'User' },
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { id: name, name, color: label?.color ?? 'ededed', description: '', default: false, url: `/api/v3/repos/${login}/${repo.name}/labels/${encodeURIComponent(name)}` };
      }),
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.state === 'closed' ? issue.updatedAt : null,
      html_url: `/${login}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${login}/${repo.name}`,
      comments_url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}/comments`,
      author_association: 'OWNER',
    };
  }

  function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
    const login = ownerLogin();
    return {
      id: pr.id,
      node_id: prGlobalId(repo, pr),
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha,
      mergeable: !store.prConflicts(repo, pr),
      mergeable_state: store.prConflicts(repo, pr) ? 'conflicting' : 'clean',
      head: { ref: pr.headRef, sha: pr.headSha, label: `${login}:${pr.headRef}`, user: { login, id: 1, type: 'User' }, repo: repoJson(repo) },
      base: { ref: pr.baseRef, sha: pr.baseSha, label: `${login}:${pr.baseRef}`, user: { login, id: 1, type: 'User' }, repo: repoJson(repo) },
      user: { login, id: 1, type: 'User' },
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      closed_at: pr.state === 'closed' ? pr.updatedAt : null,
      html_url: `/${login}/${repo.name}/pull/${pr.number}`,
      url: `/api/v3/repos/${login}/${repo.name}/pulls/${pr.number}`,
      commits_url: `/api/v3/repos/${login}/${repo.name}/pulls/${pr.number}/commits`,
      review_comments_url: `/api/v3/repos/${login}/${repo.name}/pulls/${pr.number}/comments`,
      comments_url: `/api/v3/repos/${login}/${repo.name}/issues/${pr.number}/comments`,
      draft: false,
      locked: false,
    };
  }

  function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNum: number; perPage: number; totalPages: number } {
    const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
    const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const page = items.slice((pageNum - 1) * perPage, pageNum * perPage);
    return { page, hasNext: pageNum < totalPages, pageNum, perPage, totalPages };
  }

  function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string {
    const host = req.headers.host ?? 'localhost';
    const urlFor = (page: number): string => {
      const params = new URLSearchParams(query);
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      return `http://${host}${basePath}?${params.toString()}`;
    };
    const parts: string[] = [];
    if (pageNum < totalPages) parts.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
    if (pageNum > 1) parts.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
    parts.push(`<${urlFor(1)}>; rel="first"`);
    parts.push(`<${urlFor(totalPages)}>; rel="last"`);
    return parts.join(', ');
  }

  /** Resolve a repo from path segments; null when absent or foreign-owned. */
  function resolveRepo(segments: string[]): { repo: Repo; owner: string; name: string } | null {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    if (owner === undefined || name === undefined) return null;
    const repo = store.getRepo(owner, name);
    if (repo === null) return null;
    return { repo, owner, name };
  }

  // ---------------------------------------------------------------- git

  function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], body: Buffer): void {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).replace(/\.git$/, '');
    // Binding the owner on the first git request (the suite names the token
    // owner's login here before any other owner-named surface).
    store.bindOwner(owner);
    const repo = store.getRepo(owner, repoName);
    const query = queryOf(req);
    const method = req.method ?? 'GET';
    const tail = segments.slice(2);

    if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
      const service = query.get('service');
      if (repo === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendBuffer(res, 200, v2 ? advertisementV2() : advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendError(res, 400, 'the info/refs service is missing');
      return;
    }

    if (method === 'POST' && tail[0] === 'git-upload-pack') {
      if (repo === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      let parsed;
      try {
        parsed = parseUploadPack(body);
      } catch {
        sendError(res, 400, 'malformed pkt-line stream');
        return;
      }
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2' || parsed.command === 'ls-refs';
      if (parsed.command === 'ls-refs') {
        sendBuffer(res, 200, answerLsRefs(repo, parsed.args), 'application/x-git-upload-pack-result');
        return;
      }
      if (parsed.command === 'fetch' || parsed.wants.length > 0) {
        const out = v2 ? answerFetchV2(repo, parsed) : answerFetchV0(repo, parsed);
        sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
        return;
      }
      sendError(res, 400, 'unknown upload-pack command');
      return;
    }

    if (method === 'POST' && tail[0] === 'git-receive-pack') {
      if (repo === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      let parsed;
      try {
        parsed = parseReceivePack(body);
      } catch {
        sendError(res, 400, 'malformed pkt-line stream');
        return;
      }
      const outcome = applyPush(store, repo, parsed.commands, parsed.pack);
      sendBuffer(res, 200, pushReport(outcome), 'application/x-git-receive-pack-result');
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  // ---------------------------------------------------------------- REST

  async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], body: Buffer, rawPath: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET';

    // API root and meta.
    if ((method === 'GET' && (rawPath === '/api/v3' || rawPath === '/api/v3/'))) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: ZERO_OID, hooks: [], git: [], pages: [], importer: [], packages: [] });
      return;
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
      if (store.ownerLogin === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const login = ownerLogin();
      sendJson(res, 200, {
        login,
        id: 1,
        node_id: b64encode(`U:${login}`),
        avatar_url: '',
        gravatar_id: '',
        url: '/api/v3/user',
        html_url: `/${login}`,
        type: 'User',
        site_admin: false,
        name: login,
        email: `${login}@example.invalid`,
        public_repos: store.listRepos().length,
        followers: 0,
        following: 0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });
      return;
    }

    // POST /user/repos and GET /user/repos.
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'POST') {
        let parsed: unknown;
        try {
          parsed = parseJsonBody(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }
        const input = (parsed ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return;
        }
        if (store.reposByName.has(name)) {
          sendError(res, 422, `Validation Failed: a repository named ${name} already exists`);
          return;
        }
        const repo = store.createRepo(name, {
          description: typeof input.description === 'string' ? input.description : '',
          private: input.private === true,
          defaultBranch: typeof input.default_branch === 'string' ? input.default_branch : 'main',
        });
        sendJson(res, 201, repoJson(repo));
        return;
      }
      if (method === 'GET') {
        const repos = store.listRepos();
        const { page, hasNext, pageNum, perPage, totalPages } = paginate(repos, query);
        const extra: Record<string, string> = {};
        if (hasNext || pageNum > 1) extra.link = linkHeader(req, '/api/v3/user/repos', query, pageNum, perPage, totalPages);
        sendJson(res, 200, page.map(repoJson), extra);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // /repos/{owner}/{repo}/...
    if (segments.length >= 3 && segments[0] === 'repos') {
      const resolved = resolveRepo(segments);
      if (resolved === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const { repo } = resolved;
      const rest = segments.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') {
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'PATCH') {
          let parsed: unknown;
          try {
            parsed = parseJsonBody(body);
          } catch {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          const input = (parsed ?? {}) as Record<string, unknown>;
          if (typeof input.description === 'string') repo.description = input.description;
          if (typeof input.private === 'boolean') repo.private = input.private;
          if (typeof input.default_branch === 'string') repo.defaultBranch = input.default_branch;
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'DELETE') {
          store.deleteRepo(repo.name);
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // Branches.
      if (rest[0] === 'branches') {
        if (method === 'GET' && rest.length === 1) {
          const branches = [...repo.refs.keys()]
            .filter((ref) => ref.startsWith('refs/heads/'))
            .map((ref) => ref.slice('refs/heads/'.length))
            .sort()
            .map((name) => ({
              name,
              commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: `/api/v3/repos/${ownerLogin()}/${repo.name}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
              protected: false,
            }));
          sendJson(res, 200, branches);
          return;
        }
        if (method === 'GET' && rest.length === 2) {
          const branch = rest[1] as string;
          const tip = store.branchTip(repo, branch);
          if (tip === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, {
            name: branch,
            commit: { sha: tip, url: `/api/v3/repos/${ownerLogin()}/${repo.name}/commits/${tip}` },
            protected: false,
          });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // Commits.
      if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === null) {
          sendJson(res, 200, []);
          return;
        }
        const commits = store.listCommits(repo, tip).map((sha) => {
          const object = repo.objects.get(sha);
          const view = object ? parseCommit(object.data) : null;
          const parseIdentity = (line: string): { name: string; email: string; date: string } => {
            const match = /^(.*?) <(.*?)> (\d+) ([+-]\d+)$/.exec(line);
            if (match === null) return { name: line, email: '', date: '2025-01-01T00:00:00Z' };
            return {
              name: match[1] as string,
              email: match[2] as string,
              date: new Date(parseInt(match[3] as string, 10) * 1000).toISOString(),
            };
          };
          const author = parseIdentity(view?.author ?? '');
          const committer = parseIdentity(view?.committer ?? '');
          return {
            sha,
            commit: {
              // Git stores the message with a trailing newline; the API
              // surface presents it without one.
              message: (view?.message ?? '').replace(/\n+$/, ''),
              author: { name: author.name, email: author.email, date: author.date },
              committer: { name: committer.name, email: committer.email, date: committer.date },
              tree: { sha: view?.tree ?? '' },
              verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
            },
            author: { login: author.name, id: 1, type: 'User' },
            committer: { login: committer.name, id: 1, type: 'User' },
            parents: (view?.parents ?? []).map((p) => ({ sha: p })),
            url: `/api/v3/repos/${ownerLogin()}/${repo.name}/commits/${sha}`,
            html_url: `/${ownerLogin()}/${repo.name}/commit/${sha}`,
          };
        });
        const { page } = paginate(commits, query);
        sendJson(res, 200, page);
        return;
      }

      // Git Data API: refs.
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'POST' && rest.length === 2) {
          let parsed: unknown;
          try {
            parsed = parseJsonBody(body);
          } catch {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          const input = (parsed ?? {}) as Record<string, unknown>;
          const ref = typeof input.ref === 'string' ? input.ref : '';
          const sha = typeof input.sha === 'string' ? input.sha : '';
          if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
            sendError(res, 422, 'Validation Failed: the ref or sha is invalid');
            return;
          }
          if (repo.refs.has(ref)) {
            sendError(res, 422, `Validation Failed: the ref ${ref} already exists`);
            return;
          }
          repo.refs.set(ref, sha);
          sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${ownerLogin()}/${repo.name}/git/commits/${sha}` }, url: `/api/v3/repos/${ownerLogin()}/${repo.name}/git/refs/${ref}` });
          return;
        }
        if (method === 'GET') {
          if (rest.length === 2) {
            const refs = [...repo.refs.entries()].sort().map(([ref, sha]) => ({
              ref,
              object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${ownerLogin()}/${repo.name}/git/commits/${sha}` },
              url: `/api/v3/repos/${ownerLogin()}/${repo.name}/git/refs/${ref}`,
            }));
            sendJson(res, 200, refs);
            return;
          }
          // /git/refs/heads/{branch} (branch names may hold slashes).
          const refPath = rest.slice(2).join('/');
          const fullRef = `refs/${refPath}`;
          const sha = repo.refs.get(fullRef);
          if (sha === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, { ref: fullRef, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${ownerLogin()}/${repo.name}/git/commits/${sha}` }, url: `/api/v3/repos/${ownerLogin()}/${repo.name}/git/refs/${fullRef}` });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // Contents.
      if (rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/');
        const refParam = query.get('ref');
        const branch = refParam ?? repo.defaultBranch;
        if (method === 'GET') {
          const tip = store.resolveRef(repo, branch);
          if (tip === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const commit = repo.objects.get(tip);
          if (!commit || commit.type !== 'commit') {
            sendError(res, 404, 'Not Found');
            return;
          }
          const treeOid = parseCommit(commit.data).tree;
          const login = ownerLogin();
          if (filePath === '') {
            const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)).map((entry) => {
              const isDir = entry.mode === '40000';
              const blob = isDir ? null : repo.objects.get(entry.oid);
              return {
                type: isDir ? 'dir' : 'file',
                name: entry.name,
                path: entry.name,
                sha: entry.oid,
                size: isDir ? 0 : (blob?.data.length ?? 0),
                url: `/api/v3/repos/${login}/${repo.name}/contents/${entry.name}`,
                html_url: `/${login}/${repo.name}/blob/${branch}/${entry.name}`,
                download_url: isDir ? null : `/${login}/${repo.name}/raw/${branch}/${entry.name}`,
              };
            });
            sendJson(res, 200, entries);
            return;
          }
          const found = readPath(treeOid, filePath, (oid) => repo.objects.get(oid));
          if (found === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (found.mode === '40000') {
            const dirTree = repo.objects.get(found.oid);
            const entries = parseTree(dirTree?.data ?? Buffer.alloc(0)).map((entry) => {
              const isDir = entry.mode === '40000';
              const blob = isDir ? null : repo.objects.get(entry.oid);
              return {
                type: isDir ? 'dir' : 'file',
                name: entry.name,
                path: `${filePath}/${entry.name}`,
                sha: entry.oid,
                size: isDir ? 0 : (blob?.data.length ?? 0),
                url: `/api/v3/repos/${login}/${repo.name}/contents/${filePath}/${entry.name}`,
                html_url: `/${login}/${repo.name}/blob/${branch}/${filePath}/${entry.name}`,
                download_url: isDir ? null : `/${login}/${repo.name}/raw/${branch}/${filePath}/${entry.name}`,
              };
            });
            sendJson(res, 200, entries);
            return;
          }
          const blob = repo.objects.get(found.oid);
          if (!blob) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const name = filePath.split('/').pop() as string;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: found.oid,
            size: blob.data.length,
            name,
            path: filePath,
            url: `/api/v3/repos/${login}/${repo.name}/contents/${filePath}`,
            html_url: `/${login}/${repo.name}/blob/${branch}/${filePath}`,
            download_url: `/${login}/${repo.name}/raw/${branch}/${filePath}`,
          });
          return;
        }
        if (method === 'PUT') {
          let parsed: unknown;
          try {
            parsed = parseJsonBody(body);
          } catch {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          const input = (parsed ?? {}) as Record<string, unknown>;
          const message = typeof input.message === 'string' ? input.message : 'Update file';
          const contentB64 = typeof input.content === 'string' ? input.content : '';
          const content = b64decode(contentB64);
          const sha = typeof input.sha === 'string' ? input.sha : undefined;
          const targetBranch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
          let tip = store.branchTip(repo, targetBranch);
          if (tip === null && targetBranch !== repo.defaultBranch) {
            // Create the branch from the default tip so a contents write can
            // open a branch that does not exist yet.
            const defaultTip = store.branchTip(repo, repo.defaultBranch);
            if (defaultTip !== null) {
              repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
              tip = defaultTip;
            }
          }
          const existing = tip === null ? null : store.fileAt(repo, tip, filePath);
          if (existing !== null && sha === undefined) {
            sendError(res, 422, 'Validation Failed: the file exists; pass its sha to update it');
            return;
          }
          if (existing !== null && sha !== undefined && sha !== existing.oid) {
            sendError(res, 409, 'Conflict: the sha does not match the current file');
            return;
          }
          if (existing === null && sha !== undefined) {
            sendError(res, 422, 'Validation Failed: the file does not exist');
            return;
          }
          const isUpdate = existing !== null;
          const { commitSha, blobSha } = store.commitFile(repo, {
            branch: targetBranch,
            path: filePath,
            content,
            message,
            author: authorLine(),
          });
          const name = filePath.split('/').pop() as string;
          sendJson(res, isUpdate ? 200 : 201, {
            content: {
              name,
              path: filePath,
              sha: blobSha,
              size: content.length,
              type: 'file',
              encoding: 'base64',
              content: content.toString('base64'),
              url: `/api/v3/repos/${ownerLogin()}/${repo.name}/contents/${filePath}`,
            },
            commit: { sha: commitSha, message, author: { name: ownerLogin(), email: `${ownerLogin()}@example.invalid` }, committer: { name: ownerLogin(), email: `${ownerLogin()}@example.invalid` } },
          });
          return;
        }
        if (method === 'DELETE') {
          let parsed: unknown;
          try {
            parsed = parseJsonBody(body);
          } catch {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          const input = (parsed ?? {}) as Record<string, unknown>;
          const message = typeof input.message === 'string' ? input.message : 'Delete file';
          const sha = typeof input.sha === 'string' ? input.sha : undefined;
          const tip = store.branchTip(repo, repo.defaultBranch);
          if (tip === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const existing = store.fileAt(repo, tip, filePath);
          if (existing === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (sha !== undefined && sha !== existing.oid) {
            sendError(res, 409, 'Conflict: the sha does not match the current file');
            return;
          }
          const { commitSha } = store.commitFile(repo, {
            branch: repo.defaultBranch,
            path: filePath,
            content: null,
            message,
            author: authorLine(),
          });
          sendJson(res, 200, { commit: { sha: commitSha, message } });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // Labels.
      if (rest[0] === 'labels') {
        if (method === 'GET') {
          sendJson(res, 200, [...repo.labels.values()].map((label) => ({
            name: label.name,
            color: label.color,
            description: '',
            default: false,
            url: `/api/v3/repos/${ownerLogin()}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
          })));
          return;
        }
        if (method === 'POST') {
          let parsed: unknown;
          try {
            parsed = parseJsonBody(body);
          } catch {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          const input = (parsed ?? {}) as Record<string, unknown>;
          const name = typeof input.name === 'string' ? input.name : '';
          if (name === '') {
            sendError(res, 422, 'Validation Failed: a label name is required');
            return;
          }
          const color = typeof input.color === 'string' ? input.color : 'ededed';
          repo.labels.set(name, { name, color });
          sendJson(res, 201, {
            name,
            color,
            description: '',
            default: false,
            url: `/api/v3/repos/${ownerLogin()}/${repo.name}/labels/${encodeURIComponent(name)}`,
          });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // Issues.
      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = (query.get('state') ?? 'open').toLowerCase();
            const sort = (query.get('sort') ?? 'created').toLowerCase();
            const direction = (query.get('direction') ?? (sort === 'created' ? 'desc' : 'desc')).toLowerCase();
            let list = [...repo.issues];
            if (state !== 'all') list = list.filter((i) => i.state === state);
            if (sort === 'created') {
              list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
            }
            const { page, hasNext, pageNum, perPage, totalPages } = paginate(list, query);
            const extra: Record<string, string> = {};
            if (hasNext || pageNum > 1) extra.link = linkHeader(req, `/api/v3/repos/${ownerLogin()}/${repo.name}/issues`, query, pageNum, perPage, totalPages);
            sendJson(res, 200, page.map((i) => issueJson(repo, i)), extra);
            return;
          }
          if (method === 'POST') {
            let parsed: unknown;
            try {
              parsed = parseJsonBody(body);
            } catch {
              sendError(res, 400, 'Invalid JSON body');
              return;
            }
            const input = (parsed ?? {}) as Record<string, unknown>;
            const title = typeof input.title === 'string' ? input.title : '';
            if (title === '') {
              sendError(res, 422, 'Validation Failed: a title is required');
              return;
            }
            const labels = Array.isArray(input.labels) ? (input.labels as unknown[]).map(String) : [];
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                sendError(res, 422, `Validation Failed: the label ${label} does not exist`);
                return;
              }
            }
            const bodyText = typeof input.body === 'string' ? input.body : '';
            const issue: Issue = {
              id: store.nextIssueId,
              number: repo.nextNumber,
              title,
              body: bodyText,
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
            sendJson(res, 201, issueJson(repo, issue));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        const number = parseInt(rest[1] as string, 10);
        const issue = repo.issues.find((i) => i.number === number);
        if (rest.length === 2) {
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          if (method === 'PATCH') {
            let parsed: unknown;
            try {
              parsed = parseJsonBody(body);
            } catch {
              sendError(res, 400, 'Invalid JSON body');
              return;
            }
            const input = (parsed ?? {}) as Record<string, unknown>;
            if (typeof input.title === 'string') issue.title = input.title;
            if (typeof input.body === 'string') issue.body = input.body;
            if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
            if (Array.isArray(input.labels)) {
              const labels = (input.labels as unknown[]).map(String);
              for (const label of labels) {
                if (!repo.labels.has(label)) {
                  sendError(res, 422, `Validation Failed: the label ${label} does not exist`);
                  return;
                }
              }
              issue.labels = labels;
            }
            issue.updatedAt = store.nextIso();
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => ({
              id: comment.id,
              node_id: b64encode(`C:${repo.id}:${issue.number}:${comment.id}`),
              body: comment.body,
              user: { login: ownerLogin(), id: 1, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
              html_url: `/${ownerLogin()}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
              url: `/api/v3/repos/${ownerLogin()}/${repo.name}/issues/comments/${comment.id}`,
              issue_url: `/api/v3/repos/${ownerLogin()}/${repo.name}/issues/${issue.number}`,
            })));
            return;
          }
          if (method === 'POST') {
            let parsed: unknown;
            try {
              parsed = parseJsonBody(body);
            } catch {
              sendError(res, 400, 'Invalid JSON body');
              return;
            }
            const input = (parsed ?? {}) as Record<string, unknown>;
            const commentBody = typeof input.body === 'string' ? input.body : '';
            const commentId = repo.nextCommentId;
            repo.nextCommentId += 1;
            const createdAt = store.nextIso();
            issue.comments.push({ id: commentId, body: commentBody, createdAt });
            issue.updatedAt = createdAt;
            sendJson(res, 201, {
              id: commentId,
              node_id: b64encode(`C:${repo.id}:${issue.number}:${commentId}`),
              body: commentBody,
              user: { login: ownerLogin(), id: 1, type: 'User' },
              created_at: createdAt,
              updated_at: createdAt,
              html_url: `/${ownerLogin()}/${repo.name}/issues/${issue.number}#issuecomment-${commentId}`,
              url: `/api/v3/repos/${ownerLogin()}/${repo.name}/issues/comments/${commentId}`,
              issue_url: `/api/v3/repos/${ownerLogin()}/${repo.name}/issues/${issue.number}`,
            });
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // Pull requests.
      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = (query.get('state') ?? 'open').toLowerCase();
            let list = [...repo.pulls];
            if (state !== 'all') list = list.filter((p) => p.state === state);
            list.sort((a, b) => b.seq - a.seq);
            const { page, hasNext, pageNum, perPage, totalPages } = paginate(list, query);
            const extra: Record<string, string> = {};
            if (hasNext || pageNum > 1) extra.link = linkHeader(req, `/api/v3/repos/${ownerLogin()}/${repo.name}/pulls`, query, pageNum, perPage, totalPages);
            sendJson(res, 200, page.map((p) => prJson(repo, p)), extra);
            return;
          }
          if (method === 'POST') {
            let parsed: unknown;
            try {
              parsed = parseJsonBody(body);
            } catch {
              sendError(res, 400, 'Invalid JSON body');
              return;
            }
            const input = (parsed ?? {}) as Record<string, unknown>;
            const title = typeof input.title === 'string' ? input.title : '';
            if (title === '') {
              sendError(res, 422, 'Validation Failed: a title is required');
              return;
            }
            let headRef = typeof input.head === 'string' ? input.head : '';
            let baseRef = typeof input.base === 'string' ? input.base : repo.defaultBranch;
            if (headRef.includes(':')) headRef = (headRef.split(':').pop() as string);
            if (baseRef.includes(':')) baseRef = (baseRef.split(':').pop() as string);
            const headSha = store.branchTip(repo, headRef);
            const baseSha = store.branchTip(repo, baseRef);
            if (headSha === null || baseSha === null) {
              sendError(res, 422, 'Validation Failed: the head or base branch was not found');
              return;
            }
            const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
            if (existing !== undefined) {
              sendError(res, 422, 'Validation Failed: a pull request already exists for this head branch');
              return;
            }
            const pr: PullRequest = {
              id: store.nextPullId,
              number: repo.nextNumber,
              title,
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
              createdAt: store.nextIso(),
              updatedAt: '',
            };
            store.nextPullId += 1;
            repo.nextNumber += 1;
            pr.updatedAt = pr.createdAt;
            repo.pulls.push(pr);
            sendJson(res, 201, prJson(repo, pr));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        const number = parseInt(rest[1] as string, 10);
        const pr = repo.pulls.find((p) => p.number === number);
        if (rest.length === 2) {
          if (pr === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, prJson(repo, pr));
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (pr === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const baseCommit = repo.objects.get(pr.baseSha);
          const headCommit = repo.objects.get(pr.headSha);
          if (!baseCommit || !headCommit) {
            sendJson(res, 200, []);
            return;
          }
          const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
          sendJson(res, 200, files.map((f) => ({
            sha: '',
            filename: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: '',
            raw_url: '',
            contents_url: '',
            patch: '',
          })));
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pr === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (pr.merged || pr.state === 'closed') {
            sendError(res, 405, 'Method Not Allowed: the pull request is already closed');
            return;
          }
          const sha = store.mergePullRequest(repo, pr, authorLine());
          if (sha === null) {
            sendError(res, 405, 'Method Not Allowed: the pull request conflicts with its base branch');
            return;
          }
          sendJson(res, 200, { sha, merged: true, message: `Pull request successfully merged and closed.\n\n${pr.title} (#${pr.number})` });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
  }

  // ---------------------------------------------------------------- dispatch

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawPath = pathOf(req);
        const query = queryOf(req);
        const method = req.method ?? 'GET';
        const segments = segmentsOf(rawPath);

        if (method === 'GET' && rawPath === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          handleGit(req, res, segments, body);
          return;
        }

        // GraphQL.
        if (rawPath === '/api/graphql') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = parseJsonBody(raw);
          } catch {
            sendJson(res, 400, { data: null, errors: [{ message: 'Invalid JSON body' }] });
            return;
          }
          const out = handleGraphQL(store, parsed);
          sendJson(res, 200, out);
          return;
        }

        // MCP.
        if (rawPath === '/mcp') {
          if (method !== 'POST') {
            sendError(res, 405, 'Method Not Allowed');
            return;
          }
          if (!authorized(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'content-length': 0, 'x-github-request-id': requestId() });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          if (Array.isArray(parsed)) {
            const results: unknown[] = [];
            for (const item of parsed) {
              const result = handleMcpRequest(store, item);
              if (result !== null) results.push(result);
            }
            sendJson(res, 200, results);
            return;
          }
          const result = handleMcpRequest(store, parsed);
          if (result === null) {
            res.writeHead(202, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        // REST v3.
        if (rawPath === '/api/v3' || rawPath.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          const restSegments = segments.slice(2);
          let body = Buffer.alloc(0);
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            body = await readBody(req);
          }
          await handleRest(req, res, restSegments, body, rawPath, query);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
}
