// server.js — Crew tracker — v2.3.1
// - Zero dependency
// - KM parsing + estimated KM
// - Robust parsing for myresult detail pages (labels: 번호/이름/소속 + split table)
const http = require('http');
const { URL } = require('url');
const querystring = require('querystring');

// ENV
const PORT = process.env.PORT || 3000;
const SOURCE_URL = process.env.SOURCE_URL || '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const VIEW_TOKEN = process.env.VIEW_TOKEN || 'view-secret';
const TEAM_NAME = (process.env.TEAM_NAME || '').trim();
const RACE_SLUG = (process.env.RACE_SLUG || 'rumited2025JTBC').trim();
const RACE_JOIN_CODE = (process.env.RACE_JOIN_CODE || '').trim();
const RACE_START_ISO = process.env.RACE_START_ISO || '';
const FULL_DISTANCE_KM = Number(process.env.FULL_DISTANCE_KM || 42.195);

// State
const state = {
  whitelist: new Set(),
  displayNames: new Map(),
  latestPayload: { ts: 0, rows: [] },
  lastManualRefreshAt: 0,
  sseClients: new Set(),
};

function sendJSON(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}
function sendHTML(res, html) {
  const data = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}
function unauthorized(res) { sendJSON(res, 401, { ok:false, error:'unauthorized' }); }
function notFound(res) { res.writeHead(404); res.end('not found'); }
function requireViewToken(urlObj) { const t = String(urlObj.searchParams.get('t') || ''); return t === VIEW_TOKEN; }

function buildFallbackRows() {
  const rows = [];
  for (const bib of state.whitelist) {
    const name = state.displayNames.get(String(bib)) || '(이름 미입력)';
    rows.push({ bib: String(bib), name, team: '', split: '', km: null, est_km: null });
  }
  return rows;
}

// --- Utilities
function stripTags(s){ return String(s||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(); }
function parseHMS(str){
  const s = String(str||'').trim();
  const parts = s.split(':').map(x=>x.trim()).filter(x=>x.length>0);
  if (parts.length === 3){
    const [h,m,ss] = parts; return (+h)*3600 + (+m)*60 + (+ss);
  } else if (parts.length === 2){
    const [m,ss] = parts; return (+m)*60 + (+ss);
  } else if (/^\d+$/.test(s)){
    return +s;
  }
  return NaN;
}
function pickKm(text){
  const t = String(text||'');
  // numeric forms like 5k, 5km, 21.1K
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:km|KM|k|K)\b/);
  if (m) return parseFloat(m[1]);
  // half/full keywords
  if (/\bhalf\b|하프/i.test(t)) return 21.0975;
  if (/\bfull\b|풀코스|마라톤/i.test(t)) return 42.195;
  // CP naming like "CP30" or "30 CP"
  m = t.match(/\b(\d{1,2}(?:\.\d+)?)\s*CP\b|\bCP\s*(\d{1,2}(?:\.\d+)?)\b/i);
  if (m) return parseFloat(m[1] || m[2]);
  return null;
}

// Try to parse list tables (listing many runners)
function parseListTables(html) {
  const rows = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  const tables = html.match(tableRe) || [];
  for (const table of tables) {
    // detect data rows by presence of multiple <td> columns
    let m;
    while ((m = trRe.exec(table)) !== null) {
      const tr = m[0];
      if (/<th/i.test(tr)) continue;
      const cells = [];
      let c;
      while ((c = tdRe.exec(tr)) !== null) cells.push(stripTags(c[1]));
      if (cells.length < 2) continue;

      // heuristic: first cell looks like bib (numbers), second looks like name (non-empty)
      const candBib = (cells[0]||'').trim();
      const candName = (cells[1]||'').trim();
      if (!candBib || !candName) continue;
      // simple guard
      if (!/^\d{1,6}$/.test(candBib)) continue;

      const team = (cells[2]||'').trim();
      const split = (cells[3]||'').trim();
      let km = pickKm((cells[4]||'') + " " + split);
      const display = state.displayNames.get(String(candBib));
      rows.push({ bib: candBib, name: display || candName, team, split, km });
    }
  }
  return rows;
}

