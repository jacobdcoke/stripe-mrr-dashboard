const express = require('express');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

const WEEKLY_GOAL_CAD = 1000;
const SHEET_ID = '1C7L4NklNeks72uBtXrW4vWYUHak3yEY5QmaW0llKztM';

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
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
      '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent('297 / Mo Lead Tracking');
    const response = await fetch(sheetUrl);
    if (!response.ok) throw new Error('Sheet fetch failed: ' + response.status);
    const rows = parseCSV(await response.text());

    const channels = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = (row[0] || '').trim();
      if (!name) break;
      if (/^\d+(\.\d+)?$/.test(name)) continue;

      channels.push({
        name: name.replace(/:$/, '').trim(),
        isSummary: name.includes('Summary'),
        cost: parseMoney(row[1]),
        leads: parseNum(row[2]),
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

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #f0f0f0; min-height: 100vh; }

    .nav { display: flex; border-bottom: 1px solid #2d2d44; padding: 0 32px; background: #0f0f0f; position: sticky; top: 0; z-index: 10; }
    .nav-tab { padding: 16px 24px; font-size: 0.75rem; font-weight: 600; color: #718096; cursor: pointer; border-bottom: 2px solid transparent; text-transform: uppercase; letter-spacing: 0.1em; transition: color 0.15s, border-color 0.15s; }
    .nav-tab:hover { color: #e2e8f0; }
    .nav-tab.active { color: #68d391; border-bottom-color: #68d391; }

    #tab-mrr { display: none; min-height: calc(100vh - 53px); align-items: center; justify-content: center; }
    #tab-mrr.active { display: flex; }
    #tab-funnels { display: none; padding: 32px; max-width: 1200px; margin: 0 auto; }
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

    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
    @media (max-width: 640px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
    .stat-card { background: #1a1a2e; border: 1px solid #2d2d44; border-radius: 12px; padding: 20px 24px; }
    .stat-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #4a5568; margin-bottom: 8px; }
    .stat-value { font-size: 1.8rem; font-weight: 700; color: #e2e8f0; }
    .stat-value.green { color: #68d391; }
    .stat-sub { font-size: 0.75rem; color: #4a5568; margin-top: 4px; }

    .table-wrap { background: #1a1a2e; border: 1px solid #2d2d44; border-radius: 12px; overflow: hidden; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 820px; }
    thead th { background: #12122a; padding: 12px 16px; text-align: right; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #4a5568; white-space: nowrap; }
    thead th:first-child { text-align: left; }
    td { padding: 14px 16px; text-align: right; font-size: 0.85rem; border-top: 1px solid #1e1e38; color: #a0aec0; white-space: nowrap; }
    td:first-child { text-align: left; color: #e2e8f0; font-weight: 500; min-width: 200px; }
    tr.summary-row td { background: #1c1c36; color: #e2e8f0; font-weight: 600; border-top: none; }
    tr.summary-row td:first-child { color: #a78bfa; }
    .best { color: #68d391 !important; font-weight: 600; }
    .worst { color: #fc8181 !important; }
    .na { color: #2d2d44 !important; }
    .loading { color: #4a5568; padding: 60px; text-align: center; }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-tab active" data-tab="mrr" onclick="switchTab('mrr')">MRR</div>
    <div class="nav-tab" data-tab="funnels" onclick="switchTab('funnels')">Funnels</div>
  </nav>

  <div id="tab-mrr" class="active">
    <div class="card">
      <div id="mrr-content" class="loading">Loading...</div>
    </div>
  </div>

  <div id="tab-funnels">
    <div id="funnel-content" class="loading">Loading...</div>
  </div>

  <script>
    function switchTab(name) {
      document.querySelectorAll('.nav-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === name);
      });
      ['mrr', 'funnels'].forEach(function(n) {
        document.getElementById('tab-' + n).classList.toggle('active', n === name);
      });
    }

    async function loadMRR() {
      try {
        var res = await fetch('/api/mrr');
        var d = await res.json();
        if (d.error) throw new Error(d.error);

        var weekStart = new Date(d.weekStart);
        var weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
        var fmt = function(dt) { return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
        var weekLabel = 'Week of ' + fmt(weekStart) + ' – ' + fmt(weekEnd);
        var over = d.percent >= 100;
        var mrr = d.mrrAdded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        var goal = d.goal.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

        document.getElementById('mrr-content').innerHTML =
          '<div class="week-label">' + weekLabel + '</div>' +
          '<div class="amounts"><span class="mrr-now">$' + mrr + '</span><span class="mrr-goal">/ $' + goal + '</span></div>' +
          '<div class="currency">CAD · MRR added this week</div>' +
          '<div class="bar-wrap"><div class="bar-fill' + (over ? ' over' : '') + '" style="width:' + d.percent + '%"></div></div>' +
          '<div class="percent">' + d.percent + '%' + (over ? ' 🎉 Goal reached!' : '') + '</div>' +
          '<div class="subs"><strong>' + d.newSubscriptions + '</strong> new subscription' + (d.newSubscriptions !== 1 ? 's' : '') + ' added this week</div>';
      } catch (e) {
        document.getElementById('mrr-content').innerHTML = '<div style="color:#fc8181">Error: ' + e.message + '</div>';
      }
    }

    async function loadFunnels() {
      try {
        var res = await fetch('/api/funnel');
        var d = await res.json();
        if (d.error) throw new Error(d.error);

        var channels = d.channels;
        var currentMRR = d.currentMRR;
        var eomMRR = d.eomMRR;
        var daysLeft = d.daysLeft;

        var nonSummary = channels.filter(function(c) { return !c.isSummary; });
        var totalCloses = nonSummary.reduce(function(s, c) { return s + (c.closes || 0); }, 0);
        var totalNewMRR = nonSummary.reduce(function(s, c) { return s + (c.newMRR || 0); }, 0);

        var validCPC = channels.map(function(c) { return c.costPerClose; }).filter(function(v) { return v !== null && v > 0; });
        var validCR  = channels.map(function(c) { return c.closeRate; }).filter(function(v) { return v !== null; });
        var validMRR = channels.map(function(c) { return c.newMRR; }).filter(function(v) { return v !== null && v > 0; });
        var minCPC = validCPC.length ? Math.min.apply(null, validCPC) : null;
        var maxCPC = validCPC.length ? Math.max.apply(null, validCPC) : null;
        var maxCR  = validCR.length  ? Math.max.apply(null, validCR)  : null;
        var minCR  = validCR.length  ? Math.min.apply(null, validCR)  : null;
        var maxMRR = validMRR.length ? Math.max.apply(null, validMRR) : null;

        function cpcCls(v) { if (v === null) return 'na'; if (v === minCPC) return 'best'; if (v === maxCPC) return 'worst'; return ''; }
        function crCls(v)  { if (v === null) return 'na'; if (v === maxCR)  return 'best'; if (v === minCR && v < 10) return 'worst'; return ''; }
        function mrrCls(v) { if (v === null) return 'na'; if (v === maxMRR) return 'best'; return ''; }

        function f$(v) { return v !== null ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '<span class="na">—</span>'; }
        function fN(v) { return v !== null ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '<span class="na">—</span>'; }
        function fP(v) { return v !== null ? v.toFixed(1) + '%' : '<span class="na">—</span>'; }
        function fCPL(c) {
          if (c.cost !== null && c.leads !== null && c.leads > 0) return '$' + Math.round(c.cost / c.leads);
          return '<span class="na">—</span>';
        }

        var mrrPct = (currentMRR && eomMRR) ? Math.min(100, Math.round(currentMRR / eomMRR * 100)) : 0;

        var rows = channels.map(function(c) {
          return '<tr class="' + (c.isSummary ? 'summary-row' : '') + '">' +
            '<td>' + c.name + '</td>' +
            '<td>' + f$(c.cost) + '</td>' +
            '<td>' + fN(c.leads) + '</td>' +
            '<td>' + fCPL(c) + '</td>' +
            '<td>' + fN(c.bookings) + '</td>' +
            '<td>' + fN(c.shows) + '</td>' +
            '<td>' + fN(c.closes) + '</td>' +
            '<td class="' + crCls(c.closeRate) + '">' + fP(c.closeRate) + '</td>' +
            '<td class="' + cpcCls(c.costPerClose) + '">' + f$(c.costPerClose) + '</td>' +
            '<td class="' + mrrCls(c.newMRR) + '">' + f$(c.newMRR) + '</td>' +
            '</tr>';
        }).join('');

        document.getElementById('funnel-content').innerHTML =
          '<div class="stat-grid">' +
            '<div class="stat-card"><div class="stat-label">Current MRR</div><div class="stat-value green">$' + (currentMRR || 0).toLocaleString() + '</div><div class="stat-sub">after churn</div></div>' +
            '<div class="stat-card"><div class="stat-label">EOM Target</div><div class="stat-value">$' + (eomMRR || 0).toLocaleString() + '</div><div class="stat-sub">' + mrrPct + '% there</div></div>' +
            '<div class="stat-card"><div class="stat-label">Days Left</div><div class="stat-value">' + (daysLeft !== null ? daysLeft : '—') + '</div><div class="stat-sub">this month</div></div>' +
            '<div class="stat-card"><div class="stat-label">Total Closes</div><div class="stat-value">' + totalCloses + '</div><div class="stat-sub">$' + Math.round(totalNewMRR).toLocaleString() + ' new MRR</div></div>' +
          '</div>' +
          '<div class="table-wrap"><table>' +
            '<thead><tr>' +
              '<th>Channel</th><th>Cost</th><th>Leads</th><th>CPL</th>' +
              '<th>Bookings</th><th>Shows</th><th>Closes</th>' +
              '<th>Close Rate</th><th>Cost / Close</th><th>New MRR</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table></div>';
      } catch (e) {
        document.getElementById('funnel-content').innerHTML = '<div style="color:#fc8181;padding:40px">Error: ' + e.message + '</div>';
      }
    }

    loadMRR();
    loadFunnels();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log('MRR dashboard running on port ' + PORT));
