// main.js — loads data/seminars.json and filters/searches entirely client-side.
// No backend, no framework. All filtering happens in-browser over the shipped JSON.

import './fonts.js';
import { card } from './card.js';
import { renderCalendar } from './calendar.js';

const state = {
  view: 'list', // 'list' | 'calendar' — both views share the filters below.
  talks: [],
  filters: { search: '', department: '', series: '', from: '', to: '' },
};

const el = {
  list: document.getElementById('list'),
  calendar: document.getElementById('calendar'),
  tabList: document.getElementById('tab-list'),
  tabCalendar: document.getElementById('tab-calendar'),
  count: document.getElementById('count'),
  search: document.getElementById('search'),
  department: document.getElementById('department'),
  series: document.getElementById('series'),
  from: document.getElementById('from'),
  to: document.getElementById('to'),
};

async function load() {
  try {
    const res = await fetch('./data/seminars.json');
    if (!res.ok) throw new Error(`${res.status}`);
    state.talks = await res.json();
  } catch (err) {
    el.list.innerHTML = `<p class="empty">Could not load seminars.json (${err.message}). Run <code>npm run ingest</code>.</p>`;
    return;
  }
  populateFilters();
  render();
}

function populateFilters() {
  const uniq = (key) => [...new Set(state.talks.map((t) => t[key]).filter(Boolean))].sort();
  for (const d of uniq('department')) addOption(el.department, d);
  for (const s of uniq('series')) addOption(el.series, s);
}

function addOption(select, value) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = value;
  select.append(opt);
}

function applyFilters() {
  const { search, department, series, from, to } = state.filters;
  const q = search.trim().toLowerCase();
  return state.talks.filter((t) => {
    if (department && t.department !== department) return false;
    if (series && t.series !== series) return false;
    if (from && t.datetime_start && t.datetime_start < from) return false;
    if (to && t.datetime_start && t.datetime_start > to + 'T23:59:59') return false;
    if (q) {
      const hay = `${t.title} ${t.speaker ?? ''} ${t.abstract ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const talks = applyFilters();
  updateCount(talks.length);
  el.list.hidden = state.view !== 'list';
  el.calendar.hidden = state.view !== 'calendar';
  if (state.view === 'calendar') {
    if (talks.length === 0) {
      el.calendar.innerHTML = `<p class="empty">No talks match these filters.</p>`;
      return;
    }
    renderCalendar(talks, el.calendar, render);
    return;
  }
  if (talks.length === 0) {
    el.list.innerHTML = `<p class="empty">No talks match these filters.</p>`;
    return;
  }
  // A schedule reads forward: what's next, then the rest of the term below.
  el.list.innerHTML = renderSchedule(talks);
}

// Group filtered talks into "Upcoming", "Past", and "Undated" registers under sticky
// rules, so the table reads like a live departmental schedule rather than a flat feed.
// Upcoming reads forward (soonest next); past reads back (most recent first). Talks whose
// date is missing OR fails to parse go in their own Undated register — never Upcoming, so a
// stale talk with an unparseable date can't masquerade as something that hasn't happened yet.
function renderSchedule(talks) {
  const now = Date.now();
  const upcoming = [];
  const past = [];
  const undated = [];
  for (const t of talks) {
    const ts = t.datetime_start ? Date.parse(t.datetime_start) : NaN;
    if (Number.isNaN(ts)) undated.push(t);
    else (ts >= now ? upcoming : past).push(t);
  }
  upcoming.sort(byDateAsc);
  past.sort(byDateDesc);
  const section = (label, rows, note) =>
    rows.length
      ? `<div class="schedule-group"><h2 class="schedule-rule">${label}<span class="schedule-rule-n">${rows.length}</span></h2>${note ? `<p class="schedule-note">${note}</p>` : ''}${rows.map(card).join('')}</div>`
      : '';
  return (
    section('Upcoming', upcoming) +
    section('Past', past) +
    section('Undated', undated, 'These matching talks have no confirmed date (or a date we couldn’t parse).')
  );
}

function updateCount(n) {
  el.count.textContent = `${n} talk${n === 1 ? '' : 's'}`;
}

function setView(view) {
  state.view = view;
  el.tabList.setAttribute('aria-selected', String(view === 'list'));
  el.tabCalendar.setAttribute('aria-selected', String(view === 'calendar'));
  render();
}

// Most recent first. Both registers are pre-filtered to parseable dates, so the guard
// here is belt-and-suspenders only.
function byDateDesc(a, b) {
  const ta = a.datetime_start ? Date.parse(a.datetime_start) : -Infinity;
  const tb = b.datetime_start ? Date.parse(b.datetime_start) : -Infinity;
  return tb - ta;
}

// Soonest first.
function byDateAsc(a, b) {
  const ta = a.datetime_start ? Date.parse(a.datetime_start) : -Infinity;
  const tb = b.datetime_start ? Date.parse(b.datetime_start) : -Infinity;
  return ta - tb;
}

for (const [key, node] of Object.entries({
  search: el.search, department: el.department, series: el.series, from: el.from, to: el.to,
})) {
  node.addEventListener('input', () => {
    state.filters[key] = node.value;
    render();
  });
}

el.tabList.addEventListener('click', () => setView('list'));
el.tabCalendar.addEventListener('click', () => setView('calendar'));

// Expand/collapse a schedule row's detail (abstract + AI context) via its title.
// Delegated so it works for every rendered row without per-row listeners.
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('.row-toggle');
  if (!toggle) return;
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  const detail = document.getElementById(toggle.getAttribute('aria-controls'));
  if (detail) detail.hidden = !open;
  toggle.closest('.row')?.classList.toggle('row--open', open);
});

load();
