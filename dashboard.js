'use strict';

// ---------- settings ----------
const DEFAULTS = { region: 'com', count: '10', interval: '5', flaggedOnly: false };
let settings = { ...DEFAULTS };
let timer = null;
let nextAt = 0;

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function ago(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}

function clockTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---------- Downdetector ----------
// Pulls a JSON array out of a string by bracket matching, respecting quoted strings.
function grabArray(s, key) {
  const k = s.indexOf('"' + key + '":[');
  if (k < 0) return null;
  const p = s.indexOf('[', k);
  let depth = 0, inStr = false, esc = false;
  for (let j = p; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(p, j + 1));
    }
  }
  return null;
}

function parseDowndetector(html) {
  if (/Just a moment|cf-challenge|challenge-platform/i.test(html) && html.indexOf('topCompanies') < 0) {
    const e = new Error('Cloudflare check'); e.cloudflare = true; throw e;
  }
  const i = html.indexOf('topCompanies');
  if (i < 0) throw new Error('Downdetector page layout changed (no top list found)');
  const start = html.lastIndexOf('self.__next_f.push(', i) + 'self.__next_f.push('.length;
  const end = html.indexOf(')</script>', i);
  const payload = JSON.parse(html.slice(start, end))[1];
  const list = grabArray(payload, 'topCompanies');
  if (!Array.isArray(list)) throw new Error('Could not read the top list');
  return list;
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function sparkSvg(values, base, status) {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 220, h = 34, pad = 2;
  const max = Math.max(1, ...values);
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, values.length - 1);
  const y = (v) => h - pad - (v / max) * (h - 2 * pad);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  const color = status === 'danger' ? 'var(--danger)' : status === 'warning' ? 'var(--warn)' : 'var(--ok)';

  const area = document.createElementNS(NS, 'path');
  let d = `M ${x(0)} ${h - pad}`;
  values.forEach((v, i) => { d += ` L ${x(i)} ${y(v)}`; });
  d += ` L ${x(values.length - 1)} ${h - pad} Z`;
  area.setAttribute('d', d);
  area.setAttribute('fill', color);
  area.setAttribute('fill-opacity', '0.15');
  svg.append(area);

  const bl = document.createElementNS(NS, 'line');
  bl.setAttribute('x1', pad); bl.setAttribute('x2', w - pad);
  bl.setAttribute('y1', y(base)); bl.setAttribute('y2', y(base));
  bl.setAttribute('stroke', 'var(--spark-base)');
  bl.setAttribute('stroke-dasharray', '3 3');
  bl.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(bl);

  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', values.map((v, i) => `${x(i)},${y(v)}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  return svg;
}

const STATUS_LABEL = { danger: 'Outage', warning: 'Possible problems', success: 'Normal' };
const STATUS_PILL = { danger: 'pill-danger', warning: 'pill-warn', success: 'pill-ok' };

async function loadDowndetector() {
  const host = 'downdetector.' + settings.region;
  const box = $('ddList');
  try {
    const res = await fetch(`https://${host}/`, { credentials: 'include', cache: 'no-store' });
    const html = await res.text();
    if (!res.ok && html.indexOf('topCompanies') < 0) {
      const e = new Error('HTTP ' + res.status); e.cloudflare = res.status === 403 || res.status === 429; throw e;
    }
    const list = parseDowndetector(html);
    renderDowndetector(list, host);
    return list;
  } catch (err) {
    box.replaceChildren(ddError(err, host));
    $('ddMeta').textContent = 'Last attempt ' + clockTime();
    return null;
  }
}

function ddError(err, host) {
  const box = el('div', { class: 'error' });
  if (err.cloudflare) {
    box.append(
      'Downdetector asked for a browser check. ',
      el('a', { href: `https://${host}/`, target: '_blank', rel: 'noopener', text: `Open ${host}` }),
      ' in a normal tab once, let it load, then press Refresh now.'
    );
  } else {
    box.append('Could not load Downdetector: ' + (err.message || err));
  }
  return box;
}

