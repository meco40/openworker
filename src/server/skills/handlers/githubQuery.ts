interface GithubResponseItem {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  name?: string;
  path?: string;
  repository?: { full_name?: string };
  pull_request?: unknown;
}

interface GithubRepoInfo {
  full_name?: string;
  description?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  html_url?: string;
}

interface GithubSearchResponse {
  total_count?: number;
  items?: GithubResponseItem[];
}

function getGithubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'openclaw-gateway',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

export async function githubQueryHandler(args: Record<string, unknown>) {
  const repo = String(args.repo || '').trim();
  const action = String(args.action || '').trim();
  const query = String(args.query || '').trim();
  if (!repo || !action) throw new Error('github_query requires repo and action.');

  let url = '';
  if (action === 'repo_info') {
    url = `https://api.github.com/repos/${repo}`;
  } else if (action === 'list_issues') {
    url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=20`;
  } else if (action === 'list_pulls') {
    url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=20`;
  } else if (action === 'search_code') {
    if (!query) throw new Error('search_code requires query.');
    url = `https://api.github.com/search/code?q=${encodeURIComponent(`${query} repo:${repo}`)}&per_page=20`;
  } else {
    throw new Error(`Unsupported github action: ${action}`);
  }

  const response = await fetch(url, { headers: getGithubHeaders() });
  const data = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${JSON.stringify(data)}`);
  }

  if (action === 'repo_info') {
    const repoInfo = data as GithubRepoInfo;
    return {
      full_name: repoInfo.full_name,
      description: repoInfo.description,
      stars: repoInfo.stargazers_count,
      forks: repoInfo.forks_count,
      open_issues: repoInfo.open_issues_count,
      url: repoInfo.html_url,
    };
  }

  if (action === 'list_issues') {
    const issues = (data as GithubResponseItem[])
      .filter((item) => !item.pull_request)
      .map((item) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
      }));
    return { count: issues.length, issues };
  }

  if (action === 'list_pulls') {
    const pulls = (data as GithubResponseItem[]).map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      state: item.state,
      url: item.html_url,
    }));
    return { count: pulls.length, pulls };
  }

  const search = data as GithubSearchResponse;
  const items = (search.items || []).map((item) => ({
    name: item.name,
    path: item.path,
    repo: item.repository?.full_name,
    url: item.html_url,
  }));
  return { total_count: search.total_count || 0, items };
}
