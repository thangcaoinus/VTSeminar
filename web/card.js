// card.js — the canonical talk card, shared by the List view (main.js) and the
// Calendar day panel (calendar.js) so both render the *full* talk identically:
// title, speaker/affiliation, department/series/when/location, abstract,
// one-line context, AI prerequisites, and source link.

import { renderRich } from './render.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function card(t) {
  const when = t.datetime_start
    ? new Date(t.datetime_start).toLocaleString()
    : 'Date TBA';
  const a = t.annotations ?? {};
  // Rich fields (title, abstract, context, prerequisites) may contain markdown + LaTeX
  // math — render them through renderRich. Plain metadata stays HTML-escaped, and the
  // source_url goes in an href attribute (never markdown-rendered).
  const prereqs = (a.prerequisites ?? [])
    .map((p) => `<li>${renderRich(p, { inline: true })}</li>`)
    .join('');
  return `
    <article class="card">
      <h2>${renderRich(t.title, { inline: true })}</h2>
      <p class="meta">${esc(t.speaker ?? 'Speaker TBA')}${
        t.affiliation ? ` · ${esc(t.affiliation)}` : ''
      }</p>
      <p class="meta">${esc(t.department)}${t.series ? ` · ${esc(t.series)}` : ''} · ${esc(when)}${
        t.location ? ` · ${esc(t.location)}` : ''
      }</p>
      ${t.abstract ? `<div class="abstract">${renderRich(t.abstract)}</div>` : ''}
      ${a.one_line_context ? `<div class="context"><em>${renderRich(a.one_line_context, { inline: true })}</em></div>` : ''}
      ${prereqs ? `<div class="ann"><strong>Prerequisites (AI):</strong><ul>${prereqs}</ul></div>` : ''}
      <p class="src"><a href="${esc(t.source_url)}" target="_blank" rel="noopener">source</a></p>
    </article>`;
}
