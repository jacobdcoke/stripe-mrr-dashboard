const express = require('express');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

const WEEKLY_GOAL_CAD = 1000;
const SHEET_ID = '1C7L4NklNeks72uBtXrW4vWYUHak3yEY5QmaW0llKztM';

const LEAD_SHEETS = [
  { name: 'Ads (V4)',      sheet: 'V4 Appt Booked' },
  { name: 'SMS',           sheet: 'SMS'             },
  { name: 'Cold Calling',  sheet: 'Cold Calling'    },
  { name: 'Organic',       sheet: 'Organic'         },
];

function normalizeToMonthly(amount, interval, intervalCount) {
  const dollars = amount / 100;
  switch (interval) {
    case 'day':   return (dollars / intervalCount) * 30.44;
    case 'week':  return (dollars / intervalCount) * 4.348;
    case 'month': return dollars / intervalCount;
    case 'year':  return dollars / (intervalCount * 12);
    default:      return 0;
  }
}

function getWeekStart() {
  const now = new Date();
  const diff = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function parseCSVLine(line) {
  const row = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let j = i + 1, cell = '';
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') { cell += '"'; j += 2; }
        else if (line[j] === '"') { j++; break; }
        else { cell += line[j++]; }
      }
      row.push(cell);
      i = line[j] === ',' ? j + 1 : j;
    } else {
      let j = i;
      while (j < line.length && line[j] !== ',') j++;
      row.push(line.slice(i, j));
      i = j + 1;
    }
  }
  return row;
}

function parseCSV(text) {
  return text.split('\n').filter(l => l.trim()).map(parseCSVLine);
}

function parseMoney(s) {
  if (!s || s === 'N/A') return null;
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function parseNum(s) {
  if (!s || s === 'N/A') return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parsePct(s) {
  if (!s || s === 'N/A') return null;
  const n = parseFloat(s.replace('%', ''));
  return isNaN(n) ? null : n;
}

const MONTH_MAP = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};

function parseSheetDate(s) {
  if (!s) return null;
  s = s.trim().replace(/\n.*/s, '');
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) return new Date(parseInt(m1[3]), parseInt(m1[1]) - 1, parseInt(m1[2]));
  const m2 = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
  if (m2) {
    const mi = MONTH_MAP[m2[1].toLowerCase()];
    if (mi !== undefined) return new Date(parseInt(m2[3] || new Date().getFullYear()), mi, parseInt(m2[2]));
  }
  return null;
}

async function fetchSheetCSV(sheetName) {
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
    '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(sheetName);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to fetch sheet: ' + sheetName);
  return parseCSV(await resp.text());
}

