/* =============================================================
   予約のお知らせメールを送る Cloudflare Worker（Resend を使う）

   アプリ（index.html）から次の形で呼ばれる。
     POST /  Authorization: Bearer <Firebase の ID トークン>
     { type, userId, date, hour, trainer, trial, refund, by, fromDate, fromHour }

   ・ID トークンを確かめ、ログイン中の本人か、トレーナーからの依頼だけを受け付ける
   ・宛先は Firestore から読む（本人のメール、またはヒアリングシートに入れたメール）
   ・文面はここで決めたものだけ。アプリから本文は受け取らない
   ・毎日決まった時刻に「明日のご予約」のお知らせを送る（GOOGLE_SA を設定したときだけ）

   設定（wrangler.toml の [vars] とシークレット）
     RESEND_API_KEY      … Resend の API キー（シークレット）
     MAIL_FROM           … 送信元。Resend で認証したドメインのアドレス
     FIREBASE_PROJECT_ID … Firebase のプロジェクト ID
     SHOP_NAME / SHOP_URL / SHOP_EMAIL（お店への通知先。空なら送らない）
     ALLOWED_ORIGIN      … アプリの URL（ほかのサイトからは呼べない）
     CANCEL_HOURS        … 取消・変更の締め切り（開始の何時間前まで）
     GOOGLE_SA           … 前日のお知らせ用のサービスアカウント JSON（シークレット、任意）
   ============================================================= */

const TYPES = ['booked', 'cancelled', 'moved'];
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json({ error: 'method' }, 405, cors);
    try {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const caller = await verifyIdToken(token, env.FIREBASE_PROJECT_ID);
      const body = await req.json();
      const p = clean(body);
      await handle(p, caller, token, env);
      return json({ ok: true }, 200, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 400, cors);
    }
  },

  /* 前日のお知らせ（wrangler.toml の crons で毎日動く） */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
};

/* ---------- 受け付けた依頼を処理する ---------- */
async function handle(p, caller, token, env) {
  const self = p.userId === caller.sub;
  if (!self) {
    /* 本人以外（代理予約・お店側の取消など）はトレーナーだけ */
    const me = await fsGet(env, `profiles/${caller.sub}`, token);
    if (!me || me.role !== 'admin') throw withStatus('forbidden', 403);
  }
  const prof = (await fsGet(env, `profiles/${p.userId}`, token)) || {};
  let to = self ? caller.email : '';
  if (!to) {
    const sheet = await fsGet(env, `intake_sheets/${p.userId}`, token);
    to = (sheet && sheet.email) || prof.email || '';
  }
  const name = prof.name || 'お客様';
  const by = self ? 'self' : 'shop';

  /* お客様へのメール。MEMBER_MAIL が "off" のあいだは送らない（ドメイン認証前） */
  let failed = '';
  if (to && memberMailOn(env)) {
    try { await sendMail(env, to, mailFor(p, name, by, env)); }
    catch (e) { failed = String(e.message || e); }
  }
  /* お客様ご本人が操作したときは、お店にも知らせる（お客様宛が送れなくても、ここは送る） */
  if (self && env.SHOP_EMAIL) await sendMail(env, env.SHOP_EMAIL, shopMailFor(p, name, env));
  if (failed) throw new Error(failed);
}

/* お客様へのメールを送る設定か */
function memberMailOn(env) {
  return String(env.MEMBER_MAIL || 'on').toLowerCase() !== 'off';
}

/* ---------- 文面 ---------- */
function when(date, hour) {
  const [y, m, d] = date.split('-').map(Number);
  const w = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日(${w}) ${hour}:00〜`;
}
function mailFor(p, name, by, env) {
  const shop = env.SHOP_NAME || '';
  const hrs = Number(env.CANCEL_HOURS) || 0;
  const rule = hrs ? `ご予約の取消・変更は、開始の${hrs}時間前までにお願いいたします。` : 'ご予約の取消・変更は、前日までにお願いいたします。';
  const trainer = p.trainer || '当日のスタッフがお受けします';
  const lines = [];
  let subject = '';
  if (p.type === 'booked') {
    subject = `【${shop}】ご予約を承りました`;
    lines.push(`${name} 様`, '', by === 'shop' ? 'お店でご予約をお取りしました。' : 'ご予約ありがとうございます。', '以下の内容で承りました。', '',
      `日時：${when(p.date, p.hour)}`, `担当：${trainer}`, ...(p.trial ? ['内容：初回体験レッスン'] : []), '',
      rule, '当日は動きやすい服装でお越しください。');
  } else if (p.type === 'cancelled') {
    subject = by === 'shop' ? `【${shop}】ご予約を取り消しました` : `【${shop}】ご予約の取消を承りました`;
    const refund = p.trial
      ? (p.refund ? '初回体験は、もう一度お使いいただけます。' : '締め切りを過ぎているため、初回体験は使用済みとなります。')
      : (p.refund ? 'お使いのチケットは返却しました。' : '締め切りを過ぎているため、チケットは返却されません。');
    lines.push(`${name} 様`, '', by === 'shop' ? 'お店の都合により、以下のご予約を取り消しました。' : '以下のご予約の取消を承りました。', '',
      `日時：${when(p.date, p.hour)}`, '', refund);
  } else if (p.type === 'moved') {
    subject = `【${shop}】ご予約の日時を変更しました`;
    lines.push(`${name} 様`, '', by === 'shop' ? 'お店でご予約の日時を変更しました。' : 'ご予約の日時の変更を承りました。', '',
      ...(p.fromDate ? [`変更前：${when(p.fromDate, p.fromHour)}`] : []), `変更後：${when(p.date, p.hour)}`, `担当：${trainer}`, '', rule);
  } else if (p.type === 'reminder') {
    subject = `【${shop}】明日のご予約のお知らせ`;
    lines.push(`${name} 様`, '', '明日のご予約のお知らせです。', '', `日時：${when(p.date, p.hour)}`, `担当：${trainer}`, '',
      'お気をつけてお越しください。');
  }
  lines.push('', ...(env.SHOP_URL ? ['ご予約の確認はこちら', env.SHOP_URL, ''] : []), '―――', shop, '※ このメールは送信専用です。');
  return { subject, text: lines.join('\n') };
}
function shopMailFor(p, name, env) {
  const label = { booked: '新しいご予約', cancelled: 'ご予約の取消', moved: 'ご予約の日時変更' }[p.type];
  const lines = [`${label}がありました。`, '', `お名前：${name} 様`, `日時：${when(p.date, p.hour)}`,
    ...(p.type === 'moved' && p.fromDate ? [`変更前：${when(p.fromDate, p.fromHour)}`] : []),
    ...(p.type !== 'cancelled' ? [`担当：${p.trainer || '未定（決めてください）'}${p.trial ? '　※初回体験' : ''}`] : []),
    '', ...(env.SHOP_URL ? [env.SHOP_URL] : [])];
  return { subject: `【${env.SHOP_NAME || ''}】${label}：${name} 様`, text: lines.join('\n') };
}

/* ---------- Resend で送る ---------- */
async function sendMail(env, to, { subject, text }) {
  const html = `<div style="font-family:sans-serif;font-size:15px;line-height:1.8;color:#333">${esc(text).replace(/\n/g, '<br>')}</div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }),
  });
  if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

