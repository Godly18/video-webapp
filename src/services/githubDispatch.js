/** Triggers a GitHub Actions workflow_dispatch. Needs a fine-grained token with "Actions: Read and write" on the repo. */
export function createGithubDispatcher({ token, repo, workflow = 'render-job.yml', ref = 'main', fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('GH_REPO must look like owner/repo');
  if (!token) throw new Error('GH_DISPATCH_TOKEN is missing');
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  return {
    async dispatch(inputs) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'still-image-video-generator' },
        body: JSON.stringify({ ref, inputs }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 204) throw new Error(`GitHub dispatch failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    },
  };
}
