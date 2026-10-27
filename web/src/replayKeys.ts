/** Pure helpers shared by the replay build script (Node) and the page. */

/** Canonical key for a GET path: pathname plus sorted query string. */
export function replayKey(path: string): string {
  const url = new URL(path, 'http://replay.local');
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/** Static file name for a captured download (same rule in scripts/build-static.ts). */
export function replayFileName(path: string): string {
  return `${replayKey(path).replace(/^\/api\//, '').replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
}
