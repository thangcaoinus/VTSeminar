// card.js — the canonical talk row, shared by the Schedule view (main.js) and the
// Calendar day panel (calendar.js) so both render the *full* talk identically.
// "The Timetable" world: each talk is a ruled schedule row — a date gutter on the
// left, then title, a meta register, and expandable abstract / AI context — not a
// rounded feed card.

import { renderRich } from './render.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Split the start datetime into the gutter's stacked parts. Naive local ISO, so we
// read the wall-clock fields directly (matches the rest of the app).
function gutterParts(iso) {
  if (!iso) return { dow: '', mon: 'TBA', day: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { dow: '', mon: 'TBA', day: '', time: '' };
  return {
    dow: DOW[d.getDay()],
    mon: MON[d.getMonth()],
    day: String(d.getDate()),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}

// `expanded` opens the detail by default (used by the Calendar day panel, where a
// day is already narrowed to a few talks). The Schedule view leaves rows collapsed
// so a semester scans like a wall schedule; the title toggles the detail open.
export function card(t, { expanded = false } = {}) {
  const g = gutterParts(t.datetime_start);
  const a = t.annotations ?? {};

  // Meta register: speaker · affiliation on one line, series · location on the next.
  const who = [t.speaker ? esc(t.speaker) : 'Speaker TBA', t.affiliation ? esc(t.affiliation) : '']
    .filter(Boolean)
    .join(' · ');
  const where = [t.series ? esc(t.series) : '', t.location ? esc(t.location) : '']
    .filter(Boolean)
    .join(' · ');

  const prereqs = (a.prerequisites ?? [])
    .map((p) => `<li>${renderRich(p, { inline: true })}</li>`)
    .join('');

  const hasDetail = t.abstract || a.one_line_context || prereqs;

  const detail = hasDetail
    ? `<div class="row-detail">
        ${a.one_line_context ? `<p class="row-context">${renderRich(a.one_line_context, { inline: true })}</p>` : ''}
        ${t.abstract ? `<div class="row-abstract">${renderRich(t.abstract)}</div>` : ''}
        ${prereqs ? `<div class="row-ann"><span class="row-ann-label">Prerequisites <span class="ai-flag">AI</span></span><ul>${prereqs}</ul></div>` : ''}
      </div>`
    : '';

  const open = expanded || !hasDetail; // no detail → nothing to toggle
  const detailId = `d-${t.id}`;

  // The title is the toggle when there's detail to reveal; otherwise plain text.
  const titleInner = renderRich(t.title, { inline: true });
  const titleEl = hasDetail
    ? `<button class="row-title row-toggle" type="button" aria-expanded="${open}" aria-controls="${detailId}">
        ${titleInner}<span class="row-caret" aria-hidden="true"></span>
      </button>`
    : `<h3 class="row-title">${titleInner}</h3>`;

  return `
    <article class="row${open ? ' row--open' : ''}${hasDetail ? '' : ' row--flat'}">
      <div class="row-gutter" aria-hidden="true">
        <span class="row-dow">${esc(g.dow)}</span>
        <span class="row-date"><span class="row-mon">${esc(g.mon)}</span><span class="row-day">${esc(g.day)}</span></span>
        <span class="row-time">${g.time ? esc(g.time) : '—'}</span>
      </div>
      <div class="row-body">
        <span class="row-dept">${esc(t.department)}</span>
        ${titleEl}
        <p class="row-who">${who}</p>
        ${where ? `<p class="row-where">${where}</p>` : ''}
        ${hasDetail ? `<div class="row-detail-wrap" id="${detailId}"${open ? '' : ' hidden'}>${detail}
          <p class="row-src"><a href="${esc(t.source_url)}" target="_blank" rel="noopener">View source ↗</a></p>
        </div>` : `<p class="row-src"><a href="${esc(t.source_url)}" target="_blank" rel="noopener">View source ↗</a></p>`}
      </div>
    </article>`;
}
