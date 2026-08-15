// calendar.js — month-grid view over an already-filtered talks array.
// Pure rendering: it never re-filters (main.js owns filters). Given the filtered
// talks, it buckets them by local day, draws a month grid with per-day chips, and
// reveals a day's talks in a panel below the grid. Talks with no start date land
// in an "Undated" section so nothing silently disappears.

import { card, esc } from './card.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MAX_CHIPS = 3; // chips shown in a cell before collapsing to "+N more"

// Module-local UI state, persisted across re-renders (filter changes, month nav).
// `cursor` is the displayed month; `selectedKey` is the open day, if any.
const view = { cursor: null, selectedKey: null };

// Local YYYY-MM-DD key from a naive ISO string. datetime_start is local time with
// no tz suffix, so we read the calendar-date prefix directly — no Date/tz round-trip.
function dayKey(iso) {
  return iso ? iso.slice(0, 10) : null;
}

function keyFor(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Group talks by local day key; collect undated separately. Within a day, order by
// start time ascending.
function bucket(talks) {
  const byDay = new Map();
  const undated = [];
  for (const t of talks) {
    const key = dayKey(t.datetime_start);
    if (!key) {
      undated.push(t);
      continue;
    }
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.datetime_start < b.datetime_start ? -1 : 1));
  }
  return { byDay, undated };
}

// Land on a month that has content: soonest upcoming dated talk, else the latest,
// else today. Only used to seed the cursor the first time (or after it's reset).
function defaultCursor(talks) {
  const dated = talks
    .map((t) => t.datetime_start)
    .filter(Boolean)
    .sort();
  if (dated.length === 0) return firstOfThisMonth();
  const todayKey = keyOfToday();
  const upcoming = dated.find((iso) => iso.slice(0, 10) >= todayKey);
  const pick = upcoming ?? dated[dated.length - 1];
  const d = new Date(pick);
  return { year: d.getFullYear(), month: d.getMonth() };
}

function firstOfThisMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function keyOfToday() {
  const n = new Date();
  return keyFor(n.getFullYear(), n.getMonth(), n.getDate());
}

// Chip label: strip markdown/LaTeX to plain text so chips stay single-line and safe.
// (Full rich rendering happens in the day panel.) Titles can carry $…$ math and
// markdown; here we just want a terse, escaped label.
function chipLabel(title) {
  const plain = String(title)
    .replace(/\$[^$]*\$/g, '') // drop inline math
    .replace(/[*_`#>]/g, '') // drop common markdown marks
    .replace(/\s+/g, ' ')
    .trim();
  return esc(plain || 'Untitled talk');
}

export function renderCalendar(talks, container, onNeedsRerender) {
  const { byDay, undated } = bucket(talks);

  if (view.cursor === null) view.cursor = defaultCursor(talks);
  // Keep a selected day only if it still has talks after a filter change.
  if (view.selectedKey && !byDay.has(view.selectedKey)) view.selectedKey = null;

  const { year, month } = view.cursor;
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = keyOfToday();

  // Build leading blanks + day cells, padded to full weeks (multiple of 7).
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const weekdayHeader = WEEKDAYS.map(
    (w) => `<div class="cal-weekday" aria-hidden="true">${w}</div>`,
  ).join('');

  const cellsHtml = cells
    .map((day) => {
      if (day === null) return `<div class="cal-cell cal-cell--blank"></div>`;
      const key = keyFor(year, month, day);
      const dayTalks = byDay.get(key) ?? [];
      const isToday = key === todayKey;
      const isSelected = key === view.selectedKey;
      const hasTalks = dayTalks.length > 0;

      const chips = dayTalks
        .slice(0, MAX_CHIPS)
        .map((t) => {
          const time = timeLabel(t.datetime_start);
          return `<span class="cal-chip"${time ? ` title="${time} · ${chipLabel(t.title)}"` : ''}>${
            time ? `<span class="cal-chip-time">${esc(time)}</span>` : ''
          }<span class="cal-chip-title">${chipLabel(t.title)}</span></span>`;
        })
        .join('');
      const more =
        dayTalks.length > MAX_CHIPS
          ? `<span class="cal-more">+${dayTalks.length - MAX_CHIPS} more</span>`
          : '';

      const classes = [
        'cal-cell',
        hasTalks ? 'cal-cell--has' : '',
        isToday ? 'cal-cell--today' : '',
        isSelected ? 'cal-cell--selected' : '',
      ]
        .filter(Boolean)
        .join(' ');

      // Only days with talks are interactive.
      const interactive = hasTalks
        ? `role="button" tabindex="0" aria-pressed="${isSelected}" aria-label="${esc(
            new Date(year, month, day).toLocaleDateString(undefined, {
              weekday: 'long', month: 'long', day: 'numeric',
            }),
          )}, ${dayTalks.length} talk${dayTalks.length === 1 ? '' : 's'}"`
        : 'aria-hidden="false"';

      return `<div class="${classes}" data-day="${key}" ${interactive}>
        <span class="cal-daynum">${day}</span>
        <span class="cal-dots" aria-hidden="true">${
          hasTalks ? `<span class="cal-dot"></span>`.repeat(Math.min(dayTalks.length, 3)) : ''
        }</span>
        <span class="cal-chips">${chips}${more}</span>
      </div>`;
    })
    .join('');

  const panelHtml = view.selectedKey
    ? dayPanel(view.selectedKey, byDay.get(view.selectedKey) ?? [])
    : '';

  const undatedHtml = undated.length ? undatedSection(undated) : '';

  const totalDated = talks.length - undated.length;

  container.innerHTML = `
    <div class="cal-head">
      <div class="cal-nav">
        <button class="cal-btn" data-nav="prev" aria-label="Previous month">‹</button>
        <button class="cal-btn" data-nav="today">Today</button>
        <button class="cal-btn" data-nav="next" aria-label="Next month">›</button>
      </div>
      <h2 class="cal-title">${MONTHS[month]} ${year}</h2>
      <p class="cal-count">${totalDated} scheduled talk${totalDated === 1 ? '' : 's'}</p>
    </div>
    <div class="cal-grid" role="grid" aria-label="${MONTHS[month]} ${year}">
      ${weekdayHeader}
      ${cellsHtml}
    </div>
    <div class="cal-panel-slot">${panelHtml}</div>
    ${undatedHtml}
  `;

  wire(container, onNeedsRerender);
}

