const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

const RAW_URL = 'https://docs.google.com/spreadsheets/d/1jHsmG5llwTtDvprziPG8mm7E5zyCkmxSiMdROIaYkw0/export?format=csv';
const L1_URL  = 'https://docs.google.com/spreadsheets/d/1K-yubClxpEqYIY1aP2KY8oe7h5faH6pXTJ9o0lJZfhw/export?format=csv&gid=1787215236';

// In-memory cache
let cache = { data: null, ts: 0 };
const CACHE_MS = 30 * 60 * 1000; // 30 min

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    if (!force && cache.data && Date.now() - cache.ts < CACHE_MS) {
      return res.json({ ...cache.data, cached: true });
    }

    // Fetch both sheets
    const [rawText, l1Text] = await Promise.all([
      fetch(RAW_URL).then(r => r.text()),
      fetch(L1_URL).then(r => r.text())
    ]);

    const rawRows = parseCSV(rawText);
    const l1Rows  = parseCSV(l1Text);

    // Build conversion map
    const convMap = new Map();
    l1Rows.forEach(r => {
      const status = (r['Paid Status'] || '').trim().toLowerCase();
      if (status !== 'online' && status !== 'offline') return;
      const pd  = parsePaidDate(r['Paid Date '] || r['Paid Date'] || '');
      const p   = normPhone(r['Phone Number']);
      const alt = normPhone(r['Alternate number']);
      if (p)   { if (!convMap.has(p))   convMap.set(p,   []); convMap.get(p).push(pd); }
      if (alt && alt !== p && alt.length === 10) {
               if (!convMap.has(alt)) convMap.set(alt, []); convMap.get(alt).push(pd); }
    });

    // Build phone → sorted lead history
    const phoneLeads = new Map();
    const monthSet   = new Set();
    const batchSet   = new Set();

    rawRows.forEach(r => {
      const ct = r['created_time'] || '';
      if (!ct.startsWith('202')) return;
      const ph = normPhone(r['phone']);
      if (!ph) return;
      const dt = new Date(ct);
      if (isNaN(dt)) return;
      const ad    = (r['ad_name'] || 'Unknown').trim();
      const batch = (r['Batch Code'] || '').trim();
      const month = ct.slice(0, 7);
      const sugar = (r['what_is_your_sugar_level?_/_\u0b89\u0b99\u0bcd\u0b95\u0bb3\u0bcd_\u0b9a\u0b95\u0bcd\u0b95\u0bb0\u0bc8_\u0b85\u0bb3\u0bb5\u0bc1_\u0b8e\u0ba9\u0bcd\u0ba9?'] || '').toLowerCase();
      const isDiabetic = sugar && !sugar.includes('no_sugar') && sugar !== '';
      monthSet.add(month);
      if (batch) batchSet.add(batch);
      if (!phoneLeads.has(ph)) phoneLeads.set(ph, []);
      phoneLeads.get(ph).push({ dt, ad, batch, month, isDiabetic, sugar });
    });

    phoneLeads.forEach(arr => arr.sort((a, b) => a.dt - b.dt));

    // Attribution
    const adMap = new Map();
    let attributed = 0, noLead = 0, noDate = 0, afterDate = 0;

    convMap.forEach((paidDates, ph) => {
      const leads = phoneLeads.get(ph);
      if (!leads || !leads.length) { noLead += paidDates.length; return; }
      paidDates.forEach(pd => {
        let attr;
        if (!pd) { attr = leads[leads.length - 1]; noDate++; }
        else {
          const before = leads.filter(l => l.dt <= pd);
          if (before.length) { attr = before[before.length - 1]; attributed++; }
          else               { attr = leads[0]; afterDate++; }
        }
        const k = attr.ad;
        if (!adMap.has(k)) adMap.set(k, { ad: k, rawLeads: 0, uKeys: new Set(), dKeys: new Set(), conv: 0, months: new Set(), batches: new Set(), sugarCounts: {} });
        adMap.get(k).conv++;
      });
    });

    // Aggregate unique leads
    rawRows.forEach(r => {
      const ct = r['created_time'] || '';
      if (!ct.startsWith('202')) return;
      const ph = normPhone(r['phone']); if (!ph) return;
      const ad    = (r['ad_name'] || 'Unknown').trim();
      const batch = (r['Batch Code'] || '').trim();
      const month = ct.slice(0, 7);
      const sugar = (r['what_is_your_sugar_level?_/_\u0b89\u0b99\u0bcd\u0b95\u0bb3\u0bcd_\u0b9a\u0b95\u0bcd\u0b95\u0bb0\u0bc8_\u0b85\u0bb3\u0bb5\u0bc1_\u0b8e\u0ba9\u0bcd\u0ba9?'] || '').toLowerCase();
      const isDiabetic = sugar && !sugar.includes('no_sugar') && sugar !== '';
      if (!adMap.has(ad)) adMap.set(ad, { ad, rawLeads: 0, uKeys: new Set(), dKeys: new Set(), conv: 0, months: new Set(), batches: new Set(), sugarCounts: {} });
      const s = adMap.get(ad);
      s.rawLeads++;
      s.uKeys.add(ph + '|' + month);
      if (isDiabetic) s.dKeys.add(ph + '|' + month);
      s.months.add(month);
      if (batch) s.batches.add(batch);
      s.sugarCounts[sugar] = (s.sugarCounts[sugar] || 0) + 1;
    });

    const ads = [...adMap.values()].map(s => ({
      ad:       s.ad,
      rawLeads: s.rawLeads,
      uLeads:   s.uKeys.size,
      dULeads:  s.dKeys.size,
      conv:     s.conv,
      months:   [...s.months].sort(),
      batches:  [...s.batches].sort(),
      sugarCounts: s.sugarCounts
    }));

    const result = {
      ads,
      months:    [...monthSet].sort(),
      batches:   [...batchSet].sort(),
      attrStats: { attributed, noLead, noDate, afterDate },
      totalRaw:  rawRows.length,
      generatedAt: new Date().toISOString()
    };

    cache = { data: result, ts: Date.now() };
    res.json(result);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Helpers
function normPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function parsePaidDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const p = s.split('/');
  if (p.length === 3) {
    const [d, m, y] = p;
    return new Date(+(y.length === 2 ? '20' + y : y), +m - 1, +d);
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

function parseCSV(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const headers = splitLine(lines[0].replace(/\r/g, '')).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g, '');
    if (!line.trim()) continue;
    const vals = splitLine(line);
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').replace(/^"|"$/g, '').trim(); });
    rows.push(row);
  }
  return rows;
}

function splitLine(line) {
  const res = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { res.push(cur); cur = ''; }
    else { cur += c; }
  }
  res.push(cur);
  return res;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
