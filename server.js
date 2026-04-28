const express = require('express');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

function normalizeToMonthly(amount, interval, intervalCount) {
  // Convert any billing interval to a monthly USD amount (amount is in cents)
  const dollars = amount / 100;
  switch (interval) {
    case 'day':   return (dollars / intervalCount) * 30.44;
    case 'week':  return (dollars / intervalCount) * 4.348;
    case 'month': return dollars / intervalCount;
    case 'year':  return dollars / (intervalCount * 12);
    default:      return 0;
  }
}

async function getMRRSnapshots() {
  // Fetch all active subscriptions (handles pagination)
  const subscriptions = [];
  let hasMore = true;
  let startingAfter = undefined;

  while (hasMore) {
    const page = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.items.data.price'],
      ...(startingAfter && { starting_after: startingAfter }),
    });
    subscriptions.push(...page.data);
    hasMore = page.has_more;
    if (hasMore) startingAfter = page.data[page.data.length - 1].id;
  }

  // Calculate current total MRR
  let totalMRR = 0;
  const subscriptionDetails = subscriptions.map(sub => {
    let subMRR = 0;
    for (const item of sub.items.data) {
      const price = item.price;
      if (price && price.unit_amount && price.recurring) {
        subMRR += normalizeToMonthly(
          price.unit_amount * (item.quantity || 1),
          price.recurring.interval,
          price.recurring.interval_count
        );
      }
    }
    totalMRR += subMRR;
    return {
      id: sub.id,
      created: sub.created,
      mrr: subMRR,
      status: sub.status,
    };
  });

  // Build weekly MRR snapshots for the past 12 weeks
  // For each week boundary, sum MRR of subs that were created before that point
  // (simplified model: uses subscription start date, not considering cancellations in history)
  const now = Date.now();
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(now - i * 7 * 24 * 60 * 60 * 1000);
    weekStart.setHours(0, 0, 0, 0);
    // Set to Monday of that week
    const day = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - ((day + 6) % 7));

    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const weekTimestamp = Math.floor(weekStart.getTime() / 1000);
    const weekEndTimestamp = Math.floor(weekEnd.getTime() / 1000);

    const mrrAtWeek = subscriptionDetails
      .filter(s => s.created < weekEndTimestamp)
      .reduce((sum, s) => sum + s.mrr, 0);

    weeks.push({
      label: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      mrr: Math.round(mrrAtWeek * 100) / 100,
      timestamp: weekTimestamp,
    });
  }

  return { totalMRR: Math.round(totalMRR * 100) / 100, weeks, count: subscriptions.length };
}

app.get('/api/mrr', async (req, res) => {
  try {
    const data = await getMRRSnapshots();
    res.json(data);
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
  <title>Stripe MRR Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #f0f0f0; min-height: 100vh; padding: 40px 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 32px; color: #a0aec0; letter-spacing: 0.05em; text-transform: uppercase; }
    .mrr-card { background: #1a1a2e; border: 1px solid #2d2d44; border-radius: 16px; padding: 40px; margin-bottom: 32px; }
    .mrr-label { font-size: 0.875rem; color: #718096; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; }
    .mrr-value { font-size: 3.5rem; font-weight: 700; color: #68d391; }
    .mrr-sub { font-size: 0.875rem; color: #718096; margin-top: 8px; }
    .change { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; margin-left: 12px; }
    .change.positive { background: #22543d; color: #68d391; }
    .change.negative { background: #742a2a; color: #fc8181; }
    .change.neutral { background: #2d3748; color: #a0aec0; }
    .chart-card { background: #1a1a2e; border: 1px solid #2d2d44; border-radius: 16px; padding: 32px; }
    .chart-title { font-size: 1rem; font-weight: 600; margin-bottom: 24px; color: #e2e8f0; }
    canvas { max-height: 320px; }
    .loading { text-align: center; padding: 80px; color: #718096; }
    .error { color: #fc8181; text-align: center; padding: 40px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Stripe MRR Dashboard</h1>
    <div id="content" class="loading">Loading...</div>
  </div>
  <script>
    async function load() {
      try {
        const res = await fetch('/api/mrr');
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const weeks = data.weeks;
        const latest = weeks[weeks.length - 1].mrr;
        const prev = weeks[weeks.length - 2]?.mrr || 0;
        const change = prev > 0 ? ((latest - prev) / prev * 100).toFixed(1) : null;
        const changeClass = change === null ? 'neutral' : change >= 0 ? 'positive' : 'negative';
        const changeText = change === null ? '' : (change >= 0 ? '+' : '') + change + '% wow';

        document.getElementById('content').innerHTML = \`
          <div class="mrr-card">
            <div class="mrr-label">Monthly Recurring Revenue</div>
            <div class="mrr-value">$\${latest.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              \${changeText ? '<span class="change ' + changeClass + '">' + changeText + '</span>' : ''}
            </div>
            <div class="mrr-sub">\${data.count} active subscription\${data.count !== 1 ? 's' : ''} &nbsp;·&nbsp; updated just now</div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Weekly MRR — Last 12 Weeks</div>
            <canvas id="chart"></canvas>
          </div>
        \`;

        new Chart(document.getElementById('chart'), {
          type: 'line',
          data: {
            labels: weeks.map(w => w.label),
            datasets: [{
              label: 'MRR',
              data: weeks.map(w => w.mrr),
              borderColor: '#68d391',
              backgroundColor: 'rgba(104,211,145,0.08)',
              tension: 0.35,
              fill: true,
              pointRadius: 4,
              pointBackgroundColor: '#68d391',
            }]
          },
          options: {
            responsive: true,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: ctx => ' $' + ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                }
              }
            },
            scales: {
              x: { grid: { color: '#2d2d44' }, ticks: { color: '#718096' } },
              y: {
                grid: { color: '#2d2d44' },
                ticks: {
                  color: '#718096',
                  callback: v => '$' + v.toLocaleString()
                }
              }
            }
          }
        });
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
      }
    }
    load();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`MRR dashboard running on port ${PORT}`));