function renderDowndetector(list, host) {
  const n = parseInt(settings.count, 10);
  let rows = list.map((c, idx) => {
    const spark = (c.stats && c.stats.sparkline) || [];
    const now = spark.length ? spark[spark.length - 1] : 0;
    const base = spark.length ? median(spark) : 0;
    return {
      rank: idx + 1,
      name: c.name,
      slug: c.slug,
      category: c.category && c.category.slug ? c.category.slug.replace(/-/g, ' ') : '',
      logo: c.logo ? 'https://cdn3.downdetector.com/cdn-cgi/image/width=96/https://cdn2.downdetector.com/static/uploads/' + c.logo : null,
      status: (c.stats && c.stats.status) || 'success',
      spark, now, base,
      peak: spark.length ? Math.max(...spark) : 0,
      at: c.stats && c.stats.stats24CalculatedAt,
    };
  });
  if (settings.flaggedOnly) rows = rows.filter((r) => r.status !== 'success');
  rows = rows.slice(0, n);

  const flagged = list.filter((c) => c.stats && c.stats.status === 'danger').length;
  const warned = list.filter((c) => c.stats && c.stats.status === 'warning').length;
  const pill = $('overall');
  pill.className = 'pill ' + (flagged >= 3 ? 'pill-danger' : flagged || warned ? 'pill-warn' : 'pill-ok');
  pill.textContent = `${flagged} outage${flagged === 1 ? '' : 's'} · ${warned} warning${warned === 1 ? '' : 's'} on ${host}`;

  if (!rows.length) {
    $('ddList').replaceChildren(el('div', { class: 'empty', text: 'Nothing flagged right now.' }));
  } else {
    $('ddList').replaceChildren(...rows.map((r) => {
      const url = `https://${host}/status/${r.slug}/`;
      const ratio = r.base > 0 ? r.now / r.base : r.now;
      const logo = r.logo
        ? el('img', { class: 'logo', src: r.logo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : el('div', { class: 'logo blank' });
      if (r.logo) logo.addEventListener('error', () => { logo.replaceWith(el('div', { class: 'logo blank' })); });
      return el('div', { class: 'dd-row ' + r.status, title: `Peak in 24 h: ${r.peak}` },
        el('div', { class: 'rank', text: String(r.rank) }),
        logo,
        el('div', { class: 'name' },
          el('a', { href: url, target: '_blank', rel: 'noopener', text: r.name }),
          el('span', { class: 'cat', text: r.category })),
        el('div', { class: 'ratio' }, el('span', { class: 'pill ' + STATUS_PILL[r.status], text: STATUS_LABEL[r.status] || r.status })),
        el('div', { class: 'nums' },
          el('div', { class: 'now', text: r.now.toLocaleString() }),
          el('div', { class: 'base', text: `normal ${Math.round(r.base)}` + (ratio >= 2 ? ` · ×${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}` : '') })),
        el('div', { class: 'spark-cell' }, sparkSvg(r.spark, r.base, r.status)));
    }));
  }
  const at = rows[0] && rows[0].at;
  $('ddMeta').textContent = 'Updated ' + clockTime() + (at ? ` · data ${ago(at)}` : '');
}

// ---------- official status pages ----------
const IMPACT_RANK = { critical: 0, major: 1, minor: 2, none: 3 };

async function loadStatus() {
  try {
    const res = await fetch('https://somesystemsoperational.com/api/v2/summary.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const names = Object.fromEntries((data.components || []).map((c) => [c.id, c.name]));
    const inc = (data.incidents || [])
      .slice()
      // newest first, so fresh incidents are on top; ties broken by severity
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at)
        || (IMPACT_RANK[a.impact] ?? 4) - (IMPACT_RANK[b.impact] ?? 4));
    const c = data.counts || {};
    $('stMeta').textContent = `${c.major_outage || 0} major · ${c.partial_outage || 0} partial · ${c.degraded || 0} degraded · ${clockTime()}`;
    if (!inc.length) {
      $('stList').replaceChildren(el('div', { class: 'empty', text: 'No open incidents on tracked status pages.' }));
      return;
    }
    $('stList').replaceChildren(...inc.slice(0, 20).map((i) => {
      const cls = i.impact === 'critical' || i.impact === 'major' ? 'major' : i.impact === 'minor' ? 'minor' : '';
      return el('div', { class: 'st-item ' + cls },
        el('div', { class: 'st-top' },
          el('span', { class: 'st-name', text: names[i.component_id] || i.component_id }),
          el('span', { class: 'st-time', text: ago(i.started_at) })),
        el('div', { class: 'st-title' },
          i.shortlink
            ? el('a', { href: i.shortlink, target: '_blank', rel: 'noopener', text: i.name })
            : document.createTextNode(i.name)),
        el('div', { class: 'small muted', text: `${i.status}${i.impact && i.impact !== 'none' ? ' · ' + i.impact + ' impact' : ''}` }));
    }));
  } catch (err) {
    $('stList').replaceChildren(el('div', { class: 'error', text: 'Could not load status pages: ' + (err.message || err) }));
  }
}

// ---------- security headlines ----------
const FEEDS = [
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { name: 'The Record', url: 'https://therecord.media/feed' },
];

async function loadNews() {
  const results = await Promise.allSettled(FEEDS.map(async (f) => {
    const res = await fetch(f.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(f.name + ' HTTP ' + res.status);
    const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
    return [...xml.querySelectorAll('item')].slice(0, 15).map((it) => ({
      src: f.name,
      title: (it.querySelector('title') || {}).textContent || '',
      link: (it.querySelector('link') || {}).textContent || '',
      date: new Date((it.querySelector('pubDate') || {}).textContent || 0),
    }));
  }));
  const items = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value)
    .filter((i) => i.title && /^https:\/\//.test(i.link))
    .sort((a, b) => b.date - a.date)
    .slice(0, 12);
  const failed = results.filter((r) => r.status === 'rejected').length;
  $('nwMeta').textContent = clockTime() + (failed ? ` · ${failed} feed failed` : '');
  if (!items.length) {
    $('nwList').replaceChildren(el('li', { class: 'error', text: 'Could not load headlines.' }));
    return;
  }
  $('nwList').replaceChildren(...items.map((i) => el('li', {},
    el('a', { href: i.link, target: '_blank', rel: 'noopener', text: i.title.trim() }),
    el('div', { class: 'nw-src', text: `${i.src} · ${isNaN(i.date) ? '' : ago(i.date)}` }))));
}

// ---------- refresh loop ----------
async function refreshAll() {
  $('refresh').disabled = true;
  await Promise.allSettled([loadDowndetector(), loadStatus(), loadNews()]);
  $('refresh').disabled = false;
  schedule();
}

function schedule() {
  clearTimeout(timer);
  const ms = parseInt(settings.interval, 10) * 60 * 1000;
  nextAt = Date.now() + ms;
  timer = setTimeout(refreshAll, ms);
}

function tickClock() {
  const left = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  const m = Math.floor(left / 60), s = String(left % 60).padStart(2, '0');
  $('clock').textContent = nextAt ? `next in ${m}:${s}` : '';
}

async function init() {
  try {
    const saved = await chrome.storage.local.get(DEFAULTS);
    settings = { ...DEFAULTS, ...saved };
  } catch (_) { /* storage unavailable: use defaults */ }
  $('region').value = settings.region;
  $('count').value = settings.count;
  $('interval').value = settings.interval;
  $('flaggedOnly').checked = !!settings.flaggedOnly;

  const save = async (patch, reload) => {
    settings = { ...settings, ...patch };
    try { await chrome.storage.local.set(patch); } catch (_) { /* ignore */ }
    if (reload) reload();
  };
  $('region').addEventListener('change', (e) => save({ region: e.target.value }, loadDowndetector));
  $('count').addEventListener('change', (e) => save({ count: e.target.value }, loadDowndetector));
  $('flaggedOnly').addEventListener('change', (e) => save({ flaggedOnly: e.target.checked }, loadDowndetector));
  $('interval').addEventListener('change', (e) => save({ interval: e.target.value }, schedule));
  $('refresh').addEventListener('click', refreshAll);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() > nextAt) refreshAll();
  });

  setInterval(tickClock, 1000);
  refreshAll();
}

init();