app.get('/api/mrr', async (req, res) => {
  try {
    const weekStart = getWeekStart();
    const weekStartTimestamp = Math.floor(weekStart.getTime() / 1000);
    const subs = [];
    let hasMore = true, startingAfter = undefined;

    while (hasMore) {
      const page = await stripe.subscriptions.list({
        status: 'active', limit: 100,
        created: { gte: weekStartTimestamp },
        expand: ['data.items.data.price'],
        ...(startingAfter && { starting_after: startingAfter }),
      });
      subs.push(...page.data);
      hasMore = page.has_more;
      if (hasMore) startingAfter = page.data[page.data.length - 1].id;
    }

    let mrrAdded = 0;
    for (const sub of subs) {
      for (const item of sub.items.data) {
        const price = item.price;
        if (price?.unit_amount && price?.recurring) {
          mrrAdded += normalizeToMonthly(
            price.unit_amount * (item.quantity || 1),
            price.recurring.interval,
            price.recurring.interval_count
          );
        }
      }
    }

    mrrAdded = Math.round(mrrAdded * 100) / 100;
    res.json({
      mrrAdded, goal: WEEKLY_GOAL_CAD, newSubscriptions: subs.length,
      weekStart: weekStart.toISOString(),
      percent: Math.min(100, Math.round((mrrAdded / WEEKLY_GOAL_CAD) * 100)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/funnel', async (req, res) => {
  try {
    const rows = await fetchSheetCSV('297 / Mo Lead Tracking');
    const channels = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = (row[0] || '').trim();
      if (!name) break;
      if (/^\d+(\.\d+)?$/.test(name)) continue;

      const cost = parseMoney(row[1]);
      const leads = parseNum(row[2]);
      channels.push({
        name: name.replace(/:$/, '').trim(),
        isSummary: name.includes('Summary'),
        cost,
        leads,
        cpl: (cost !== null && leads !== null && leads > 0) ? Math.round(cost / leads) : null,
        leadBookRate: parsePct(row[3]),
        bookings: parseNum(row[4]),
        showRate: parsePct(row[5]),
        costPerShow: parseMoney(row[6]),
        shows: parseNum(row[7]),
        closeRate: parsePct(row[8]),
        closes: parseNum(row[9]),
        costPerClose: parseMoney(row[10]),
        newMRR: parseMoney(row[11]),
      });
    }

    let currentMRR = null, eomMRR = null;
    for (const row of rows) {
      if ((row[2] || '').includes('Current MRR')) currentMRR = parseNum(row[3]);
      if ((row[2] || '').includes('EOM MRR'))     eomMRR = parseNum(row[3]);
    }

    const now = new Date();
    const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const daysLeft = Math.max(0, Math.ceil((eom - now) / 86400000));

    res.json({ channels, currentMRR, eomMRR, daysLeft });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00') : null;
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59') : null;

    const results = await Promise.all(LEAD_SHEETS.map(async ({ name, sheet }) => {
      try {
        const rows = await fetchSheetCSV(sheet);
        let leads = 0, shows = 0, closes = 0;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const dateStr = (row[0] || '').trim();
          const nameStr = (row[1] || '').trim();
          if (!dateStr || !nameStr) continue;

          const date = parseSheetDate(dateStr);
          if (!date) continue;
          if (from && date < from) continue;
          if (to   && date > to)   continue;

          const showed = (row[5] || '').trim().toUpperCase();
          const closed = (row[6] || '').trim().toUpperCase();
          if (showed !== 'Y' && showed !== 'N' && showed !== '') continue;

          leads++;
          if (showed === 'Y') shows++;
          if (closed === 'Y') closes++;
        }

        return {
          name,
          leads,
          shows,
          closes,
          showRate:  leads > 0 ? Math.round(shows  / leads * 1000) / 10 : null,
          closeRate: shows > 0 ? Math.round(closes  / shows * 1000) / 10 : null,
        };
      } catch (e) {
        return { name, error: e.message };
      }
    }));

    res.json({ channels: results, from: req.query.from, to: req.query.to });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a12; color: #f0f0f0; min-height: 100vh; }

    .nav { display: flex; border-bottom: 1px solid #1e1e30; padding: 0 32px; background: #0a0a12; position: sticky; top: 0; z-index: 10; }
    .nav-tab { padding: 16px 24px; font-size: 0.75rem; font-weight: 600; color: #4a5568; cursor: pointer; border-bottom: 2px solid transparent; text-transform: uppercase; letter-spacing: 0.12em; transition: color 0.15s, border-color 0.15s; }
    .nav-tab:hover { color: #e2e8f0; }
    .nav-tab.active { color: #68d391; border-bottom-color: #68d391; }

    #tab-mrr { display: none; min-height: calc(100vh - 53px); align-items: center; justify-content: center; }
    #tab-mrr.active { display: flex; }
    #tab-funnels { display: none; padding: 28px 32px 60px; }
    #tab-funnels.active { display: block; }

    .card { background: #1a1a2e; border: 1px solid #2d2d44; border-radius: 24px; padding: 56px 64px; text-align: center; width: 480px; max-width: 95vw; }
    .week-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.12em; color: #4a5568; margin-bottom: 36px; }
    .amounts { display: flex; align-items: baseline; justify-content: center; gap: 8px; margin-bottom: 10px; }
    .mrr-now { font-size: 3.8rem; font-weight: 700; color: #68d391; line-height: 1; }
    .mrr-goal { font-size: 1.4rem; color: #4a5568; font-weight: 500; }
    .currency { font-size: 0.8rem; color: #4a5568; margin-bottom: 28px; }
    .bar-wrap { background: #2d2d44; border-radius: 999px; height: 10px; overflow: hidden; margin-bottom: 10px; }
    .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38a169, #68d391); transition: width 0.6s ease; }
    .bar-fill.over { background: linear-gradient(90deg, #d69e2e, #f6e05e); }
    .percent { font-size: 0.8rem; color: #718096; margin-bottom: 40px; text-align: right; }
    .subs { border-top: 1px solid #2d2d44; padding-top: 24px; font-size: 0.85rem; color: #718096; }
    .subs strong { color: #e2e8f0; font-size: 1rem; }

    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px; }
    @media (max-width: 700px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
    .stat-card { background: #111120; border: 1px solid #1e1e30; border-radius: 14px; padding: 20px 22px; }
    .stat-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.12em; color: #4a5568; margin-bottom: 10px; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #e2e8f0; line-height: 1; }
    .stat-value.green { color: #68d391; }
    .stat-value.yellow { color: #f6e05e; }
    .stat-sub { font-size: 0.72rem; color: #4a5568; margin-top: 6px; }
    .stat-bar-wrap { background: #1e1e30; border-radius: 999px; height: 3px; margin-top: 10px; overflow: hidden; }
    .stat-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38a169, #68d391); }

    .section { margin-bottom: 36px; }
    .section-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.14em; color: #4a5568; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #1e1e30; }

    .presets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
    .preset-btn { background: #111120; border: 1px solid #1e1e30; color: #718096; padding: 7px 16px; border-radius: 8px; font-size: 0.78rem; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .preset-btn:hover { border-color: #4a5568; color: #e2e8f0; }
    .preset-btn.active { background: #1a2e1a; border-color: #38a169; color: #68d391; font-weight: 600; }
    .custom-dates { display: none; gap: 8px; align-items: center; }
    .custom-dates.show { display: flex; }
    .custom-dates input[type=date] { background: #111120; border: 1px solid #2d2d44; color: #e2e8f0; padding: 7px 12px; border-radius: 8px; font-size: 0.78rem; outline: none; }
    .custom-dates button { background: #38a169; border: none; color: #fff; padding: 7px 14px; border-radius: 8px; font-size: 0.78rem; cursor: pointer; font-weight: 600; }
    .date-sep { color: #4a5568; font-size: 0.8rem; }

    .range-table-wrap { background: #111120; border: 1px solid #1e1e30; border-radius: 14px; overflow: hidden; overflow-x: auto; }
    .range-table-wrap table { width: 100%; border-collapse: collapse; min-width: 520px; }
    .range-table-wrap thead th { background: #0d0d1a; padding: 11px 18px; text-align: right; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.12em; color: #4a5568; white-space: nowrap; }
    .range-table-wrap thead th:first-child { text-align: left; }
    .range-table-wrap td { padding: 12px 18px; text-align: right; font-size: 0.85rem; border-top: 1px solid #14141f; color: #a0aec0; white-space: nowrap; }
    .range-table-wrap td:first-child { text-align: left; color: #e2e8f0; font-weight: 500; }
    .range-table-wrap tr:hover td { background: #13131f; }
    .range-loading { color: #4a5568; padding: 28px; text-align: center; font-size: 0.85rem; }

    .controls { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
    .controls-label { font-size: 0.72rem; color: #4a5568; text-transform: uppercase; letter-spacing: 0.1em; }
    select { background: #111120; border: 1px solid #2d2d44; color: #e2e8f0; padding: 8px 28px 8px 14px; border-radius: 8px; font-size: 0.82rem; cursor: pointer; outline: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23718096'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; }
    select:hover { border-color: #4a5568; }

    .table-wrap { background: #111120; border: 1px solid #1e1e30; border-radius: 14px; overflow: hidden; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 860px; }
    thead th { background: #0d0d1a; padding: 13px 18px; text-align: right; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.12em; color: #4a5568; white-space: nowrap; cursor: pointer; user-select: none; transition: color 0.15s; }
    thead th:first-child { text-align: left; cursor: default; }
    thead th:not(:first-child):hover { color: #a0aec0; }
    thead th.sorted { color: #68d391; }
    td { padding: 0; border-top: 1px solid #14141f; }
    .td-inner { padding: 13px 18px; display: flex; flex-direction: column; gap: 4px; }
    td:first-child .td-inner { align-items: flex-start; }
    td:not(:first-child) .td-inner { align-items: flex-end; }
    .td-val { font-size: 0.88rem; color: #c4c4d4; white-space: nowrap; }
    td:first-child .td-val { color: #e2e8f0; font-weight: 500; }
    .td-bar-wrap { width: 100%; max-width: 64px; height: 3px; background: #1e1e30; border-radius: 999px; overflow: hidden; }
    td:first-child .td-bar-wrap { display: none; }
    .td-bar { height: 100%; border-radius: 999px; }
    tr.summary-row td { background: #13132a; }
    tr.summary-row td:first-child .td-val { color: #a78bfa; font-weight: 600; }
    tr:not(.summary-row):hover td { background: #13131f; }
    .badge-best { display: inline-block; background: rgba(104,211,145,0.15); color: #68d391; font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; padding: 2px 7px; border-radius: 999px; margin-left: 8px; vertical-align: middle; }
    .na { color: #2d2d44 !important; }
    .loading { color: #4a5568; padding: 60px; text-align: center; }
    .cr-good { color: #68d391; font-weight: 600; }
    .cr-mid  { color: #f6e05e; }
    .cr-bad  { color: #fc8181; }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-tab active" data-tab="mrr" onclick="switchTab('mrr')">MRR</div>
    <div class="nav-tab" data-tab="funnels" onclick="switchTab('funnels')">Funnels</div>
  </nav>

  <div id="tab-mrr" class="active">
    <div class="card"><div id="mrr-content" class="loading">Loading...</div></div>
  </div>

  <div id="tab-funnels">
    <div id="funnel-content" class="loading">Loading...</div>
  </div>

  <script>
    function switchTab(name) {
      document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === name); });
      ['mrr','funnels'].forEach(function(n) { document.getElementById('tab-' + n).classList.toggle('active', n === name); });
    }

    /* ---- MRR tab ---- */
    async function loadMRR() {
      try {
        var res = await fetch('/api/mrr');
        var d = await res.json();
        if (d.error) throw new Error(d.error);
        var weekStart = new Date(d.weekStart);
        var weekEnd = new Date(weekStart.getTime() + 7*24*60*60*1000 - 1);
        var fmt = function(dt) { return dt.toLocaleDateString('en-US', {month:'short',day:'numeric'}); };
        var over = d.percent >= 100;
        var mrr = d.mrrAdded.toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:0});
        var goal = d.goal.toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:0});
        document.getElementById('mrr-content').innerHTML =
          '<div class="week-label">Week of ' + fmt(weekStart) + ' – ' + fmt(weekEnd) + '</div>' +
          '<div class="amounts"><span class="mrr-now">$' + mrr + '</span><span class="mrr-goal">/ $' + goal + '</span></div>' +
          '<div class="currency">CAD · MRR added this week</div>' +
          '<div class="bar-wrap"><div class="bar-fill' + (over?' over':'') + '" style="width:' + d.percent + '%"></div></div>' +
          '<div class="percent">' + d.percent + '%' + (over?' 🎉 Goal reached!':'') + '</div>' +
          '<div class="subs"><strong>' + d.newSubscriptions + '</strong> new subscription' + (d.newSubscriptions!==1?'s':'') + ' added this week</div>';
      } catch(e) {
        document.getElementById('mrr-content').innerHTML = '<div style="color:#fc8181">Error: ' + e.message + '</div>';
      }
    }

    /* ---- Date range helpers ---- */
    function toISO(d) {
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }
    function getRange(preset) {
      var today = new Date(); today.setHours(0,0,0,0);
      if (preset === 'this-week') {
        var dow = (today.getDay()+6)%7;
        var mon = new Date(today); mon.setDate(today.getDate()-dow);
        var sun = new Date(mon); sun.setDate(mon.getDate()+6);
        return {from:mon,to:sun};
      }
      if (preset === 'last-week') {
        var dow2 = (today.getDay()+6)%7;
        var thismon = new Date(today); thismon.setDate(today.getDate()-dow2);
        var lastmon = new Date(thismon); lastmon.setDate(thismon.getDate()-7);
        var lastsun = new Date(lastmon); lastsun.setDate(lastmon.getDate()+6);
        return {from:lastmon,to:lastsun};
      }
      if (preset === 'this-month') {
        return {from:new Date(today.getFullYear(),today.getMonth(),1), to:new Date(today.getFullYear(),today.getMonth()+1,0)};
      }
      if (preset === 'last-month') {
        return {from:new Date(today.getFullYear(),today.getMonth()-1,1), to:new Date(today.getFullYear(),today.getMonth(),0)};
      }
      if (preset === 'last-30') {
        var f = new Date(today); f.setDate(today.getDate()-29);
        return {from:f, to:today};
      }
      return null;
    }

    /* ---- Date range table ---- */
    var activePreset = null;

    function crClass(v) {
      if (v === null) return 'na';
      if (v >= 30) return 'cr-good';
      if (v >= 15) return 'cr-mid';
      return 'cr-bad';
    }
    function fP(v,dec) { return v !== null ? v.toFixed(dec===undefined?1:dec)+'%' : '<span class="na">—</span>'; }
    function fN(v) { return v !== null ? v.toString() : '<span class="na">—</span>'; }

    async function loadRange(preset, fromISO, toISO2) {
      activePreset = preset;
      document.querySelectorAll('.preset-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.preset===preset); });

      var qs;
      if (preset === 'custom') {
        qs = '?from=' + fromISO + '&to=' + toISO2;
      } else {
        var r = getRange(preset);
        if (!r) return;
        qs = '?from=' + toISO(r.from) + '&to=' + toISO(r.to);
      }

      var el = document.getElementById('range-result');
      el.innerHTML = '<div class="range-loading">Loading...</div>';

      try {
        var res = await fetch('/api/leads' + qs);
        var d = await res.json();
        if (d.error) throw new Error(d.error);

        var totalLeads  = d.channels.reduce(function(s,c){return s+(c.leads||0);},0);
        var totalShows  = d.channels.reduce(function(s,c){return s+(c.shows||0);},0);
        var totalCloses = d.channels.reduce(function(s,c){return s+(c.closes||0);},0);
        var totalCR = totalShows > 0 ? Math.round(totalCloses/totalShows*1000)/10 : null;
        var totalSR = totalLeads > 0 ? Math.round(totalShows/totalLeads*1000)/10 : null;

        var rows = d.channels.map(function(c) {
          if (c.error) return '<tr><td><div class="td-inner"><div class="td-val">' + c.name + '</div></div></td><td colspan="5" style="text-align:left;padding:12px 18px;color:#fc8181;font-size:0.8rem">' + c.error + '</td></tr>';
          return '<tr>' +
            '<td style="padding:12px 18px;text-align:left;color:#e2e8f0;font-weight:500;border-top:1px solid #14141f">' + c.name + '</td>' +
            '<td style="padding:12px 18px;text-align:right;border-top:1px solid #14141f;color:#a0aec0">' + fN(c.leads) + '</td>' +
            '<td style="padding:12px 18px;text-align:right;border-top:1px solid #14141f;color:#a0aec0">' + fN(c.shows) + '</td>' +
            '<td style="padding:12px 18px;text-align:right;border-top:1px solid #14141f;color:#a0aec0">' + fP(c.showRate) + '</td>' +
            '<td style="padding:12px 18px;text-align:right;border-top:1px solid #14141f;color:#a0aec0">' + fN(c.closes) + '</td>' +
            '<td style="padding:12px 18px;text-align:right;border-top:1px solid #14141f" class="' + crClass(c.closeRate) + '">' + fP(c.closeRate) + '</td>' +
          '</tr>';
        }).join('');

        el.innerHTML =
          '<div style="display:flex;gap:14px;margin-bottom:14px;flex-wrap:wrap">' +
            '<div style="background:#111120;border:1px solid #1e1e30;border-radius:10px;padding:14px 20px;min-width:100px">' +
              '<div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:#4a5568;margin-bottom:6px">Leads</div>' +
              '<div style="font-size:1.5rem;font-weight:700;color:#e2e8f0">' + totalLeads + '</div></div>' +
            '<div style="background:#111120;border:1px solid #1e1e30;border-radius:10px;padding:14px 20px;min-width:100px">' +
              '<div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:#4a5568;margin-bottom:6px">Shows</div>' +
              '<div style="font-size:1.5rem;font-weight:700;color:#e2e8f0">' + totalShows + '</div></div>' +
            '<div style="background:#111120;border:1px solid #1e1e30;border-radius:10px;padding:14px 20px;min-width:100px">' +
              '<div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:#4a5568;margin-bottom:6px">Show Rate</div>' +
              '<div style="font-size:1.5rem;font-weight:700;color:#e2e8f0">' + fP(totalSR, 0) + '</div></div>' +
            '<div style="background:#111120;border:1px solid #1e1e30;border-radius:10px;padding:14px 20px;min-width:100px">' +
              '<div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:#4a5568;margin-bottom:6px">Closes</div>' +
              '<div style="font-size:1.5rem;font-weight:700;color:#68d391">' + totalCloses + '</div></div>' +
            '<div style="background:#111120;border:1px solid #1e1e30;border-radius:10px;padding:14px 20px;min-width:100px">' +
              '<div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:#4a5568;margin-bottom:6px">Close Rate</div>' +
              '<div style="font-size:1.5rem;font-weight:700" class="' + crClass(totalCR) + '">' + fP(totalCR, 0) + '</div></div>' +
          '</div>' +
          '<div class="range-table-wrap"><table>' +
            '<thead><tr><th>Channel</th><th>Leads</th><th>Shows</th><th>Show Rate</th><th>Closes</th><th>Close Rate</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table></div>';
      } catch(e) {
        el.innerHTML = '<div style="color:#fc8181;padding:20px">Error: ' + e.message + '</div>';
      }
    }

    function toggleCustom() {
      var el = document.getElementById('custom-dates');
      var showing = el.classList.toggle('show');
      if (!showing) {
        activePreset = null;
        document.querySelectorAll('.preset-btn').forEach(function(b){b.classList.remove('active');});
        document.getElementById('range-result').innerHTML = '';
      }
    }

    function applyCustom() {
      var f = document.getElementById('date-from').value;
      var t = document.getElementById('date-to').value;
      if (!f || !t) return;
      document.querySelectorAll('.preset-btn').forEach(function(b){b.classList.toggle('active',b.dataset.preset==='custom');});
      loadRange('custom', f, t);
    }

    /* ---- All-time funnels table ---- */
    var funnelData = null;
    var sortKey = 'closeRate';
    var sortDir = -1;

    var COLS = [
      {key:'cost',         label:'Ad Spend',    fmt:'$', lowerBetter:true },
      {key:'leads',        label:'Leads',        fmt:'n', lowerBetter:false},
      {key:'cpl',          label:'CPL',          fmt:'$', lowerBetter:true },
      {key:'bookings',     label:'Bookings',     fmt:'n', lowerBetter:false},
      {key:'shows',        label:'Shows',        fmt:'n', lowerBetter:false},
      {key:'closes',       label:'Closes',       fmt:'n', lowerBetter:false},
      {key:'closeRate',    label:'Close Rate',   fmt:'%', lowerBetter:false},
      {key:'costPerClose', label:'Cost / Close', fmt:'$', lowerBetter:true },
      {key:'newMRR',       label:'New MRR',      fmt:'$', lowerBetter:false},
    ];

    function f$(v){return v!==null?'$'+Math.round(v).toLocaleString():null;}
    function fmtV(v,fmt){if(fmt==='$')return f$(v);if(fmt==='%')return v!==null?v.toFixed(1)+'%':null;return v!==null?Math.round(v).toLocaleString():null;}

    function getMinMax(channels,key){
      var vals=channels.filter(function(c){return !c.isSummary&&c[key]!==null;}).map(function(c){return c[key];});
      return vals.length?{min:Math.min.apply(null,vals),max:Math.max.apply(null,vals)}:{min:null,max:null};
    }

    function barColor(pct,lowerBetter){
      var good=lowerBetter?(1-pct):pct;
      if(good>0.6)return 'rgba(104,211,145,'+(0.4+good*0.6)+')';
      if(good<0.35)return 'rgba(252,129,129,'+(0.3+(1-good)*0.5)+')';
      return 'rgba(246,224,94,0.5)';
    }

    function thClick(el) { setSort(el.dataset.key); }
    function presetClick(el) { loadRange(el.dataset.preset); }

    function renderAllTime() {
      if(!funnelData) return;
      var d=funnelData;
      var summary=d.channels.filter(function(c){return c.isSummary;});
      var rows=d.channels.filter(function(c){return !c.isSummary;});

      rows.sort(function(a,b){
        var av=a[sortKey],bv=b[sortKey];
        if(av===null&&bv===null)return 0;
        if(av===null)return 1;
        if(bv===null)return -1;
        return (bv-av)*sortDir;
      });

      var sorted=summary.concat(rows);
      var mm={};
      COLS.forEach(function(col){mm[col.key]=getMinMax(d.channels,col.key);});

      var totalCloses=rows.reduce(function(s,c){return s+(c.closes||0);},0);
      var totalMRR=rows.reduce(function(s,c){return s+(c.newMRR||0);},0);
      var mrrPct=(d.currentMRR&&d.eomMRR)?Math.min(100,Math.round(d.currentMRR/d.eomMRR*100)):0;
      var bestRow=rows.filter(function(c){return c[sortKey]!==null;}).slice().sort(function(a,b){return (b[sortKey]-a[sortKey])*sortDir;});
      var bestName=bestRow.length?bestRow[0].name:null;

      var thCells=COLS.map(function(col){
        var active=col.key===sortKey;
        var arrow=active?(sortDir===-1?' ▼':' ▲'):'';
        return '<th class="'+(active?'sorted':'')+'" data-key="'+col.key+'" onclick="thClick(this)">'+col.label+arrow+'</th>';
      }).join('');

      var tableRows=sorted.map(function(c){
        var isBest=!c.isSummary&&c.name===bestName;
        var cells=COLS.map(function(col){
          var v=c[col.key];
          var display=fmtV(v,col.fmt);
          var barHtml='';
          if(!c.isSummary&&v!==null){
            var m=mm[col.key];
            if(m.min!==null&&m.max>m.min){
              var pct=(v-m.min)/(m.max-m.min);
              var bp=col.lowerBetter?(1-pct):pct;
              barHtml='<div class="td-bar-wrap"><div class="td-bar" style="width:'+Math.round(bp*100)+'%;background:'+barColor(pct,col.lowerBetter)+'"></div></div>';
            }
          }
          return '<td><div class="td-inner"><div class="td-val'+(display===null?' na':'')+'">'+( display||'—')+'</div>'+barHtml+'</div></td>';
        }).join('');
        return '<tr class="'+(c.isSummary?'summary-row':'')+'">' +
          '<td><div class="td-inner"><div class="td-val">'+c.name+(isBest?'<span class="badge-best">#1</span>':'')+'</div></div></td>'+
          cells+'</tr>';
      }).join('');

      document.getElementById('funnel-content').innerHTML =
        '<div class="stat-grid">' +
          '<div class="stat-card"><div class="stat-label">Current MRR</div><div class="stat-value green">$'+(d.currentMRR||0).toLocaleString()+'</div><div class="stat-sub">after churn</div><div class="stat-bar-wrap"><div class="stat-bar-fill" style="width:'+mrrPct+'%"></div></div></div>' +
          '<div class="stat-card"><div class="stat-label">EOM Target</div><div class="stat-value">$'+(d.eomMRR||0).toLocaleString()+'</div><div class="stat-sub">'+mrrPct+'% there – '+d.daysLeft+' days left</div></div>' +
          '<div class="stat-card"><div class="stat-label">Total Closes</div><div class="stat-value yellow">'+totalCloses+'</div><div class="stat-sub">all channels</div></div>' +
          '<div class="stat-card"><div class="stat-label">New MRR Added</div><div class="stat-value green">$'+Math.round(totalMRR).toLocaleString()+'</div><div class="stat-sub">from '+totalCloses+' close'+(totalCloses!==1?'s':'')+'</div></div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section-title">Activity by Date Range</div>' +
          '<div class="presets">' +
            '<button class="preset-btn" data-preset="this-week"  onclick="presetClick(this)">This Week</button>' +
            '<button class="preset-btn" data-preset="last-week"  onclick="presetClick(this)">Last Week</button>' +
            '<button class="preset-btn" data-preset="this-month" onclick="presetClick(this)">This Month</button>' +
            '<button class="preset-btn" data-preset="last-month" onclick="presetClick(this)">Last Month</button>' +
            '<button class="preset-btn" data-preset="last-30"    onclick="presetClick(this)">Last 30 Days</button>' +
            '<button class="preset-btn" data-preset="custom"     onclick="toggleCustom()">Custom</button>' +
          '</div>' +
          '<div class="custom-dates" id="custom-dates">' +
            '<input type="date" id="date-from">' +
            '<span class="date-sep">to</span>' +
            '<input type="date" id="date-to">' +
            '<button onclick="applyCustom()">Apply</button>' +
          '</div>' +
          '<div id="range-result"></div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section-title">All-Time Channel Comparison</div>' +
          '<div class="controls">' +
            '<span class="controls-label">Sort by</span>' +
            '<select onchange="setSort(this.value)">' +
            COLS.map(function(col){return '<option value="'+col.key+'"'+(col.key===sortKey?' selected':'')+'>'+col.label+'</option>';}).join('') +
            '</select>' +
            '<select onchange="setSortDir(this.value)">' +
            '<option value="-1"'+(sortDir===-1?' selected':'')+'>High → Low</option>' +
            '<option value="1"'+(sortDir===1?' selected':'')+'>Low → High</option>' +
            '</select>' +
          '</div>' +
          '<div class="table-wrap"><table>' +
            '<thead><tr><th>Channel</th>'+thCells+'</tr></thead>' +
            '<tbody>'+tableRows+'</tbody>' +
          '</table></div>' +
        '</div>';
    }

    function setSort(key){
      if(sortKey===key){sortDir=-sortDir;}else{sortKey=key;sortDir=-1;}
      renderAllTime();
    }
    function setSortDir(val){ sortDir=parseInt(val); renderAllTime(); }

    async function loadFunnels(){
      try{
        var res=await fetch('/api/funnel');
        var d=await res.json();
        if(d.error)throw new Error(d.error);
        funnelData=d;
        renderAllTime();
      }catch(e){
        document.getElementById('funnel-content').innerHTML='<div style="color:#fc8181;padding:40px">Error: '+e.message+'</div>';
      }
    }

    loadMRR();
    loadFunnels();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log('MRR dashboard running on port ' + PORT));
