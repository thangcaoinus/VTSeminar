// main.js — loads data/seminars.json and filters/searches entirely client-side.
// No backend, no framework. All filtering happens in-browser over the shipped JSON.

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
  el.list.hidden = state.view !== 'list';
  el.calendar.hidden = state.view !== 'calendar';
  if (state.view === 'calendar') {
    if (talks.length === 0) {
      el.calendar.innerHTML = `<p class="empty">No talks match.</p>`;
      return;
    }
    renderCalendar(talks, el.calendar, render);
    return;
  }
  const sorted = talks.slice().sort(byDateDesc);
  if (sorted.length === 0) {
    el.list.innerHTML = `<p class="empty">No talks match.</p>`;
    return;
  }
  el.list.innerHTML = sorted.map(card).join('');
}

function setView(view) {
  state.view = view;
  el.tabList.setAttribute('aria-selected', String(view === 'list'));
  el.tabCalendar.setAttribute('aria-selected', String(view === 'calendar'));
  render();
}

// Most recent first; talks with no date sort to the bottom.
function byDateDesc(a, b) {
  const ta = a.datetime_start ? Date.parse(a.datetime_start) : -Infinity;
  const tb = b.datetime_start ? Date.parse(b.datetime_start) : -Infinity;
  return tb - ta;
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

load();
