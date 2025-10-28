// server.js — Crew tracker (CommonJS) — ready for Render free tier
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ENV
const PORT = process.env.PORT || 3000;
const SOURCE_URL = process.env.SOURCE_URL || '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const VIEW_TOKEN = process.env.VIEW_TOKEN || 'view-secret';
const TEAM_NAME = (process.env.TEAM_NAME || '').trim();
const RACE_SLUG = (process.env.RACE_SLUG || 'rumited2025JTBC').trim();
const RACE_JOIN_CODE = (process.env.RACE_JOIN_CODE || '').trim();

// State (in-memory)
const state = {
  whitelist: new Set(), // set of BIB strings
  latestPayload: { ts: 0, rows: [] },
};

// --- Helpers
function requireAdmin(req, res, next) {
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${ADMIN_TOKEN}`) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}
function requireViewToken(req, res, next) {
  const t = (req.query.t || '').toString();
  if (t === VIEW_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'invalid token' });
}

// --- Scraper (adjust selectors per race page if needed)
async function scrape() {
  if (!SOURCE_URL) return;
  const r = await fetch(SOURCE_URL, { headers: { 'User-Agent':'crew-tracker/1.1' }});
  if (!r.ok) throw new Error('fetch failed: ' + r.status);
  const html = await r.text();
  const $ = cheerio.load(html);

  // Generic table parse: find rows with <td>, pick first 4 columns if exist
  const rows = [];
  $('table').each((_, table) => {
    $(table).find('tr').each((__, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return; // skip header or invalid rows
      const bib = $(tds[0]).text().trim();
      const name = $(tds[1]).text().trim();
      const team = tds[2] ? $(tds[2]).text().trim() : '';
      const splitOrTime = tds[3] ? $(tds[3]).text().trim() : '';
      if (!bib || !name) return;
      if (TEAM_NAME && team && !team.includes(TEAM_NAME)) return;
      rows.push({ bib, name, team, split: splitOrTime });
    });
  });

  // Filter by whitelist (if empty, show all)
  const filtered = rows.filter(r => state.whitelist.size === 0 ? true : state.whitelist.has(String(r.bib)));
  state.latestPayload = { ts: Date.now(), rows: filtered };
}

// Poll loop
setInterval(async () => {
  try { await scrape(); } catch (e) { console.error('scrape error', e.message); }
}, POLL_INTERVAL_MS);

// --- Join form (runner self-register by bib)
app.get(`/${RACE_SLUG}`, (req, res) => {
  res.set('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${RACE_SLUG} — 주자 등록</title>
  <style>
  body{font-family:system-ui,Segoe UI,Roboto,Noto Sans,Arial,sans-serif;background:#0b0d10;color:#e9f0f5;margin:0;padding:16px}
  main{max-width:560px;margin:0 auto}
  input,button{padding:12px;border-radius:10px;border:1px solid #2a3442;background:#151a20;color:#e9f0f5;width:100%;box-sizing:border-box}
  label{display:block;margin:12px 0 6px}button{cursor:pointer}form{display:grid;gap:10px}a{color:#9dd1ff}
  </style></head><body><main>
  <h1>🏁 ${RACE_SLUG} — 주자 등록</h1>
  <p>배번을 입력하면 실시간 뷰에 반영됩니다.${RACE_JOIN_CODE ? ' 합류코드가 필요합니다.' : ''}</p>
  <form method="post" action="/api/join">
    <input type="hidden" name="slug" value="${RACE_SLUG}"/>
    <label>합류 코드 (선택)</label>
    <input name="code" placeholder="합류 코드(없으면 비워두기)" />
    <label>배번(BIB)</label>
    <input name="bib" placeholder="예: 12345" required />
    <label>표시 이름(선택)</label>
    <input name="display" placeholder="예: 홍길동" />
    <button type="submit">등록</button>
  </form>
  <p style="margin-top:14px">이미 등록했나요? <a href="/viewer/${RACE_SLUG}?t=${encodeURIComponent(VIEW_TOKEN)}" target="_blank">실시간 보기</a></p>
  </main></body></html>`);
});