function dayPanel(key, dayTalks) {
  const d = new Date(`${key}T00:00:00`);
  const heading = d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  // Reuse the full List-view card so the day panel shows the complete talk
  // (abstract, context, AI prerequisites, source) — one card renderer, no drift.
  // A day is already narrowed to a few talks — show detail expanded.
  const items = dayTalks.map((t) => card(t, { expanded: true })).join('');
  return `
    <section class="cal-panel" aria-label="Talks on ${esc(heading)}">
      <div class="cal-panel-head">
        <h3>${esc(heading)}</h3>
        <button class="cal-btn cal-panel-close" data-close-panel aria-label="Close day">Close</button>
      </div>
      ${items}
    </section>`;
}

function undatedSection(undated) {
  const items = undated.map((t) => card(t, { expanded: true })).join('');
  return `
    <section class="cal-undated" aria-label="Talks without a scheduled date">
      <h3>Undated <span class="cal-undated-count">${undated.length}</span></h3>
      <p class="cal-undated-note">These matching talks have no confirmed date yet.</p>
      ${items}
    </section>`;
}

function wire(container, onNeedsRerender) {
  container.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.nav;
      if (dir === 'today') {
        view.cursor = firstOfThisMonth();
      } else {
        const delta = dir === 'prev' ? -1 : 1;
        const { year, month } = view.cursor;
        const nd = new Date(year, month + delta, 1);
        view.cursor = { year: nd.getFullYear(), month: nd.getMonth() };
      }
      onNeedsRerender();
    });
  });

  container.querySelectorAll('.cal-cell--has').forEach((cell) => {
    const select = () => {
      const key = cell.dataset.day;
      view.selectedKey = view.selectedKey === key ? null : key;
      onNeedsRerender();
    };
    cell.addEventListener('click', select);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
  });

  const close = container.querySelector('[data-close-panel]');
  if (close) {
    close.addEventListener('click', () => {
      view.selectedKey = null;
      onNeedsRerender();
    });
  }
}

// Let main.js reset month/selection when switching away and back, if desired.
export function resetCalendarView() {
  view.cursor = null;
  view.selectedKey = null;
}