// Try to parse a single-runner detail page: labels + split table
function parseDetailPage(html) {
  const text = html;
  // extract bib/name/team by Korean labels common on myresult
  function pickLabel(regexArr){
    for (const rx of regexArr){
      const m = text.match(rx);
      if (m) return stripTags(m[1] || m[2] || m[0]);
    }
    return null;
  }
  const bib = pickLabel([
    /(?:번호|배번)[^<]*<\/[^>]+>\s*<[^>]+>([\s\S]*?)<\/td>/i,
    /(?:번호|배번)\s*[:：]\s*<\/?[^>]*>\s*([\d\-]+)/i,
    /<dt[^>]*>(?:번호|배번)[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/i
  ]);
  const name = pickLabel([
    /(?:이름|성명)[^<]*<\/[^>]+>\s*<[^>]+>([\s\S]*?)<\/td>/i,
    /<dt[^>]*>(?:이름|성명)[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/i
  ]);
  const team = pickLabel([
    /(?:소속|클럽)[^<]*<\/[^>]+>\s*<[^>]+>([\s\S]*?)<\/td>/i,
    /<dt[^>]*>(?:소속|클럽)[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/i
  ]) || '';

  // split table: find max km + its time
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let maxKm = null, latestSplit = '';
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const tr = m[0];
    if (/<th/i.test(tr)) continue;
    const cells = [];
    let c;
    while ((c = tdRe.exec(tr)) !== null) cells.push(stripTags(c[1]));
    if (cells.length === 0) continue;
    const rowText = cells.join(' ').toLowerCase();
    const km = pickKm(rowText);
    if (km != null) {
      // guess time column from any H:MM:SS-looking cell
      const timeCell = cells.find(x => /^(?:\d+:)?\d{1,2}:\d{2}$/.test(x.trim())) || cells.find(x => /^\d{1,2}:\d{2}:\d{2}$/.test(x.trim())) || '';
      if (maxKm == null || km > maxKm) {
        maxKm = km;
        latestSplit = timeCell;
      }
    }
  }

  if (bib && name) {
    const display = state.displayNames.get(String(bib));
    return [{ bib: String(bib).trim(), name: display || String(name).trim(), team: String(team||'').trim(), split: latestSplit, km: maxKm }];
  }
  return [];
}

function parseAny(html){
  // try list first
  let rows = parseListTables(html);
  if (rows.length > 0) return rows;
  // fall back to detail parser
  rows = parseDetailPage(html);
  return rows;
}

function estimateKM(row){
  if (!RACE_START_ISO) return null;
  if (!row) return null;
  const km = (row.km!=null) ? Number(row.km) : null;
  const splitSec = parseHMS(row.split);
  if (km==null || !isFinite(km) || !isFinite(splitSec)) return null;
  const start = Date.parse(RACE_START_ISO);
  if (!isFinite(start)) return null;
  const nowSec = Date.now()/1000;
  const elapsed = nowSec - start/1000;
  if (!isFinite(elapsed) || elapsed < 0) return km;
  const pace = splitSec / (km>0 ? km : 1);
  if (!isFinite(pace) || pace <= 0) return km;
  const est = Math.max(km, Math.min(FULL_DISTANCE_KM, elapsed / pace));
  return est;
}

async function scrape() {
  let rows = [];
  if (SOURCE_URL) {
    try {
      const r = await fetch(SOURCE_URL, { headers: { 'User-Agent':'crew-tracker/1.6 (render)' }});
      if (r.ok) {
        const html = await r.text();
        rows = parseAny(html);
        rows = rows.map(r => ({ ...r, est_km: estimateKM(r) }));
      } else {
        console.error('fetch failed', r.status, r.statusText);
      }
    } catch (e) {
      console.error('scrape error', e.message);
    }
  }
  let filtered = rows;
  if (state.whitelist.size > 0) filtered = rows.filter(r => state.whitelist.has(String(r.bib)));
  if ((!filtered || filtered.length === 0) && state.whitelist.size > 0) filtered = buildFallbackRows();
  state.latestPayload = { ts: Date.now(), rows: filtered };
  const payload = `data: ${JSON.stringify(state.latestPayload)}\n\n`;
  for (const res of state.sseClients) { try { res.write(payload); } catch {} }
}

setInterval(scrape, POLL_INTERVAL_MS);

// HTML templates
function joinHTML() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${RACE_SLUG} — 주자 등록</title>
  <style>
  body{font-family:system-ui,Segoe UI,Roboto,Noto Sans,Arial,sans-serif;background:#0b0d10;color:#e9f0f5;margin:0;padding:16px}
  main{max-width:560px;margin:0 auto}
  input,button{padding:12px;border-radius:10px;border:1px solid #2a3442;background:#151a20;color:#e9f0f5;width:100%;box-sizing:border-box}
  label{display:block;margin:12px 0 6px}button{cursor:pointer}form{display:grid;gap:10px}a{color:#9dd1ff}
  </style></head><body><main>
  <h1>🏁 ${RACE_SLUG} — 주자 등록</h1>
  <p>배번과 이름을 입력하면 뷰어에 반영됩니다.${RACE_JOIN_CODE ? ' 합류코드가 필요합니다.' : ''}</p>
  <form method="post" action="/api/join">
    <input type="hidden" name="slug" value="${RACE_SLUG}"/>
    <label>합류 코드 (선택)</label>
    <input name="code" placeholder="합류 코드(없으면 비워두기)" />
    <label>배번(BIB) <span style="color:#ff9">※필수</span></label>
    <input name="bib" placeholder="예: 12345" required />
    <label>이름 <span style="color:#ff9">※필수</span></label>
    <input name="display" placeholder="예: 홍길동" required />
    <button type="submit">등록</button>
  </form>
  <p style="margin-top:14px">이미 등록했나요? <a href="/viewer/${RACE_SLUG}?t=${encodeURIComponent(VIEW_TOKEN)}" target="_blank">실시간 보기</a></p>
  </main></body></html>`;
}

function viewerHTML() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Crew Live — ${RACE_SLUG}</title>
  <style>
  body{font-family:system-ui,Segoe UI,Roboto,Noto Sans,Arial,sans-serif;background:#0b0d10;color:#e9f0f5;margin:0}
  main{max-width:820px;margin:0 auto;padding:16px}
  .toolbar{display:flex;gap:8px;margin:4px 0 12px}
  .btn{padding:8px 12px;border-radius:10px;border:1px solid #202833;background:#141a22;color:#e9f0f5;cursor:pointer}
  .cards{display:grid;grid-template-columns:1fr;gap:12px}
  .card{background:#151a20;border:1px solid #202833;border-radius:14px;padding:12px 14px}
  .meta{display:flex;gap:10px;opacity:.8;font-size:14px}
  .name{font-size:18px;font-weight:700}
  .split{font-feature-settings:"tnum" 1;font-variant-numeric:tabular-nums}
  .km{opacity:.95;margin-top:6px;font-size:14px}
  @media(min-width:760px){.cards{grid-template-columns:1fr 1fr}}
  </style></head><body><main>
  <header style="display:flex;justify-content:space-between;align-items:baseline"><h1>🏁 Crew Live</h1><div id="last">-</div></header>
  <div class="toolbar"><button id="refresh" class="btn">🔄 새로고침</button><span id="status"></span></div>
  <section id="list" class="cards"></section>
  <script>
    const t = ${JSON.stringify(VIEW_TOKEN)};
    const slug = ${JSON.stringify(RACE_SLUG)};
    const es = new EventSource('/events?t='+encodeURIComponent(t)+'&slug='+encodeURIComponent(slug));
    const list = document.getElementById('list');
    const last = document.getElementById('last');
    const btn = document.getElementById('refresh');
    const status = document.getElementById('status');
    let lastRows = [];
    function render(p){
      const ts = (p && p.ts) ? p.ts : 0;
      const rows = (p && p.rows) ? p.rows : [];
      last.textContent = ts ? new Date(ts).toLocaleTimeString() : '-';
      const before = new Map((lastRows||[]).map(function(r){ return [String(r.bib), r]; }));
      list.innerHTML = rows.map(function(r){
        var kmLine = "";
        if (r.km != null) kmLine += "통과: " + Number(r.km).toFixed(1) + " km";
        if (r.est_km != null) kmLine += (kmLine? " · " : "") + "추정: " + Number(r.est_km).toFixed(1) + " km";
        return ""
          + "<div class='card' data-bib='" + String(r.bib) + "'>"
          +   "<div class='meta'><span>#"+ String(r.bib) +"</span> <span>"+ (r.team||'') +"</span></div>"
          +   "<div class='name'>"+ (r.name||'') +"</div>"
          +   "<div class='split'>"+ (r.split||'') +"</div>"
          +   (kmLine ? "<div class='km'>" + kmLine + "</div>" : "")
          + "</div>";
      }).join("");
      rows.forEach(function(r){
        const el = list.querySelector("[data-bib='"+ String(r.bib) +"']");
        const prev = before.get(String(r.bib));
        if (!prev || (prev.split||'') !== (r.split||'') || (prev.name||'') !== (r.name||'') || (prev.km||null) !== (r.km||null)) {
          if (el) el.animate([
            { filter:'brightness(0.9)' },
            { filter:'brightness(1.35)' },
            { filter:'brightness(1.0)' }
          ], { duration:600, easing:'ease' });
        }
      });
      lastRows = rows;
    }
    es.onmessage = function(e){ try{ render(JSON.parse(e.data)); }catch{} };
    btn.onclick = async function(){
      btn.disabled = true; status.textContent = '갱신 중...';
      try{
        const r = await fetch('/refresh?t='+encodeURIComponent(t), { method:'POST' });
        const j = await r.json();
        if(j.ok){ status.textContent = '갱신 완료 (' + new Date(j.ts).toLocaleTimeString() + ')'; }
        else { status.textContent = '대기(과다요청)'; }
      }catch{ status.textContent = '오류'; }
      finally{ setTimeout(function(){ btn.disabled=false; }, 800); }
    };
  </script>
  </main></body></html>`;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    // root -> redirect to viewer
    if (urlObj.pathname === '/') {
      res.writeHead(302, { Location: `/viewer/${RACE_SLUG}?t=${encodeURIComponent(VIEW_TOKEN)}` });
      return res.end();
    }
    if (urlObj.pathname === '/healthz') return res.end('ok');

    // join page
    if (urlObj.pathname === `/${RACE_SLUG}` && req.method === 'GET') {
      return sendHTML(res, joinHTML());
    }
    // join submit
    if (urlObj.pathname === '/api/join' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const data = querystring.parse(body);
        const slug = String(data.slug || '');
        const code = String(data.code || '');
        const bib = String(data.bib || '').trim();
        const display = String(data.display || '').trim();
        if (slug !== RACE_SLUG) return sendHTML(res, 'invalid slug');
        if (RACE_JOIN_CODE && code !== RACE_JOIN_CODE) return sendHTML(res, 'wrong code');
        if (!bib) return sendHTML(res, 'missing bib');
        if (!display) return sendHTML(res, 'missing name');
        state.whitelist.add(bib);
        state.displayNames.set(bib, display);
        return sendHTML(res, `<meta charset="utf-8"/><p>등록 완료! 배번 #${bib}, 이름 ${display}</p><p><a href="/viewer/${RACE_SLUG}?t=${encodeURIComponent(VIEW_TOKEN)}">실시간 보기로 이동</a></p>`);
      });
      return;
    }

    // API: crew
    if (urlObj.pathname === '/api/crew' && req.method === 'GET') {
      if (!requireViewToken(urlObj)) return unauthorized(res);
      const slug = urlObj.searchParams.get('slug');
      if (slug !== RACE_SLUG) return notFound(res);
      return sendJSON(res, 200, state.latestPayload);
    }

    // SSE events
    if (urlObj.pathname === '/events' && req.method === 'GET') {
      if (!requireViewToken(urlObj)) return unauthorized(res);
      const slug = urlObj.searchParams.get('slug');
      if (slug !== RACE_SLUG) return notFound(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(state.latestPayload)}\n\n`);
      state.sseClients.add(res);
      req.on('close', () => state.sseClients.delete(res));
      return;
    }

    // public refresh
    if (urlObj.pathname === '/refresh' && req.method === 'POST') {
      if (!requireViewToken(urlObj)) return unauthorized(res);
      const now = Date.now();
      if (now - state.lastManualRefreshAt < 5000) return sendJSON(res, 429, { ok:false, error:'too many refreshes' });
      state.lastManualRefreshAt = now;
      await scrape();
      return sendJSON(res, 200, { ok:true, ts: state.latestPayload.ts, count: state.latestPayload.rows.length });
    }

    // viewer
    if (urlObj.pathname === `/viewer/${RACE_SLUG}` && req.method === 'GET') {
      if (!requireViewToken(urlObj)) return unauthorized(res);
      return sendHTML(res, viewerHTML());
    }

    notFound(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message||e));
  }
});

server.listen(PORT, () => {
  console.log('crew-tracker v2.3.1 on', PORT, 'slug=', RACE_SLUG);
});