app.post('/api/join', (req, res) => {
  const { slug, code, bib, display } = req.body || {};
  if (slug !== RACE_SLUG) return res.status(400).send('invalid slug');
  if (RACE_JOIN_CODE && code !== RACE_JOIN_CODE) return res.status(401).send('wrong code');
  const b = String(bib||'').trim();
  if (!b) return res.status(400).send('missing bib');
  state.whitelist.add(b);
  res.set('Content-Type','text/html; charset=utf-8');
  res.end(`<meta charset="utf-8"/><p>등록 완료! 배번 #${b}</p><p><a href="/viewer/${RACE_SLUG}?t=${encodeURIComponent(VIEW_TOKEN)}">실시간 보기로 이동</a></p>`);
});

// Viewer
app.get('/viewer/:slug', requireViewToken, (req, res) => {
  if (req.params.slug !== RACE_SLUG) return res.status(404).send('not found');
  res.set('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Crew Live — ${RACE_SLUG}</title>
  <style>
  body{font-family:system-ui,Segoe UI,Roboto,Noto Sans,Arial,sans-serif;background:#0b0d10;color:#e9f0f5;margin:0}
  main{max-width:720px;margin:0 auto;padding:16px}
  .cards{display:grid;grid-template-columns:1fr;gap:12px}
  .card{background:#151a20;border:1px solid #202833;border-radius:14px;padding:12px 14px}
  .meta{display:flex;gap:10px;opacity:.8;font-size:14px}
  .name{font-size:18px;font-weight:700}
  .split{font-feature-settings:"tnum" 1;font-variant-numeric:tabular-nums}
  @media(min-width:640px){.cards{grid-template-columns:1fr 1fr}}
  </style></head><body><main>
  <header style="display:flex;justify-content:space-between;align-items:baseline"><h1>🏁 Crew Live</h1><div id="last">-</div></header>
  <section id="list" class="cards"></section>
  <script>
    const es = new EventSource('/events?t=${encodeURIComponent(VIEW_TOKEN)}&slug=${encodeURIComponent(RACE_SLUG)}');
    const list = document.getElementById('list');
    const last = document.getElementById('last');
    function render(p){
      const { ts, rows } = p||{ts:0,rows:[]};
      last.textContent = ts? new Date(ts).toLocaleTimeString() : '-';
      list.innerHTML = rows.map(r=>\`
        <div class='card'>
          <div class='meta'><span>#\${r.bib}</span> <span>\${r.team||''}</span></div>
          <div class='name'>\${r.name||''}</div>
          <div class='split'>\${r.split||''}</div>
        </div>\`
      ).join('');
    }
    es.onmessage = e=>{ try{ render(JSON.parse(e.data)); }catch{} };
  </script>
  </main></body></html>`);
});

// Data APIs & SSE
app.get('/api/crew', requireViewToken, (req, res) => {
  const { slug } = req.query;
  if (slug !== RACE_SLUG) return res.status(404).json({ ok:false });
  res.json(state.latestPayload);
});

app.get('/events', requireViewToken, (req, res) => {
  const { slug } = req.query;
  if (slug !== RACE_SLUG) return res.status(404).end();
  res.set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
  const send = () => res.write(`data: ${JSON.stringify(state.latestPayload)}\n\n`);
  send();
  const iv = setInterval(send, POLL_INTERVAL_MS);
  req.on('close', () => clearInterval(iv));
});

// Admin
app.post('/admin/whitelist', requireAdmin, (req, res) => {
  const s = new Set();
  if (Array.isArray(req.body?.bibs)) req.body.bibs.forEach(b => s.add(String(b).trim()));
  state.whitelist = s;
  res.json({ ok:true, count: s.size });
});

app.post('/admin/refresh', requireAdmin, async (req, res) => {
  try { await scrape(); res.json({ ok:true, ts: state.latestPayload.ts, count: state.latestPayload.rows.length }); }
  catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// Health
app.get('/healthz', (_,res)=>res.send('ok'));

app.listen(PORT, ()=> console.log('crew-tracker backend on', PORT, 'slug=', RACE_SLUG));