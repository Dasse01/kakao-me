// 입시뉴스 자동화 단일 함수: /api/cron, /news/:date, /api/auth/start, /api/auth/callback (vercel.json rewrites 참고)
const __defs = {}, __cache = {};
function __req(n) { if (!__defs[n]) return require(n); if (__cache[n]) return __cache[n].exports; const m = { exports: {} }; __cache[n] = m; __defs[n](m, m.exports, __req); return m.exports; }
__defs['store'] = function (module, exports, require) {
// Upstash Redis (REST) 최소 클라이언트. Vercel Storage 로 Upstash 를 연결하면 환경변수가 자동 주입된다.
const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function cmd(args) {
  if (!URL_() || !TOKEN()) throw new Error('저장소(Upstash Redis)가 연결되지 않았습니다.');
  const r = await fetch(URL_(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

async function getJson(key) {
  const v = await cmd(['GET', key]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
async function setJson(key, val, exSeconds) {
  const a = ['SET', key, JSON.stringify(val)];
  if (exSeconds) a.push('EX', String(exSeconds));
  return cmd(a);
}
const sismember = async (k, m) => (await cmd(['SISMEMBER', k, String(m)])) === 1;
const sadd = (k, ...m) => cmd(['SADD', k, ...m.map(String)]);

module.exports = { cmd, getJson, setJson, sismember, sadd };

};
__defs['kakao'] = function (module, exports, require) {
const store = require('store');
const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const SEND_URL = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';

function origin() { return process.env.SITE_ORIGIN || 'https://kakao-me-tau.vercel.app'; }

async function tokenRequest(params) {
  const body = new URLSearchParams(Object.assign({ client_id: process.env.KAKAO_REST_KEY }, params));
  if (process.env.KAKAO_CLIENT_SECRET) body.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString(),
  });
  return r.json();
}

async function saveTokens(t, old) {
  const now = Date.now();
  const d = Object.assign({}, old || {});
  d.access = t.access_token;
  d.access_exp = now + (Number(t.expires_in) || 21599) * 1000;
  if (t.refresh_token) {
    d.refresh = t.refresh_token;
    d.refresh_exp = now + (Number(t.refresh_token_expires_in) || 5184000) * 1000;
  }
  await store.setJson('kakao:tokens', d);
  return d;
}

async function getAccessToken() {
  let d = await store.getJson('kakao:tokens');
  if (!d || !d.refresh) throw new Error('카카오 토큰이 없습니다. /api/auth/start?key=(CRON_SECRET) 로 한 번 로그인하세요.');
  if (d.access && d.access_exp - 300000 > Date.now()) return d.access;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: d.refresh });
  if (!t.access_token) throw new Error('토큰 갱신 실패: ' + (t.error_description || t.error || JSON.stringify(t)));
  d = await saveTokens(t, d);
  return d.access;
}

async function sendText(text, link, buttonTitle) {
  const access = await getAccessToken();
  const tpl = { object_type: 'text', text, link: { web_url: link, mobile_web_url: link }, button_title: buttonTitle || '브리핑 보기' };
  const r = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams({ template_object: JSON.stringify(tpl) }).toString(),
  });
  const j = await r.json();
  if (j.result_code !== 0) throw new Error('카카오 전송 실패: ' + JSON.stringify(j));
  return true;
}

module.exports = { origin, tokenRequest, saveTokens, getAccessToken, sendText };

};
__defs['llm'] = function (module, exports, require) {
// OpenAI 또는 Anthropic 중 키가 있는 쪽을 사용한다(ANTHROPIC_API_KEY 우선).
async function complete(prompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'claude-sonnet-5-5', max_tokens: 3500, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    if (!j.content || !j.content[0]) throw new Error('Anthropic 응답 오류: ' + JSON.stringify(j).slice(0, 300));
    return j.content.map((c) => c.text || '').join('');
  }
  if (process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    if (!j.choices) throw new Error('OpenAI 응답 오류: ' + JSON.stringify(j).slice(0, 300));
    return j.choices[0].message.content;
  }
  throw new Error('AI 키가 없습니다. ANTHROPIC_API_KEY 또는 OPENAI_API_KEY 를 설정하세요.');
}

