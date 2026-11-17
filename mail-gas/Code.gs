/*
  予約のお知らせメール（Google Apps Script 版）

  お店の Gmail からそのまま送ります。ドメインも費用も要りません。
  アプリ（index.html）の sendMail から呼ばれ、次のメールを送ります。

    予約したとき   … お客様に「ご予約を承りました」／お店に「新しいご予約」
    取り消したとき … お客様に「ご予約の取消」／お店に「ご予約の取消」
    日時を変えたとき … お客様に「日時を変更しました」／お店に「ご予約の日時変更」

  安全のための決まり
    ・アプリから届いた依頼は、Firebase のログイン（ID トークン）を確かめてから受け付けます
    ・送るのは本人の予約か、トレーナーからの依頼だけです
    ・宛先は Firestore に記録されたアドレスだけ。依頼する側は指定できません
    ・文面はこのファイルで決めたものだけです

  設定は下の「お店の設定」を書き換えてください。公開のしかたは README.md にあります。
*/

/* ===== お店の設定 ===== */
var SHOP_NAME = 'きん肉こまつ';
var SHOP_URL = 'https://ここに-公開url';
/* 差出人にするアドレス。
   このスクリプトを動かす Google アカウントの
   「予備のメールアドレス（エイリアス）」として登録してあるもの。
   空にすると、動かしているアカウントのアドレスがそのまま差出人になります */
var SEND_AS = '';
/* お店で通知を受け取るアドレス。空ならお店には送りません */
var SHOP_EMAIL = '';
/* お客様にも送るか。false ならお店への通知だけ */
var MEMBER_MAIL = true;
/* 取消・変更の締め切り（config.js の cancelHours と同じに） */
var CANCEL_HOURS = 24;
/* Firebase の公開設定（config.js と同じ値。どちらも公開されている値です） */
var FIREBASE_PROJECT_ID = 'ここに-firebase-のプロジェクトid';
var FIREBASE_API_KEY = 'ここに-config.js-と同じ-apiKey';

var DOW = ['日', '月', '火', '水', '木', '金', '土'];

/* ===== アプリからの依頼を受ける ===== */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var p = clean(body);
    var caller = verifyToken(body.idToken);
    var info = handle(p, caller, body.idToken);
    return reply({ ok: true, info: info });
  } catch (err) {
    return reply({ error: String((err && err.message) || err) });
  }
}
function doGet() {
  return reply({ ok: true, note: 'mail endpoint' });
}
function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* 受け取った値を、決まった形だけに整える（余計な文字は捨てる） */
function clean(b) {
  var type = String(b.type || '');
  if (['booked', 'cancelled', 'moved'].indexOf(type) < 0) throw new Error('bad type');
  var date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
  var hour = Number(b.hour);
  if (!(hour >= 0 && hour < 24)) throw new Error('bad hour');
  var out = {
    type: type, date: date, hour: hour,
    userId: String(b.userId || '').slice(0, 128),
    trainer: String(b.trainer || '').slice(0, 40),
    store: String(b.store || '').slice(0, 40),
    trial: !!b.trial, refund: !!b.refund,
    fromDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.fromDate || '')) ? String(b.fromDate) : '',
    fromHour: Number(b.fromHour),
  };
  if (!out.userId) throw new Error('bad user');
  return out;
}

/* ログインの確認。ID トークンが本物かを Firebase に問い合わせる */
function verifyToken(idToken) {
  if (!idToken) throw new Error('no token');
  var res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true,
    });
  if (res.getResponseCode() !== 200) throw new Error('bad token');
  var u = (JSON.parse(res.getContentText()).users || [])[0];
  if (!u || !u.localId) throw new Error('bad token');
  return { uid: u.localId, email: u.email || '' };
}

/* Firestore を読む（ログインした人の権限で読むので、ルールがそのまま効きます） */
function fsGet(path, idToken) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/' + path;
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + idToken }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  var f = (JSON.parse(res.getContentText()) || {}).fields || {};
  var out = {};
  Object.keys(f).forEach(function (k) {
    var v = f[k];
    out[k] = v.stringValue !== undefined ? v.stringValue
      : v.integerValue !== undefined ? Number(v.integerValue)
        : v.booleanValue !== undefined ? v.booleanValue
          : v.doubleValue !== undefined ? Number(v.doubleValue) : '';
  });
  return out;
}

/* ===== 送る相手を決めて送る ===== */
function handle(p, caller, idToken) {
  var self = p.userId === caller.uid;
  if (!self) {
    /* 本人以外（代理予約・お店側の取消など）はトレーナーだけ */
    var me = fsGet('profiles/' + caller.uid, idToken);
    if (!me || me.role !== 'admin') throw new Error('forbidden');
  }
  var prof = fsGet('profiles/' + p.userId, idToken) || {};
  var to = self ? caller.email : '';
  if (!to) {
    var sheet = fsGet('intake_sheets/' + p.userId, idToken);
    to = (sheet && sheet.email) || prof.email || '';
  }
  var name = prof.name || 'お客様';
  var by = self ? 'self' : 'shop';

  /* うまくいったかどうかを返す（不具合を調べるため。アドレスは伏せ字にする） */
  var info = { member: '-', shop: '-', quota: MailApp.getRemainingDailyQuota() };
  var failed = '';
  if (to && MEMBER_MAIL) {
    try { send(to, mailFor(p, name, by)); info.member = '送信 ' + mask(to); }
    catch (err) { failed = String((err && err.message) || err); info.member = '失敗 ' + failed; }
  } else {
    info.member = to ? '送らない設定' : 'アドレスが見つからない';
  }
  /* お客様ご本人が操作したときは、お店にも知らせる（お客様宛が送れなくても、ここは送る） */
  if (self && SHOP_EMAIL) {
    try { send(SHOP_EMAIL, shopMailFor(p, name)); info.shop = '送信 ' + mask(SHOP_EMAIL); }
    catch (err) { info.shop = '失敗 ' + String((err && err.message) || err); }
  } else {
    info.shop = 'お店には送らない場面';
  }
  if (failed) throw new Error(failed);
  return info;
}
/* アドレスを伏せ字にする（ab***@example.com） */
function mask(a) {
  return String(a).replace(/^(.{2})[^@]*(@.*)$/, '$1***$2');
}

