// fetch.js — plain HTTP GET for a source page.
//
// Prefer plain fetch. Only reach for a headless browser if a page genuinely needs JS to
// render its seminar list (most .edu department pages are server-rendered — check first).

/**
 * Fetch the raw HTML of a source URL.
 * @param {string} url
 * @returns {Promise<string>} raw HTML
 */
export async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'vt-seminars-aggregator (personal, non-commercial)',
      Accept: 'text/html',
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