function parseJson(text) {
  let s = String(text).replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI 응답에서 JSON 을 찾지 못했습니다.');
  return JSON.parse(s.slice(a, b + 1));
}

module.exports = { complete, parseJson };

};
__defs['veritas'] = function (module, exports, require) {
const BASE = 'https://www.veritas-a.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; NewsDigest/1.0)' };

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const strip = (h) => decode(h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}

async function listIds(limit = 15) {
  const html = await get(BASE + '/');
  const ids = new Set();
  const re = /articleView\.html\?idxno=(\d+)/g;
  let m;
  while ((m = re.exec(html))) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => b - a).slice(0, limit);
}

async function article(id) {
  const url = `${BASE}/news/articleView.html?idxno=${id}`;
  const html = await get(url);
  const meta = (p) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i'));
    return m ? decode(m[1]) : '';
  };
  const b = html.match(/<article[^>]*id=["']article-view-content-div["'][^>]*>([\s\S]*?)<\/article>/i);
  const body = b ? strip(b[1]) : '';
  const published = meta('article:published_time');
  return {
    id, url,
    title: meta('og:title').replace(/\s*[-|]\s*베리타스알파.*$/, ''),
    published: published ? new Date(published).getTime() || null : null,
    paywalled: /구독자\s*전용/.test(body) && body.length < 2500,
    body,
  };
}

module.exports = { listIds, article };

};
__defs['digest'] = function (module, exports, require) {
const veritas = require('veritas');
const llm = require('llm');
const store = require('store');

const kstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

async function build({ force = false, hours = 36 } = {}) {
  const ids = await veritas.listIds(14);
  const now = Date.now();
  const arts = [];
  for (const id of ids) {
    if (!force && (await store.sismember('news:seen', id))) continue;
    try {
      const a = await veritas.article(id);
      if (a.published && now - a.published > hours * 3600e3) continue;
      arts.push(a);
    } catch (e) { /* 개별 기사 실패는 건너뜀 */ }
    if (arts.length >= 7) break;
  }
  if (!arts.length) return null;

  const free = arts.filter((a) => !a.paywalled && a.body.length > 300);
  const locked = arts.filter((a) => !free.includes(a));
  let items = [];
  if (free.length) {
    const prompt = `당신은 대입 입시 전문 에디터입니다. 아래 기사들을 읽고 JSON 으로만 답하세요.
형식: {"items":[{"id":숫자,"bullets":["핵심1","핵심2","핵심3"],"summary":"3~4문장 요약"}],"top3":["오늘의 핵심1(40자 이내)","핵심2","핵심3"]}
규칙: 기사에 없는 내용은 쓰지 말고, 수치(인원·비율·날짜)는 정확히 옮기세요. 한국어. 문자열 안에 큰따옴표(")와 줄바꿈을 쓰지 말고 작은따옴표나 괄호를 쓰세요. 순수 JSON 만 출력.

` + free.map((a) => `[id:${a.id}] ${a.title}\n${a.body.slice(0, 6000)}`).join('\n\n---\n\n');
    let out; for (let k = 0; k < 2; k++) { try { out = llm.parseJson(await llm.complete(prompt)); break; } catch (e) { if (k) throw e; } }
    items = free.map((a) => {
      const x = (out.items || []).find((i) => Number(i.id) === a.id) || {};
      return { id: a.id, url: a.url, title: a.title, bullets: x.bullets || [], summary: x.summary || '' };
    });
    var top3 = out.top3 || [];
  }
  const day = {
    date: kstDate(), createdAt: now,
    top3: (typeof top3 !== 'undefined' ? top3 : []).slice(0, 3),
    items,
    locked: locked.map((a) => ({ id: a.id, url: a.url, title: a.title })),
  };
  await store.setJson('news:' + day.date, day, 60 * 60 * 24 * 60);
  await store.sadd('news:seen', ...arts.map((a) => a.id));
  return day;
}

function kakaoText(day, origin) {
  const md = day.date.slice(5).replace('-', '/');
  const lines = day.top3.map((t, i) => `${i + 1}. ${String(t).slice(0, 45)}`);
  const url = `${origin}/news/${day.date}`;
  let text = `[입시뉴스 ${md}]\n${lines.join('\n')}\n▶ ${url}`;
  while (text.length > 200 && lines.length) { // 200자 제한 보호
    const i = lines.reduce((m, l, k) => (l.length > lines[m].length ? k : m), 0);
    lines[i] = lines[i].slice(0, Math.max(10, lines[i].length - 8)) + '…';
    text = `[입시뉴스 ${md}]\n${lines.join('\n')}\n▶ ${url}`;
  }
  return { text, url };
}

module.exports = { build, kakaoText, kstDate };

};
__defs['cron'] = function (module, exports, require) {
const { build, kakaoText } = require('digest');
const kakao = require('kakao');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const ok = secret && (req.headers.authorization === 'Bearer ' + secret || req.query.key === secret);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  try {
    const day = await build({ force: req.query.force === '1' });
    if (!day) return res.json({ ok: true, sent: false, reason: '새 기사 없음' });
    if (!day.top3.length) day.top3 = [...day.items.map((i) => i.title), ...day.locked.map((l) => l.title)].slice(0, 3);
    const { text, url } = kakaoText(day, kakao.origin());
    if (req.query.dry === '1') return res.json({ ok: true, dry: true, text });
    await kakao.sendText(text, url);
    res.json({ ok: true, sent: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
module.exports.config = { maxDuration: 60 };

};
__defs['news'] = function (module, exports, require) {
const store = require('store');
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = async (req, res) => {
  const date = String(req.query.date || '').replace(/[^0-9-]/g, '');
  let day = null;
  try { day = await store.getJson('news:' + date); } catch (e) {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300');
  if (!day) return res.status(404).send('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px">해당 날짜의 브리핑이 없습니다.</body>');
  const items = day.items.map((i) => `
    <section><h2><a href="${esc(i.url)}">${esc(i.title)}</a></h2>
    <ul>${i.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <p>${esc(i.summary)}</p></section>`).join('');
  const locked = day.locked.length ? `<h3>구독자 전용(본문 미요약)</h3><ul>${day.locked.map((l) => `<li><a href="${esc(l.url)}">${esc(l.title)}</a></li>`).join('')}</ul>` : '';
  res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>입시뉴스 ${esc(day.date)}</title><meta name="robots" content="noindex">
<style>body{font-family:system-ui,'Malgun Gothic',sans-serif;max-width:720px;margin:0 auto;padding:20px;line-height:1.7;color:#222}
h1{font-size:22px}h2{font-size:17px;margin:0 0 6px}a{color:#0b57d0}section{border-top:1px solid #ddd;padding:14px 0}.top{background:#f4f6fb;border-radius:10px;padding:12px 18px}small{color:#777}</style></head>
<body><h1>입시뉴스 브리핑 ${esc(day.date)}</h1>
<div class="top"><b>오늘의 핵심</b><ol>${day.top3.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
${items}${locked}<p><small>출처: 베리타스알파. AI 요약이므로 원문 확인 권장.</small></p></body></html>`);
};

};
__defs['start'] = function (module, exports, require) {
const crypto = require('crypto');
const kakao = require('kakao');
module.exports = (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.query.key !== secret) return res.status(401).send('unauthorized');
  const state = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 24);
  const q = new URLSearchParams({
    client_id: process.env.KAKAO_REST_KEY, redirect_uri: kakao.origin() + '/api/auth/callback',
    response_type: 'code', scope: 'talk_message', state,
  });
  res.redirect(302, 'https://kauth.kakao.com/oauth/authorize?' + q);
};

};
__defs['callback'] = function (module, exports, require) {
const crypto = require('crypto');
const kakao = require('kakao');
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const state = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 24);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!secret || req.query.state !== state || !req.query.code) return res.status(400).send('잘못된 요청');
  const t = await kakao.tokenRequest({ grant_type: 'authorization_code', redirect_uri: kakao.origin() + '/api/auth/callback', code: req.query.code });
  if (!t.access_token) return res.status(400).send('토큰 발급 실패: ' + (t.error_description || t.error));
  await kakao.saveTokens(t);
  res.send('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px"><h3>카카오 연결 완료</h3>이 창을 닫아도 됩니다.</body>');
};

};

module.exports = async (req, res) => {
  const r = String(req.query.r || '');
  if (!['cron', 'news', 'start', 'callback'].includes(r)) return res.status(404).send('not found');
  return __req(r)(req, res);
};
module.exports.config = { maxDuration: 60 };