/* ===== 文面 ===== */
function when(date, hour) {
  var a = date.split('-');
  var d = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
  /* 10.5 は 10:30 の意味（30分刻みの枠） */
  var H = Math.floor(hour), M = Math.round((hour - H) * 60);
  return Number(a[1]) + '月' + Number(a[2]) + '日(' + DOW[d.getDay()] + ') '
    + H + ':' + (M < 10 ? '0' + M : M) + '〜';
}
function mailFor(p, name, by) {
  var rule = CANCEL_HOURS
    ? 'ご予約の取消・変更は、開始の' + CANCEL_HOURS + '時間前までにお願いいたします。'
    : 'ご予約の取消・変更は、前日までにお願いいたします。';
  var trainer = p.trainer || '当日のスタッフがお受けします';
  var lines = [], subject = '';
  if (p.type === 'booked') {
    subject = '【' + SHOP_NAME + '】ご予約を承りました';
    lines = [name + ' 様', '',
      by === 'shop' ? 'お店でご予約をお取りしました。' : 'ご予約ありがとうございます。',
      '以下の内容で承りました。', '',
      '日時：' + when(p.date, p.hour)];
    if (p.store) lines.push('店舗：' + p.store);
    lines.push('担当：' + trainer);
    if (p.trial) lines.push('内容：初回体験レッスン');
    lines.push('', rule, '当日は動きやすい服装でお越しください。');
  } else if (p.type === 'cancelled') {
    subject = '【' + SHOP_NAME + '】' + (by === 'shop' ? 'ご予約を取り消しました' : 'ご予約の取消を承りました');
    var refund = p.trial
      ? (p.refund ? '初回体験は、もう一度お使いいただけます。' : '締め切りを過ぎているため、初回体験は使用済みとなります。')
      : (p.refund ? 'お使いのチケットは返却しました。' : '締め切りを過ぎているため、チケットは返却されません。');
    lines = [name + ' 様', '',
      by === 'shop' ? 'お店の都合により、以下のご予約を取り消しました。' : '以下のご予約の取消を承りました。', '',
      '日時：' + when(p.date, p.hour)];
    if (p.store) lines.push('店舗：' + p.store);
    lines.push('', refund);
  } else if (p.type === 'moved') {
    subject = '【' + SHOP_NAME + '】ご予約の日時を変更しました';
    lines = [name + ' 様', '',
      by === 'shop' ? 'お店でご予約の日時を変更しました。' : 'ご予約の日時の変更を承りました。', ''];
    if (p.fromDate) lines.push('変更前：' + when(p.fromDate, p.fromHour));
    lines.push('変更後：' + when(p.date, p.hour));
    if (p.store) lines.push('店舗：' + p.store);
    lines.push('担当：' + trainer, '', rule);
  }
  lines.push('');
  if (SHOP_URL) lines.push('ご予約の確認はこちら', SHOP_URL, '');
  lines.push('―――', SHOP_NAME, '※ このメールは送信専用です。');
  return { subject: subject, text: lines.join('\n') };
}
function shopMailFor(p, name) {
  var label = { booked: '新しいご予約', cancelled: 'ご予約の取消', moved: 'ご予約の日時変更' }[p.type];
  var lines = [label + 'がありました。', '', 'お名前：' + name + ' 様', '日時：' + when(p.date, p.hour)];
  if (p.store) lines.push('店舗：' + p.store);
  if (p.type === 'moved' && p.fromDate) lines.push('変更前：' + when(p.fromDate, p.fromHour));
  if (p.type !== 'cancelled') {
    lines.push('担当：' + (p.trainer || '未定（決めてください）') + (p.trial ? '　※初回体験' : ''));
  }
  lines.push('');
  if (SHOP_URL) lines.push(SHOP_URL);
  return { subject: '【' + SHOP_NAME + '】' + label + '：' + name + ' 様', text: lines.join('\n') };
}

/* ===== Gmail で送る =====
   差出人を SEND_AS（エイリアス）にするため GmailApp を使う。
   MailApp では差出人を選べないため */
function send(to, mail) {
  var opt = {
    name: SHOP_NAME,          /* 差出人の表示名 */
    htmlBody: '<div style="font-family:sans-serif;font-size:15px;line-height:1.8;color:#333">' +
      esc(mail.text).replace(/\n/g, '<br>') + '</div>',
  };
  if (SEND_AS) opt.from = SEND_AS;
  GmailApp.sendEmail(to, mail.subject, mail.text, opt);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ===== 動作確認用 =====
   スクリプトエディタで testMail を実行すると、お店のアドレスに見本が届きます */
function testMail() {
  send(SHOP_EMAIL, shopMailFor(
    { type: 'booked', date: '2026-09-25', hour: 10, trainer: '', trial: false }, '山本 蓮'));
  send(SHOP_EMAIL, mailFor(
    { type: 'booked', date: '2026-09-25', hour: 10, trainer: '', trial: false }, '山本 蓮', 'self'));
}
