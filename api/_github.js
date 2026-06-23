// Shared GitHub API headers for log.js etc.
export const GITHUB_HEADERS = {
  'Authorization': `Bearer ${process.env.GITHUB_TOKEN || ''}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'sewang-monitor-log',
};