/* ---------- 前日のお知らせ ---------- */
async function sendReminders(env) {
  if (!env.GOOGLE_SA || !memberMailOn(env)) return;
  const sa = JSON.parse(env.GOOGLE_SA);
  const token = await serviceToken(sa);
  /* 日本時間の「明日」 */
  const jst = new Date(Date.now() + 9 * 3600e3);
  jst.setUTCDate(jst.getUTCDate() + 1);
  const tomorrow = jst.toISOString().slice(0, 10);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'reservations' }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: tomorrow } } },
    } }),
  });
  const rows = (await res.json()).filter(x => x.document).map(x => fromFields(x.document.fields));
  const trainers = {};
  for (const r of rows) {
    const prof = (await fsGet(env, `profiles/${r.user_id}`, token)) || {};
    const sheet = (await fsGet(env, `intake_sheets/${r.user_id}`, token)) || {};
    const to = sheet.email || prof.email;
    if (!to) continue;
    let trainer = '';
    if (r.trainer_id) {
      if (!(r.trainer_id in trainers)) trainers[r.trainer_id] = ((await fsGet(env, `profiles/${r.trainer_id}`, token)) || {}).name || '';
      trainer = trainers[r.trainer_id];
    }
    try {
      await sendMail(env, to, mailFor({ type: 'reminder', date: r.date, hour: Number(r.hour), trainer, trial: !!r.trial }, prof.name || 'お客様', 'shop', env));
    } catch (e) { console.error(e); }
  }
}
/* サービスアカウントで Firestore を読むためのトークン */
async function serviceToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claim = enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${claim}.${b64url(new Uint8Array(sig))}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('service token');
  return j.access_token;
}

/* ---------- Firebase の ID トークンを確かめる ---------- */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = null, jwksAt = 0;
async function verifyIdToken(token, projectId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw withStatus('unauthorized', 401);
  const [h, p, s] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64decode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64decode(p)));
  if (!jwks || Date.now() - jwksAt > 3600e3) { jwks = (await (await fetch(JWKS_URL)).json()).keys; jwksAt = Date.now(); }
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) throw withStatus('unauthorized', 401);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64decode(s), new TextEncoder().encode(`${h}.${p}`));
  const now = Math.floor(Date.now() / 1000);
  if (!ok || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`
      || payload.exp < now || !payload.sub) throw withStatus('unauthorized', 401);
  return payload;
}

/* ---------- Firestore を読む（呼んだ人の権限で。ルールがそのまま効く） ---------- */
async function fsGet(env, path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return fromFields(d.fields || {});
}
function fromFields(f) {
  const o = {};
  for (const [k, v] of Object.entries(f || {})) {
    o[k] = 'stringValue' in v ? v.stringValue
      : 'integerValue' in v ? Number(v.integerValue)
      : 'doubleValue' in v ? v.doubleValue
      : 'booleanValue' in v ? v.booleanValue
      : 'nullValue' in v ? null : undefined;
  }
  return o;
}

/* ---------- 入力を確かめる ---------- */
function clean(b) {
  const type = String(b.type || '');
  if (!TYPES.includes(type)) throw new Error('type');
  const date = String(b.date || '');
  const hour = Number(b.hour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('date');
  const userId = String(b.userId || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(userId)) throw new Error('user');
  const out = { type, date, hour, userId,
    trainer: String(b.trainer || '').replace(/[<>\r\n]/g, '').slice(0, 40),
    trial: !!b.trial, refund: !!b.refund };
  if (type === 'moved' && b.fromDate) {
    const fd = String(b.fromDate), fh = Number(b.fromHour);
    if (/^\d{4}-\d{2}-\d{2}$/.test(fd) && Number.isInteger(fh) && fh >= 0 && fh <= 23) { out.fromDate = fd; out.fromHour = fh; }
  }
  return out;
}

/* ---------- 小物 ---------- */
function json(o, status, headers) {
  return new Response(JSON.stringify(o), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
function withStatus(msg, status) { const e = new Error(msg); e.status = status; return e; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function b64decode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function b64url(bytes) {
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
