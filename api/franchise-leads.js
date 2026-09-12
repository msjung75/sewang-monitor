// api/franchise-leads.js — Vercel serverless function
// Query: ?status=lead|confirmed|gov_only|booth_suspect|all&brand=<name>
const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const fp = path.join(process.cwd(), 'data', 'franchise_leads.json');
  let payload = { updated: null, counts: {}, leads: [] };
  try {
    if (fs.existsSync(fp)) {
      payload = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  } catch (e) {
    res.status(500).json({ error: 'read_failed', detail: String(e && e.message || e) });
    return;
  }

  const q = req.query || {};
  const status = (q.status || 'all').toString();
  const brand = (q.brand || '').toString().trim();
  let leads = Array.isArray(payload.leads) ? payload.leads : [];
  if (status !== 'all') leads = leads.filter(x => x.status === status);
  if (brand) leads = leads.filter(x => x.brand === brand);

  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).json({
    updated: payload.updated,
    counts: payload.counts,
    filter: { status, brand: brand || null },
    total: leads.length,
    leads
  });
};
