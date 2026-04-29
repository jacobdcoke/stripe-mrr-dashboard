const express = require('express');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

const WEEKLY_GOAL_CAD = 1000;

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
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

app.get('/api/mrr', async (req, res) => {
  try {
    const weekStart = getWeekStart();
    const weekStartTimestamp = Math.floor(weekStart.getTime() / 1000);

    const subs = [];
    let hasMore = true;
    let startingAfter = undefined;

    while (hasMore) {
      const page = await stripe.subscriptions.list({
        status: 'active',
        limit: 100,
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
      mrrAdded,
      goal: WEEKLY_GOAL_CAD,
      newSubscriptions: subs.length,
      weekStart: weekStart.toISOString(),
      percent: Math.min(100, Math.round((mrrAdded / WEEKLY_GOAL_CAD) * 100)),
    });
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
  <title>Weekly MRR Goal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #f0f0f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a2e;
      border: 1px solid #2d2d44;
      border-radius: 24px;
      padding: 56px 64px;
      text-align: center;
      width: 480px;
      max-width: 95vw;
    }
    .week-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #4a5568;
      margin-bottom: 36px;
    }
    .amounts {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .mrr-now {
      font-size: 3.8rem;
      font-weight: 700;
      color: #68d391;
      line-height: 1;
    }
    .mrr-goal {
      font-size: 1.4rem;
      color: #4a5568;
      font-weight: 500;
    }
    .currency {
      font-size: 0.8rem;
      color: #4a5568;
      margin-bottom: 28px;
    }
    .bar-wrap {
      background: #2d2d44;
      border-radius: 999px;
      height: 10px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #38a169, #68d391);
      transition: width 0.6s ease;
    }
    .bar-fill.over { background: linear-gradient(90deg, #d69e2e, #f6e05e); }
    .percent {
      font-size: 0.8rem;
      color: #718096;
      margin-bottom: 40px;
      text-align: right;
    }
    .subs {
      border-top: 1px solid #2d2d44;
      padding-top: 24px;
      font-size: 0.85rem;
      color: #718096;
    }
    .subs strong { color: #e2e8f0; font-size: 1rem; }
    .loading { color: #4a5568; font-size: 1rem; padding: 40px; }
  </style>
</head>
<body>
  <div class="card">
    <div id="content" class="loading">Loading...</div>
  </div>
  <script>
    async function load() {
      try {
        const res = await fetch('/api/mrr');
        const d = await res.json();
        if (d.error) throw new Error(d.error);

        const weekStart = new Date(d.weekStart);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
        const fmt = dt => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const weekLabel = 'Week of ' + fmt(weekStart) + ' – ' + fmt(weekEnd);

        const over = d.percent >= 100;
        const mrr = d.mrrAdded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        const goal = d.goal.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

        document.getElementById('content').innerHTML = \`
          <div class="week-label">\${weekLabel}</div>
          <div class="amounts">
            <span class="mrr-now">$\${mrr}</span>
            <span class="mrr-goal">/ $\${goal}</span>
          </div>
          <div class="currency">CAD · MRR added this week</div>
          <div class="bar-wrap">
            <div class="bar-fill \${over ? 'over' : ''}" style="width:\${d.percent}%"></div>
          </div>
          <div class="percent">\${d.percent}%\${over ? ' 🎉 Goal reached!' : ''}</div>
          <div class="subs">
            <strong>\${d.newSubscriptions}</strong> new subscription\${d.newSubscriptions !== 1 ? 's' : ''} added this week
          </div>
        \`;
      } catch (e) {
        document.getElementById('content').innerHTML = '<div style="color:#fc8181">Error: ' + e.message + '</div>';
      }
    }
    load();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log('MRR dashboard running on port ' + PORT));
