const API_ORIGIN = 'https://api.github.com';

// Fetch all starred repos (paginated via Link header).
async function fetchStarred(token) {
  if (!token) throw new Error('No GitHub token configured');
  const out = [];
  let url = 'https://api.github.com/user/starred?per_page=100&sort=created';
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'RepoHub',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    for (const r of await res.json()) {
      out.push({
        id: r.full_name.replace('/', '__'),
        fullName: r.full_name,
        description: r.description,
        language: r.language,
        topics: r.topics || [],
        stars: r.stargazers_count,
        cloneUrl: r.clone_url,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch,
      });
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
    // The token is sent with every request, so never follow a pagination link off GitHub's API host.
    if (next && new URL(next[1]).origin !== API_ORIGIN) throw new Error('Refusing to follow a pagination link outside api.github.com');
    url = next ? next[1] : null;
  }
  return out;
}

module.exports = { fetchStarred };
