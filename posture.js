/* =============================================================
   姿勢分析（トレーナーの「姿勢分析」タブ）
   -------------------------------------------------------------
   index.html が、タブを初めて開いたときにこのファイルを読み込みます。
   撮影 → 骨格検出（MediaPipe Pose Landmarker）→ 計測 → AIコメント（Gemini）
   → PDF・記録の保存までを、アプリの 1 列のカード画面の中で行います。

   ・色と書体は config.js の SHOP.theme（アプリと同じ変数）を使う。
     写真に重ねる骨格線と基準線だけは、どんな写真の上でも見えるよう専用の色
   ・Gemini の APIキーは Firestore の settings/ai、モデルは config.js の SHOP.gemini から
     index.html が読んで渡す（画面からは変えられない）。
     本番ではサーバー側から呼ぶ形に移すこと
   ・会員の写真と計測値はこの端末の中だけで扱う。AIには会員名を送らない
   ============================================================= */
(function(){
'use strict';

/* ============================================================
   設定
   ============================================================ */
const MP_VERSION = "1.0.1";
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const DEFAULT_MODEL = "gemini-3.6-flash";
const MAX_PHOTO = 1600;
const MAX_AI_PHOTO = 1024;

// 判定の基準値 [良好の上限, やや注意の上限]。インストラクターと相談して調整してください。
const TH = {
  headTilt:[2,4], shoulderLevel:[2,4], trunkShift:[2,4], pelvisLevel:[2,4], kneeFront:[5,10],
  headForward:[8,15], shoulderForward:[4,8], pelvisShift:[2,4], kneeSide:[4,8], bodyLean:[3,6],
};
const VIEWS = ["front","side"];
const VIEW_LABEL = { front:"正面", side:"側面" };
const STATUS_LABEL = { good:"良好", watch:"やや注意", alert:"注意" };
const LM_NAME = { 7:"左耳",8:"右耳",11:"左肩",12:"右肩",23:"左腰",24:"右腰",25:"左膝",26:"右膝",27:"左足首",28:"右足首" };
// 写真に重ねる線の色。どんな写真の上でも見えるよう、アプリのテーマ色とは別にしている
const COLORS = { bone:"#7FE3C9", plumb:"#FFB547", halo:"rgba(10,16,15,.55)", white:"#FFFFFF" };
const BODY_CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];

/* ============================================================
   デモ用データ（架空の会員）
   ============================================================ */
const SAMPLE = {
  member: "サンプル 花子",
  size: { w:1000, h:1500 },
  // [x, y, visibility]（0〜1に正規化した座標）
  front: [[.502,.147,.99],[.512,.136,.99],[.519,.1355,.99],[.526,.136,.99],[.490,.137,.99],[.483,.1375,.99],[.476,.138,.99],[.536,.142,.95],[.467,.1445,.95],[.513,.167,.99],[.491,.168,.99],[.615,.25,.99],[.389,.2585,.99],[.648,.39,.97],[.356,.40,.97],[.660,.515,.95],[.346,.525,.95],[.668,.54,.9],[.338,.55,.9],[.662,.548,.9],[.343,.558,.9],[.652,.535,.9],[.354,.545,.9],[.563,.50,.99],[.437,.5025,.99],[.557,.70,.98],[.447,.70,.98],[.552,.885,.97],[.453,.885,.97],[.548,.902,.93],[.457,.902,.93],[.575,.925,.93],[.431,.925,.93]],
  side: [[.588,.152,.99],[.576,.14,.9],[.572,.139,.95],[.566,.139,.9],[.578,.14,.3],[.575,.139,.3],[.57,.139,.3],[.528,.146,.96],[.533,.146,.2],[.575,.17,.95],[.58,.17,.3],[.492,.255,.98],[.498,.253,.25],[.500,.395,.95],[.505,.393,.2],[.522,.515,.93],[.527,.513,.2],[.530,.54,.9],[.535,.54,.2],[.535,.545,.9],[.54,.545,.2],[.528,.535,.9],[.533,.535,.2],[.506,.505,.98],[.51,.505,.25],[.511,.705,.96],[.52,.705,.25],[.497,.885,.95],[.50,.885,.25],[.472,.902,.92],[.475,.902,.25],[.566,.922,.92],[.569,.922,.25]],
  // 前回（約1か月前）の値 = 今回の値 + この差分
  prevDelta: { headTilt:1.4, shoulderLevel:1.9, trunkShift:0.6, pelvisLevel:0.9, kneeFrontR:0.2, kneeFrontL:0,
               headForward:4.3, shoulderForward:1.2, pelvisShift:1.0, kneeSide:0.4, bodyLean:1.1 },
  ai: {
    sample: true,
    summary: "1か月前と比べて、頭の位置と肩の左右差がはっきり良くなっています。右肩が少し下がりやすいクセと、頭が前に出るクセはまだ残っているので、首の後ろを長く保つ意識と、左右を均等に使う練習を続けていきましょう。",
    findings: [
      { area:"頭の位置", observation:"耳が肩より少し前に出ています。前回よりかなり戻ってきましたが、首の後ろが縮みやすい状態がまだ残っています。", priority:"high" },
      { area:"肩の高さ", observation:"右肩が左肩より少し低くなっています。前回より左右の差は小さくなりました。", priority:"medium" },
      { area:"頭の傾き", observation:"頭がわずかに右へ傾いています。右肩の下がりとセットで起きやすいポイントです。", priority:"medium" },
      { area:"骨盤と膝", observation:"骨盤の高さや膝の向きは左右のバランスが良く、立ち姿勢の土台は安定しています。", priority:"low" },
    ],
    exercises: [
      { name:"ノッド（頭のうなずき）", target:"首の前側の深い筋肉を使い、頭を背骨の真上に戻す感覚をつかむ", cue:"後頭部を床に長く滑らせるように、あごを小さくうなずきましょう" },
      { name:"スワン プレップ", target:"背中の上部を使い、肩と頭が前に落ちにくい姿勢を作る", cue:"胸の前を遠くへ伸ばして、首は背骨の延長のままで" },
      { name:"マーメイド", target:"体の側面の左右差を整え、右の脇腹を伸ばす", cue:"右の脇腹を天井へ引き上げるように伸びていきます" },
      { name:"ロウイング（リフォーマー）", target:"肩甲骨を下げたまま、左右均等に引く感覚を育てる", cue:"鏡で両肩の高さを揃えたまま引きましょう" },
    ],
    instructor_notes: "頭の位置は前回の16.7°から12.4°に改善しています。右肩の下がりと頭の右への傾きは同じ方向なので、カバンを持つ手など日常のクセも聞いてみてください。痛みやしびれの訴えがある場合は、医療機関への相談をすすめてください。次回も同じ立ち位置とカメラの高さで撮ると、比較の精度が上がります。",
  },
};

/* ============================================================
   状態（タブを離れても残す。カメラだけは止める）
   ============================================================ */
const state = {
  view:"front", facing:"environment", stream:null,
  views:{ front:emptyView(), side:emptyView() },
  // configAi は index.html が渡す Gemini の設定（apiKey は settings/ai、model は config.js）
  previous:null, ai:null, configAi:{},
  aiBusy:false, pdfBusy:false, demo:false, demoRunning:false,
  engine:{ s:"idle", text:"骨格検出は未準備" },
  members:[], memberId:"", date:"", mounted:false, theme:{}, pdfMemo:false,
  // 記録の保存先（index.html が渡す）。tempName は会員と紐付けないときの仮の名前
  store:null, tempName:"",
  records:[], recordsKey:null, recordsBusy:false, recordsError:false,
  // prevId: 比較相手の記録ID、prevAuto: 自動で選んだか、prevOff: トレーナーが「比較をやめる」を押したか
  prevId:null, prevAuto:false, prevOff:false, lastSavedId:null, saveBusy:false,
};
function emptyView(){ return { src:null, result:null, error:null }; }
const $ = (id) => document.getElementById("pc-" + id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const localDate = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const thKey = (key) => key.startsWith("kneeFront") ? "kneeFront" : key;
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/* ============================================================
   骨格検出エンジン（MediaPipe Pose Landmarker）
   初めてタブを開いたときにだけ読み込む
   ============================================================ */
let landmarker = null;
let engineReady = null;
function ensureEngine(){
  if (engineReady) return engineReady;
  setEngine("loading", "骨格検出を準備中");
  engineReady = (async () => {
    try {
      const { FilesetResolver, PoseLandmarker } = await import(MP_BUNDLE);
      const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
      const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions:{ modelAssetPath:MP_MODEL, delegate }, runningMode:"IMAGE", numPoses:1,
      });
      try { landmarker = await make("GPU"); }
      catch (e) { console.warn("GPUで起動できないためCPUで起動します", e); landmarker = await make("CPU"); }
      setEngine("ready", "骨格検出の準備完了");
      return true;
    } catch (err) {
      console.error(err);
      setEngine("error", "骨格検出を読み込めません");
      say("骨格検出モデルを読み込めませんでした。ネット接続を確認して、タブを開き直してください。", "error");
      engineReady = null; // 次に開いたときにもう一度試す
      return false;
    }
  })();
  return engineReady;
}
function setEngine(s, text){
  state.engine = { s, text };
  const el = $("engine");
  if (el) { el.dataset.s = s; el.textContent = text; }
}

/* ============================================================
   計測ロジック
   ============================================================ */
const deg = (r) => r * 180 / Math.PI;
const mid = (a, b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2, v:Math.min(a.v,b.v) });
const dist = (a, b) => Math.hypot(a.x-b.x, a.y-b.y);
const round1 = (n) => Math.round(n * 10) / 10;
function angleAt(a, b, c){
  const v1 = { x:a.x-b.x, y:a.y-b.y }, v2 = { x:c.x-b.x, y:c.y-b.y };
  const cos = (v1.x*v2.x + v1.y*v2.y) / (Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y));
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}
function grade(abs, [g, w]){ return abs < g ? "good" : abs < w ? "watch" : "alert"; }
function metric(key, label, signed, unit, dir){
  const value = round1(Math.abs(signed));
  return { key, label, value, signed:round1(signed), unit, dir: value < 0.5 ? dir.neutral : dir.text, status: grade(value, TH[key]) };
}
// 点Pの、線分A→B上（同じ高さ）の点からの横ズレ
function offsetFromLine(p, a, b){
  const t = (p.y - a.y) / ((b.y - a.y) || 1);
  return p.x - (a.x + t * (b.x - a.x));
}
function visibilityWarnings(P, idx){
  const weak = idx.filter(i => P[i].v < 0.5).map(i => LM_NAME[i]);
  return weak.length ? [`${weak.join("、")}の検出が不安定です。関係する項目は参考程度に見てください。`] : [];
}
function frameWarnings(norm){
  const w = [];
  if (Math.max(norm[27].y, norm[28].y) > 0.985) w.push("足元がフレームから切れている可能性があります。足先まで写して撮り直すと精度が上がります。");
  if (Math.min(norm[7].y, norm[8].y, norm[0].y) < 0.02) w.push("頭がフレームの端に近すぎます。上に余白を取って撮ると精度が上がります。");
  return w;
}

function measureFront(P, norm){
  const earL=P[7], earR=P[8], shL=P[11], shR=P[12], hipL=P[23], hipR=P[24];
  const ms = mid(shL, shR), mh = mid(hipL, hipR), ma = mid(P[27], P[28]);
  const torso = dist(ms, mh) || 1;
  const warnings = [...frameWarnings(norm), ...visibilityWarnings(P, [7,8,11,12,23,24,25,26,27,28])];

  if (dist(shL, shR) / torso < 0.55) warnings.push("体が斜めを向いている可能性があります。カメラに正対して撮ると左右差を正しく測れます。");
  if (shL.x < shR.x) warnings.push("後ろ向き、または左右反転した画像の可能性があります。左右の表記が逆になることがあります。");

  // 左右の高さ差：正の値＝右側が低い
  const level = (r, l) => deg(Math.atan2(r.y - l.y, Math.abs(l.x - r.x)));
  const head = level(earR, earL), shoulder = level(shR, shL), pelvis = level(hipR, hipL);
  const toLeft = Math.sign(shL.x - shR.x) || 1; // 画像上で「会員の左」がある向き
  const trunk = deg(Math.atan2(ms.x - mh.x, mh.y - ms.y)) * toLeft; // 正＝上半身が左へ

  const knee = (hip, kn, ank, side) => {
    const bend = 180 - angleAt(hip, kn, ank);
    const off = offsetFromLine(kn, hip, ank);
    const legSide = Math.sign((hip.x + ank.x)/2 - mh.x);
    const outward = Math.sign(off) === legSide;
    return metric("kneeFront", `${side}膝の向き`, bend, "°", {
      text: outward ? "外側に開く（O脚の傾向）" : "内側に入る（X脚の傾向）", neutral:"まっすぐ",
    });
  };

  const metrics = [
    metric("headTilt", "頭の傾き", head, "°", { text: head > 0 ? "右に傾いている" : "左に傾いている", neutral:"ほぼまっすぐ" }),
    metric("shoulderLevel", "肩の高さ", shoulder, "°", { text: shoulder > 0 ? "右肩が低い" : "左肩が低い", neutral:"左右ほぼ水平" }),
    metric("trunkShift", "上半身の左右ズレ", trunk, "°", { text: trunk > 0 ? "骨盤に対して左に寄る" : "骨盤に対して右に寄る", neutral:"ほぼ中央" }),
    metric("pelvisLevel", "骨盤の高さ", pelvis, "°", { text: pelvis > 0 ? "右側が低い" : "左側が低い", neutral:"左右ほぼ水平" }),
    knee(P[24], P[26], P[28], "右"),
    knee(P[23], P[25], P[27], "左"),
  ];
  metrics[4].key = "kneeFrontR"; metrics[5].key = "kneeFrontL";
  metrics[4].status = grade(metrics[4].value, TH.kneeFront);
  metrics[5].status = grade(metrics[5].value, TH.kneeFront);

  return { metrics, warnings, plumbX: ma.x, levels:[[8,7],[12,11],[24,23]] };
}

function measureSide(P, norm){
  const leftIdx = [7,11,23,25,27,29,31], rightIdx = [8,12,24,26,28,30,32];
  const vis = (idx) => idx.reduce((s,i) => s + P[i].v, 0);
  const idx = vis(leftIdx) >= vis(rightIdx) ? leftIdx : rightIdx;
  const [ear, sh, hip, kn, ank, heel, toe] = idx.map(i => P[i]);
  const bodyH = (ank.y - ear.y) || 1;
  const torso = dist(mid(P[11],P[12]), mid(P[23],P[24])) || 1;
  const warnings = [...frameWarnings(norm), ...visibilityWarnings(P, [idx[0], idx[1], idx[2], idx[3], idx[4]])];

  if (dist(P[11], P[12]) / torso > 0.45) warnings.push("真横から撮れていない可能性があります。体の側面をカメラに向けると前後のズレを正しく測れます。");

  // 顔の向き（画像上で前方が +1 か -1 か）
  let dir = Math.sign(P[0].x - ear.x);
  if (Math.abs(P[0].x - ear.x) < torso * 0.05) dir = Math.sign(toe.x - heel.x);
  if (!dir) dir = 1;

  // aがbの真上なら0°、aが前にあるほど正
  const lean = (a, b) => deg(Math.atan2((a.x - b.x) * dir, b.y - a.y));
  const head = lean(ear, sh);
  const shoulder = lean(sh, hip);
  const pelvis = offsetFromLine(hip, sh, ank) * dir / bodyH * 100;
  const kneeBend = 180 - angleAt(hip, kn, ank);
  const kneeSigned = offsetFromLine(kn, hip, ank) * dir >= 0 ? kneeBend : -kneeBend;
  const body = lean(ear, ank);

  const metrics = [
    metric("headForward", "頭の位置", head, "°", { text: head > 0 ? "耳が肩より前に出ている" : "耳が肩より後ろにある", neutral:"耳が肩のほぼ真上" }),
    metric("shoulderForward", "上半身の前後", shoulder, "°", { text: shoulder > 0 ? "肩が骨盤より前（前かがみの傾向）" : "肩が骨盤より後ろ（後ろに倒れる傾向）", neutral:"肩が骨盤のほぼ真上" }),
    metric("pelvisShift", "骨盤の前後位置", pelvis, "%", { text: pelvis > 0 ? "骨盤が前に出ている（スウェイバックの傾向）" : "骨盤が後ろに引けている", neutral:"ほぼ一直線" }),
    metric("kneeSide", "膝の伸び", kneeSigned, "°", { text: kneeSigned > 0 ? "膝が曲がり気味" : "膝が反り気味（反張膝の傾向）", neutral:"ほぼまっすぐ" }),
    metric("bodyLean", "全身の重心", body, "°", { text: body > 0 ? "くるぶしより前寄り" : "くるぶしより後ろ寄り", neutral:"くるぶしのほぼ真上" }),
  ];
  return { metrics, warnings, plumbX: ank.x, chain: idx };
}

/* ============================================================
   撮影・読み込み
   ============================================================ */
function toCanvas(source, w, h, max){
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c;
}
async function startCamera(){
  if (!navigator.mediaDevices?.getUserMedia) {
    say(window.isSecureContext
      ? "このブラウザではカメラを使えません。「写真を選ぶ」から画像を読み込んでください。"
      : "カメラは https か localhost で開いたときだけ使えます。「写真を選ぶ」から画像を読み込むこともできます。", "error");
    return;
  }
  stopCamera();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:state.facing, width:{ ideal:1920 }, height:{ ideal:1080 } }, audio:false,
    });
    // 起動を待っているあいだに別のタブへ移ったときは、すぐ止める
    if (!state.mounted) { stopCamera(); return; }
    const video = $("video");
    video.srcObject = state.stream;
    await video.play();
    say("");
  } catch (err) {
    console.error(err);
    stopCamera();
    say(err.name === "NotAllowedError"
      ? "カメラの使用が許可されていません。ブラウザの設定でカメラを許可するか、「写真を選ぶ」から画像を読み込んでください。"
      : "カメラを起動できませんでした。ほかのアプリがカメラを使っていないか確認してください。", "error");
  }
  render();
}
function stopCamera(){
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null;
  const video = $("video");
  if (video) video.srcObject = null;
}
async function shoot(){
  const video = $("video");
  if (!state.stream || !video || !video.videoWidth) return;
  const view = state.view, sec = Number($("timer").value);
  $("shoot").disabled = true;
  for (let s = sec; s > 0; s--) {
    if (!state.mounted) return;
    $("countdown").innerHTML = `<span>${s}</span>`;
    await sleep(1000);
  }
  if (!state.mounted || !state.stream) return;
  $("countdown").innerHTML = "";
  const photo = toCanvas(video, video.videoWidth, video.videoHeight, MAX_PHOTO); // 保存する写真は反転しない
  $("shoot").disabled = false;
  await setPhoto(view, photo);
}
async function loadFile(file){
  if (!file) return;
  if (!file.type.startsWith("image/")) { say("画像ファイルを選んでください。", "error"); return; }
  try {
    const bmp = await createImageBitmap(file, { imageOrientation:"from-image" });
    const photo = toCanvas(bmp, bmp.width, bmp.height, MAX_PHOTO);
    bmp.close?.();
    await setPhoto(state.view, photo);
  } catch (err) {
    console.error(err);
    say("この画像は読み込めませんでした。JPEGかPNGの写真を選んでください。", "error");
  }
}
async function setPhoto(view, photo){
  stopCamera();
  state.views[view] = { src:photo, result:null, error:null };
  state.ai = null;
  state.lastSavedId = null; autoPrevious();   // 新しい計測なので、直前に保存した記録も比較相手に戻す
  render();
  say("骨格を検出しています…");
  const ok = await ensureEngine();
  if (!ok || !landmarker) { state.views[view].error = "engine"; render(); return; }
  try {
    const res = landmarker.detect(photo);
    const norm = res.landmarks?.[0];
    if (!norm) {
      state.views[view].error = "nopose";
      say(`${VIEW_LABEL[view]}の写真から全身を検出できませんでした。頭から足先まで写るように撮り直してください。`, "error");
      render(); return;
    }
    applyLandmarks(view, photo, norm);
    const other = VIEWS.find(v => !state.views[v].result);
    say(other ? `${VIEW_LABEL[view]}の計測が終わりました。続けて${VIEW_LABEL[other]}を撮ると前後左右がそろいます。` : "正面・側面の計測がそろいました。AIコメントを作成できます。");
  } catch (err) {
    console.error(err);
    state.views[view].error = "detect";
    say("骨格の検出中にエラーが起きました。写真を撮り直してください。", "error");
  }
  render();
}
function applyLandmarks(view, photo, norm){
  const W = photo.width, H = photo.height;
  const P = norm.map(p => ({ x:p.x*W, y:p.y*H, v:p.visibility ?? 1 }));
  const r = view === "front" ? measureFront(P, norm) : measureSide(P, norm);
  state.views[view].result = { ...r, P, norm };
}

/* ============================================================
   写真に骨格と基準線を重ねる
   ============================================================ */
function drawOverlay(view, cv){
  const v = state.views[view];
  if (!v.src) return;
  const ctx = cv.getContext("2d");
  const W = v.src.width, H = v.src.height;
  cv.width = W; cv.height = H;
  ctx.drawImage(v.src, 0, 0);
  if (!v.result) return;
  const { P } = v.result;
  const u = Math.max(2, Math.round(Math.max(W, H) / 420));
  const stroke = (pts, color, width, dash) => {
    ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = COLORS.halo; ctx.lineWidth = width + u * 1.6; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    ctx.setLineDash([]);
  };
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const x = v.result.plumbX;
  stroke([{x, y:0}, {x, y:H}], COLORS.plumb, u, [u*5, u*4]);
  let pointIdx;
  if (view === "front") {
    for (const [s, e] of BODY_CONNECTIONS) {
      const a = P[s], b = P[e];
      if (Math.min(a.v, b.v) < 0.3) continue;
      stroke([a, b], COLORS.bone, u * 1.2);
    }
    for (const [r, l] of v.result.levels) {
      const a = P[r], b = P[l];
      const len = dist(a, b), ext = len * 0.35;
      const ux = (b.x - a.x) / (len || 1), uy = (b.y - a.y) / (len || 1);
      const my = (a.y + b.y) / 2, mx = (a.x + b.x) / 2;
      stroke([{x:mx - len/2 - ext, y:my}, {x:mx + len/2 + ext, y:my}], "rgba(255,255,255,.55)", u * .7, [u*2, u*2]);
      stroke([{x:a.x - ux*ext, y:a.y - uy*ext}, {x:b.x + ux*ext, y:b.y + uy*ext}], COLORS.white, u * 1.1);
    }
    pointIdx = [7,8,11,12,13,14,15,16,23,24,25,26,27,28];
  } else {
    const chain = v.result.chain;
    stroke(chain.slice(0, 5).map(i => P[i]), COLORS.bone, u * 1.6);
    stroke([P[chain[4]], P[chain[5]], P[chain[6]], P[chain[4]]], COLORS.bone, u);
    pointIdx = chain.slice(0, 5);
  }
  for (const i of pointIdx) {
    const p = P[i];
    ctx.globalAlpha = p.v < 0.5 ? 0.45 : 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, u * 2.1, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.white; ctx.fill();
    ctx.lineWidth = u; ctx.strokeStyle = "#1A2321"; ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ============================================================
   画面（アプリの 1 列のカードに合わせる。色はアプリの変数だけを使う）
   ============================================================ */
const CSS = `
.pc [hidden]{display:none!important}
.pc{--pc-good:var(--ok);--pc-alert:var(--danger);--pc-watch:color-mix(in srgb,var(--danger) 50%,var(--ok));
  line-break:strict;overflow-wrap:anywhere;word-break:auto-phrase}
.pc p,.pc li{text-wrap:pretty}
.pc .pc-empty-title,.pc h2{text-wrap:balance}
.pc-meta{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,11em);gap:0 10px}
.pc-meta label.fld{margin-top:0}
.pc-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}
.pc-tools .btn{min-height:40px}
.pc-engine{display:inline-flex;align-items:center;gap:6px;margin-right:auto;font-size:13px;white-space:nowrap}
.pc-engine::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--line)}
.pc-engine[data-s="loading"]::before{background:var(--muted)}
.pc-engine[data-s="ready"]::before{background:var(--ok)}
.pc-engine[data-s="error"]::before{background:var(--danger)}
.pc-demo{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding:8px 8px 8px 12px;border-radius:10px;background:var(--smoke);font-size:13px;font-weight:700}
.pc-views{margin-bottom:12px}
.pc-views button{display:flex;align-items:center;justify-content:center;gap:7px;font-weight:700}
.pc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--line)}
.pc-views button.on .pc-dot{background:color-mix(in srgb,var(--paper) 45%,transparent)}
.pc-dot[data-s="done"]{background:var(--ok)!important}
.pc-dot[data-s="error"]{background:var(--danger)!important}
.pc-stage{position:relative;width:100%;height:min(68vh,calc((100vw - 68px) * 4 / 3));min-height:340px;border-radius:12px;overflow:hidden;background:var(--ink)}
.pc-stage video,.pc-stage canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
.pc-stage video.mirror{transform:scaleX(-1)}
.pc-guide{position:absolute;inset:0;pointer-events:none}
.pc-guide-frame{position:absolute;left:50%;top:8%;height:80%;aspect-ratio:5/12;transform:translateX(-50%);border:2px dashed rgba(255,255,255,.45);border-radius:48px}
.pc-guide-line{position:absolute;left:50%;top:0;bottom:0;border-left:1.5px solid ${COLORS.plumb}}
.pc-guide-hint{position:absolute;left:0;right:0;bottom:14px;margin:0;padding:0 16px;text-align:center;color:#fff;font-size:14px;font-weight:700;line-height:1.6;text-shadow:0 1px 4px rgba(0,0,0,.7)}
.pc-countdown{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;font-family:var(--serif);font-size:min(24vh,180px);line-height:1;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.5)}
.pc-countdown span{animation:pctick 1s ease-out both}
@keyframes pctick{from{transform:scale(1.3);opacity:0}25%{opacity:1}to{transform:scale(1);opacity:.9}}
@media (prefers-reduced-motion:reduce){.pc-countdown span{animation:none}}
.pc-empty{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:24px 16px;color:var(--paper)}
.pc-empty-title{margin:0 0 12px;font-family:var(--serif);font-size:22px;font-weight:700;letter-spacing:.04em;line-height:1.4;color:var(--paper)}
.pc-empty p{margin:0;font-size:14px;line-height:1.85;color:color-mix(in srgb,var(--paper) 78%,transparent)}
.pc-steps{display:flex;gap:8px;margin:0 0 20px;padding:0;list-style:none;font-size:13px;font-weight:700;color:color-mix(in srgb,var(--paper) 55%,transparent)}
.pc-steps li{display:flex;align-items:center;gap:6px;white-space:nowrap}
.pc-steps li+li::before{content:"";width:12px;height:1px;background:currentColor}
.pc-steps b{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;border:1px solid currentColor;font-weight:700}
.pc-steps li[data-s="done"] b{background:var(--ok);border-color:var(--ok);color:#fff}
.pc-steps li[data-s="now"]{color:var(--paper)}
.pc-msg{margin:10px 0 0;font-size:13px;line-height:1.7;color:var(--muted)}
.pc-msg:empty{display:none}
.pc-msg[data-tone="error"]{color:var(--danger);font-weight:700}
.pc-ctrl{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.pc-ctrl-sub{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}
.pc-ctrl-sub .btn{flex:1 1 9em;min-height:44px;font-size:14px}
.pc-ctrl-sub select{flex:1 1 9em;width:auto;min-height:44px;padding:8px 10px;font-size:14px}
.pc-file{position:relative;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.pc-file input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.pc-file:focus-within{outline:2px solid var(--ink);outline-offset:2px}
.pc-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.pc-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px}
.pc-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pc-chip.good{background:color-mix(in srgb,var(--pc-good) 14%,var(--paper));color:var(--pc-good)}
.pc-chip.watch{background:color-mix(in srgb,var(--pc-watch) 14%,var(--paper));color:var(--pc-watch)}
.pc-chip.alert{background:color-mix(in srgb,var(--pc-alert) 14%,var(--paper));color:var(--pc-alert)}
.pc-prev{width:100%;margin:4px 0 0}
.pc-group{margin-top:14px}
.pc-ghead{display:flex;align-items:baseline;gap:10px;padding-bottom:6px;border-bottom:1.5px solid var(--ink)}
.pc-ghead b{font-family:var(--serif);font-size:17px;letter-spacing:.04em}
.pc-ghead span{font-size:12px;color:var(--muted)}
.pc-go{margin-left:auto;background:none;border:0;padding:2px 0;font-size:12px;font-weight:700;color:var(--muted);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.pc-group[data-active="true"] .pc-go{visibility:hidden}
.pc-placeholder{margin:0;padding:12px 0;color:var(--muted);font-size:13px}
.pc-metrics{list-style:none;margin:0;padding:0}
.pc-m{display:grid;grid-template-columns:minmax(0,1fr) auto 7.4em;align-items:center;column-gap:10px;width:100%;padding:10px 2px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;color:var(--ink);text-align:left;cursor:pointer;font-family:inherit;font-weight:400}
.pc-m:active{background:var(--smoke)}
.pc-m-l{min-width:0}
.pc-m-label{display:block;font-weight:700;font-size:14px;line-height:1.35}
.pc-m-dir{display:block;font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:2px}
.pc-m-val{font-family:var(--serif);font-size:22px;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap}
.pc-m-val small{font-size:12px;margin-left:1px}
.pc-m-r{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.pc-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;white-space:nowrap}
.pc-status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.pc-status.good{color:var(--pc-good)}.pc-status.watch{color:var(--pc-watch)}.pc-status.alert{color:var(--pc-alert)}
.pc-delta{font-size:11px;color:var(--muted);line-height:1.35}
.pc-delta.better{color:var(--pc-good)}.pc-delta.worse{color:var(--pc-alert)}
.pc-warnings{margin:8px 0 2px;padding:6px 0 6px 10px;border-left:3px solid ${COLORS.plumb};list-style:none;font-size:13px;color:var(--muted);line-height:1.7}
.pc-warnings li+li{margin-top:3px}
.pc-ai-hint{margin:0 0 12px;font-size:13px;line-height:1.7}
.pc-ai-empty{margin-top:12px;font-size:13px;line-height:1.7}
.pc-sample{margin:14px 0 0;padding:8px 12px;border-radius:8px;background:var(--smoke);font-size:12.5px;font-weight:700}
/* 総評：ひと目で読める大きめの文字で、枠に入れて目立たせる */
.pc-ai-lead{margin:14px 0 0;padding:14px 16px;border-radius:12px;background:var(--smoke)}
.pc-ai-k{font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--muted);margin-bottom:6px}
.pc-ai-lead p{margin:0;font-size:15px;line-height:1.9}
/* 節の見出し：下線つきで、本文より二回り大きく */
.pc-ai-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:24px 0 10px;padding-bottom:6px;border-bottom:1.5px solid var(--ink);font-size:16px;font-weight:900;letter-spacing:.02em;color:var(--ink)}
.pc-ai-h span{font-size:12px;font-weight:700;color:var(--muted);white-space:nowrap}
/* 気になるポイント：左の色線と「優先度」の札で軽重を示す */
.pc-fl{list-style:none;margin:0;padding:0}
.pc-f{margin:0 0 10px;padding:10px 0 10px 12px;border-left:4px solid var(--line)}
.pc-f.high{border-color:var(--pc-alert)}.pc-f.medium{border-color:var(--pc-watch)}.pc-f.low{border-color:var(--pc-good)}
.pc-f-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
.pc-f-head b{font-size:15px;font-weight:900}
.pc-pri{flex-shrink:0;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;color:#fff;background:var(--muted);white-space:nowrap}
.pc-pri.high{background:var(--pc-alert)}.pc-pri.medium{background:var(--pc-watch)}.pc-pri.low{background:var(--pc-good)}
.pc-f p{margin:0;font-size:14px;line-height:1.8}
/* おすすめの種目：番号・種目名・狙い・声かけを段で分ける */
.pc-xl{list-style:none;margin:0;padding:0}
.pc-x{display:grid;grid-template-columns:30px minmax(0,1fr);column-gap:10px;padding:14px 0;border-bottom:1px solid var(--line)}
.pc-x:last-child{border-bottom:none}
.pc-x-n{width:28px;height:28px;border-radius:50%;border:1.5px solid var(--ink);display:grid;place-items:center;font-family:var(--serif);font-size:15px;font-weight:700;margin-top:-1px}
.pc-x b{display:block;font-size:15px;font-weight:900;line-height:1.4}
.pc-x .t{margin:4px 0 0;font-size:14px;line-height:1.75;color:var(--ink)}
.pc-x .cue{margin:8px 0 0;padding:8px 12px;border-radius:8px;background:var(--smoke);font-size:13.5px;line-height:1.75}
.pc-x .cue span{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted);margin-bottom:2px}
/* インストラクター向けメモ */
.pc-ai-notes{margin:24px 0 0;padding:12px 14px;border:1.5px dashed var(--line);border-radius:12px}
.pc-ai-notes b{display:block;margin-bottom:6px;font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--muted)}
.pc-ai-notes p{margin:0;font-size:14px;line-height:1.8}
/* レポートのプレビュー（画面いっぱいに出す） */
.pc-preview{position:fixed;inset:0;z-index:600;display:flex;flex-direction:column;background:var(--paper)}
.pc-preview-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:2px solid var(--ink)}
.pc-preview-head b{font-size:15px;font-weight:900}
.pc-preview-head .x{width:36px;height:36px;border-radius:50%;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);font-size:18px;line-height:1;flex-shrink:0}
.pc-pvMemo{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;font-weight:700;white-space:nowrap}
.pc-pvMemo input{width:18px;height:18px;margin:0;accent-color:var(--ink)}
.pc-preview iframe{flex:1;width:100%;border:0;background:#fff}
.pc-preview-foot{display:flex;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));border-top:1.5px solid var(--line);background:var(--paper)}
.pc-preview-foot .btn{flex:1;min-height:46px}
.pc-preview-note{padding:6px 16px;font-size:12px;line-height:1.5;color:var(--muted);background:var(--smoke);border-bottom:1px solid var(--line)}
.pc-preview-note:empty{display:none}
.pc-actions{display:flex;flex-wrap:wrap;gap:8px}
.pc-actions .btn{flex:1 1 9em}
.pc-note{margin-top:12px;font-size:13px;line-height:1.8}
/* 会員の選択欄（押すと検索の画面が下から出る） */
.pc-pick{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:44px;padding:9px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit;font-size:15px;text-align:left;cursor:pointer}
.pc-pick:disabled{cursor:default;color:var(--muted)}
.pc-pick[data-empty="true"] #pc-pickName{color:var(--muted)}
.pc-pick .pc-pick-arrow{flex:none;font-size:12px;color:var(--muted)}
.pc-pick small{margin-left:6px;font-size:12px;color:var(--muted)}
.pc-sheet{line-break:strict;overflow-wrap:anywhere;word-break:auto-phrase}
.pc-sheet .pc-mq{margin-top:10px}
.pc-mlist{display:flex;flex-direction:column;gap:6px;max-height:min(44vh,360px);overflow-y:auto;margin-top:10px;padding:2px}
.pc-mrow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:8px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit;font-size:15px;text-align:left;cursor:pointer}
.pc-mrow[aria-selected="true"]{border-color:var(--ink);background:var(--smoke);font-weight:700}
.pc-mrow small{font-size:12px;color:var(--muted);white-space:nowrap}
.pc-mnone{padding:14px 4px;font-size:13px;color:var(--muted)}
.pc-mnew{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.pc-mnew .btn{width:100%}
.pc-sheet-foot{display:flex;flex-direction:column;gap:8px;margin-top:18px}
/* 過去の記録の一覧 */
.pc-records{margin-top:14px}
.pc-records:empty{display:none}
.pc-rec-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1.5px solid var(--ink)}
.pc-rec-h b{font-family:var(--serif);font-size:17px;letter-spacing:.04em}
.pc-rec-h span{font-size:12px;color:var(--muted)}
.pc-rec{padding:12px 0;border-bottom:1px solid var(--line)}
.pc-rec-t{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.pc-rec-t b{font-size:15px;color:var(--ink);font-weight:700}
.pc-rec-t .pc-rec-name{font-size:13px;color:var(--ink)}
.pc-rec-a{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pc-rec-a .btn{flex:1 1 auto;min-height:36px;padding:6px 10px;font-size:13px}
.pc-rec-a .btn[aria-pressed="true"]{background:var(--ink);color:var(--paper)}
.pc-rec-empty{padding:12px 0 0;font-size:13px;line-height:1.8;color:var(--muted)}
/* 記録を開いたときの画面（下から出る） */
.pc-rv-photos{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.pc-rv-photos figure{margin:0}
.pc-rv-photos img,.pc-rv-ph,.pc-rv-none{display:block;width:100%;aspect-ratio:3/4;border-radius:10px;background:var(--ink)}
.pc-rv-photos img{object-fit:contain}
.pc-rv-none{display:flex;align-items:center;justify-content:center;color:var(--paper);font-size:12px;opacity:.7}
.pc-rv-photos figcaption{margin-top:4px;font-size:12px;color:var(--muted);text-align:center}
.pc-rv-sum{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--muted)}
.pc-rv{width:100%;margin-top:10px;border-collapse:collapse;font-size:13.5px}
.pc-rv th{padding:10px 0 4px;border-bottom:1.5px solid var(--ink);font-family:var(--serif);font-size:15px;font-weight:700;text-align:left;letter-spacing:.04em}
.pc-rv td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:middle}
.pc-rv td:nth-child(2){text-align:right;white-space:nowrap;font-weight:700}
.pc-rv td:nth-child(2) small{margin-left:1px;font-weight:400;color:var(--muted)}
.pc-rv td:last-child{width:5.5em;text-align:right}
.pc-rv-ai{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--smoke);font-size:13.5px;line-height:1.8}
.pc-rv-ai b{display:block;margin-bottom:2px;font-size:12px;color:var(--muted)}
.pc-rv-ai ul{margin:6px 0 0;padding-left:1.2em}
@media (max-width:480px){
  .pc-meta{grid-template-columns:1fr}
  .pc-tools{flex-direction:column;align-items:stretch}
  .pc-tools .pc-engine{margin:0 0 2px}
  .pc-tools .btn{width:100%}
  .pc-m{grid-template-columns:minmax(0,1fr) auto;row-gap:4px}
  .pc-m-r{grid-column:1 / -1;flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px 10px}
}
`;

function template(){
  return `
<div class="pc">
  <div class="card">
    <h2>姿勢分析</h2>
    <div class="pc-meta">
      <div><span class="fld" id="pc-memberLabel">会員</span>
        <button class="pc-pick" id="pc-pickMember" type="button" aria-labelledby="pc-memberLabel pc-pickName"><span id="pc-pickName"></span><span class="pc-pick-arrow" aria-hidden="true">▾</span></button></div>
      <div><label class="fld" for="pc-date">撮影日</label><input id="pc-date" type="date"></div>
    </div>
    <div class="pc-demo" id="pc-demoChip" hidden><span>デモ表示中（架空の会員）</span><button class="btn sm ghost" id="pc-endDemo" type="button">デモを終了</button></div>
    <div class="pc-tools">
      <span class="pc-engine small" id="pc-engine" role="status"></span>
      <button class="btn sm ghost" id="pc-startDemo" type="button">デモを見る</button>
    </div>
  </div>

  <div class="card">
    <h2>撮影</h2>
    <div class="seg pc-views" role="tablist" aria-label="撮影する向き">
      <button role="tab" type="button" data-view="front"><i class="pc-dot" id="pc-dot-front"></i>正面</button>
      <button role="tab" type="button" data-view="side"><i class="pc-dot" id="pc-dot-side"></i>側面</button>
    </div>
    <div class="pc-stage" aria-label="撮影">
      <video id="pc-video" playsinline muted hidden></video>
      <canvas id="pc-canvas" hidden></canvas>
      <div class="pc-guide" id="pc-guide" hidden>
        <div class="pc-guide-frame"></div><div class="pc-guide-line"></div>
        <p class="pc-guide-hint" id="pc-guideHint"></p>
      </div>
      <div class="pc-countdown" id="pc-countdown" aria-live="assertive"></div>
      <div class="pc-empty" id="pc-empty">
        <ol class="pc-steps" id="pc-steps"><li><b>1</b>正面</li><li><b>2</b>側面</li><li><b>3</b>AIコメント</li></ol>
        <p class="pc-empty-title" id="pc-emptyTitle"></p>
        <p>裸足で、体のラインが出る服装に。<br>頭からつま先まで全身を写します。<br>カメラは腰の高さで水平に。</p>
      </div>
    </div>
    <p class="pc-msg" id="pc-msg" role="status"></p>
    <div class="pc-ctrl" id="pc-controls">
      <button class="btn" id="pc-startCam" type="button">カメラを起動</button>
      <button class="btn" id="pc-shoot" type="button" hidden>撮影する</button>
      <button class="btn" id="pc-next" type="button" hidden>次へ：側面を撮る</button>
      <div class="pc-ctrl-sub">
        <select id="pc-timer" aria-label="セルフタイマー" hidden>
          <option value="0">タイマーなし</option><option value="3" selected>3秒後に撮る</option><option value="10">10秒後に撮る</option>
        </select>
        <button class="btn sm ghost" id="pc-flip" type="button" hidden>カメラ切替</button>
        <label class="btn sm ghost pc-file" id="pc-fileLabel">写真を選ぶ<input id="pc-file" type="file" accept="image/*"></label>
        <button class="btn sm ghost" id="pc-retake" type="button" hidden>撮り直す</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>計測結果</h2>
    <div class="pc-summary" id="pc-summary"></div>
    <div class="pc-group" id="pc-group-front">
      <div class="pc-ghead"><b>正面</b><span>左右のバランス</span><button class="pc-go" type="button" data-go="front">写真を見る</button></div>
      <div id="pc-metrics-front"></div>
    </div>
    <div class="pc-group" id="pc-group-side">
      <div class="pc-ghead"><b>側面</b><span>前後のバランス</span><button class="pc-go" type="button" data-go="side">写真を見る</button></div>
      <div id="pc-metrics-side"></div>
    </div>
  </div>

  <div class="card pc-ai">
    <h2>AIコメント</h2>
    <p class="small pc-ai-hint" id="pc-aiHint"></p>
    <button class="btn" id="pc-runAi" type="button" disabled>作成</button>
    <div id="pc-aiOut" aria-live="polite"></div>
  </div>

  <div class="card">
    <h2>記録</h2>
    <div class="pc-actions">
      <button class="btn" id="pc-pdfBtn" type="button">レポートを見る（印刷・PDF）</button>
      <button class="btn ghost" id="pc-saveBtn" type="button">この記録を保存</button>
    </div>
    <p class="small pc-note">「レポートを見る」で、写真と計測値をまとめた A4 のレポートを画面で確認し、印刷や PDF の保存ができます。<br>「この記録を保存」で、計測値・コメント・縮小した写真を会員の記録として残します。<br>会員を選ぶと過去の記録が下に並び、直近の記録と自動で比べます。<br>計測値は写真から推定した目安で、医療的な診断ではありません。良好／やや注意／注意の基準値は仮の値です。</p>
    <div class="pc-records" id="pc-records"></div>
  </div>
</div>`;
}

function memberOf(id){ return state.members.find(x => x.id === id) || null; }
function memberName(){
  if (state.demo) return SAMPLE.member;
  const m = memberOf(state.memberId);
  return m ? m.name : state.tempName;
}
/* 会員の選択欄。会員名か、紐付けないときの仮の名前を出す */
function renderMember(){
  const b = $("pickMember"), n = $("pickName");
  n.replaceChildren();
  if (state.demo) n.append(document.createTextNode(SAMPLE.member));
  else if (state.memberId) {
    const m = memberOf(state.memberId);
    n.append(document.createTextNode(m ? m.name : "（名前なし）"));
    if (m?.guest) n.append(el("small", "", "ゲスト"));
  } else if (state.tempName) {
    n.append(document.createTextNode(state.tempName), el("small", "", "会員と紐付けなし"));
  } else n.append(document.createTextNode("（会員を選ぶ）"));
  b.dataset.empty = String(!state.demo && !state.memberId && !state.tempName);
  b.disabled = state.demo || state.demoRunning;
}
/* 名前の検索用。ひらがな・カタカナ、空白、大文字小文字の違いをなくす */
const nameKey = (s) => String(s || "").toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s　]/g, "");
function searchMembers(q){
  const key = nameKey(q);
  if (!key) return state.members;
  return state.members.filter(m => nameKey(m.name).includes(key) || (m.kana && nameKey(m.kana).includes(key)));
}
/* 会員を選ぶ画面（アプリの下から出る画面）。
   opts.title: 見出し、opts.current: いま選んでいる会員ID、opts.tempName: いまの仮の名前、
   opts.onPick(id, name): 決めたときに呼ぶ（id が null なら「会員と紐付けない」で name は仮の名前） */
function openMemberPicker(opts = {}){
  const body = document.getElementById("ovBody");
  body.innerHTML = `
    <div class="pc pc-sheet">
      <h3>${esc(opts.title || "会員を選ぶ")}</h3>
      <div class="sub">名前で絞り込めます。新規のお客様は下の「会員と紐付けずに記録する」から</div>
      <input class="pc-mq" id="pc-mq" type="search" placeholder="名前で検索" autocomplete="off" enterkeyhint="search" aria-label="会員を名前で検索">
      <div class="pc-mlist" id="pc-mlist" role="listbox" aria-label="会員の一覧"></div>
      <div class="pc-mnew">
        <button class="btn ghost" id="pc-noLink" type="button" aria-expanded="false">会員と紐付けずに記録する</button>
        <div id="pc-newBox" hidden>
          <label class="fld" for="pc-tmpName">お名前（仮）</label>
          <input id="pc-tmpName" type="text" autocomplete="off" placeholder="例：体験 田中様">
          <p class="small" style="margin-top:6px;line-height:1.7">まだ会員登録のない方の記録に付ける名前です。<br>会員登録のあとで、記録の「紐付け」から会員に付け替えられます。</p>
          <button class="btn" id="pc-tmpOk" type="button" style="margin-top:10px">この名前で進める</button>
        </div>
      </div>
      <div class="pc-sheet-foot"><button class="btn ghost" id="pc-pickClose" type="button">閉じる</button></div>
    </div>`;
  const q = document.getElementById("pc-mq"), list = document.getElementById("pc-mlist");
  const tmp = document.getElementById("pc-tmpName"), box = document.getElementById("pc-newBox"), noLink = document.getElementById("pc-noLink");
  const pick = (id, name) => { closeOv(); opts.onPick?.(id, name); };
  const draw = () => {
    const hits = searchMembers(q.value);
    list.replaceChildren();
    if (!state.members.length) { list.append(el("p", "pc-mnone", "まだ会員がいません。")); return; }
    if (!hits.length) { list.append(el("p", "pc-mnone", `「${q.value.trim()}」に当てはまる会員がいません。`)); return; }
    for (const m of hits.slice(0, 50)) {
      const b = el("button", "pc-mrow"); b.type = "button"; b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(m.id === opts.current));
      b.append(document.createTextNode(m.name));
      if (m.guest) b.append(el("small", "", "ゲスト"));
      b.addEventListener("click", () => pick(m.id, m.name));
      list.append(b);
    }
    if (hits.length > 50) list.append(el("p", "pc-mnone", `ほかに ${hits.length - 50} 人います。名前で絞り込んでください。`));
  };
  q.addEventListener("input", draw);
  tmp.value = opts.tempName || "";
  noLink.addEventListener("click", () => {
    const open = box.hidden;
    box.hidden = !open; noLink.setAttribute("aria-expanded", String(open));
    if (open) tmp.focus();
  });
  const okTmp = () => {
    const name = tmp.value.trim();
    if (!name) { tmp.focus(); return; }
    pick(null, name);
  };
  document.getElementById("pc-tmpOk").addEventListener("click", okTmp);
  tmp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); okTmp(); } });
  document.getElementById("pc-pickClose").addEventListener("click", () => closeOv());
  draw();
  openOv();
  if (!opts.tempName) setTimeout(() => q.focus(), 50);
  else { box.hidden = false; noLink.setAttribute("aria-expanded", "true"); }
}
/* 会員の選択欄を押したとき */
function chooseMember(){
  openMemberPicker({
    current: state.memberId, tempName: state.tempName,
    onPick(id, name){
      const same = id ? id === state.memberId : (!state.memberId && name === state.tempName);
      if (same) return;
      state.memberId = id || ""; state.tempName = id ? "" : name;
      clearPrevious(); state.prevOff = false;
      // 保存ずみの計測が残っていると、別の方の記録として保存できてしまうので消す
      if (state.lastSavedId && VIEWS.some(v => state.views[v].src)) {
        state.views = { front:emptyView(), side:emptyView() }; state.ai = null; state.view = "front";
        say("保存ずみの写真と計測値は消しました。新しく撮影してください。");
      }
      state.lastSavedId = null;
      render();
      loadRecords();
    },
  });
}

function render(){
  if (!state.mounted) return;
  const v = state.views[state.view];
  const live = !!state.stream, has = !!v.src, busy = state.demoRunning;
  const done = VIEWS.filter(k => state.views[k].result);
  const video = $("video"), canvas = $("canvas");

  // 会員・撮影日・デモ
  $("demoChip").hidden = !state.demo;
  $("startDemo").hidden = state.demo;
  $("startDemo").disabled = busy; $("endDemo").disabled = busy;
  renderMember();
  setEngine(state.engine.s, state.engine.text);

  // 撮影
  document.querySelectorAll('.pc-views [role="tab"]').forEach(b => {
    const on = b.dataset.view === state.view;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.disabled = busy;
  });
  for (const view of VIEWS) {
    const s = state.views[view];
    $(`dot-${view}`).dataset.s = s.result ? "done" : s.error ? "error" : "";
  }
  canvas.hidden = !has;
  video.hidden = has || !live;
  video.classList.toggle("mirror", state.facing === "user");
  $("guide").hidden = has || !live;
  $("empty").hidden = has || live;
  $("emptyTitle").textContent = `${VIEW_LABEL[state.view]}から撮影します`;
  $("guideHint").textContent = state.view === "front"
    ? "カメラに正対して、枠の中に全身を入れます"
    : "真横を向いて、枠の中に全身を入れます";
  const steps = $("steps").children;
  steps[0].dataset.s = state.views.front.result ? "done" : state.view === "front" ? "now" : "";
  steps[1].dataset.s = state.views.side.result ? "done" : state.view === "side" ? "now" : "";
  steps[2].dataset.s = state.ai ? "done" : done.length === 2 ? "now" : "";
  if (has) drawOverlay(state.view, canvas);

  const other = VIEWS.find(k => k !== state.view);
  $("startCam").hidden = live || has;
  $("shoot").hidden = !live || has;
  $("timer").hidden = !live || has;
  $("flip").hidden = !live || has;
  $("fileLabel").hidden = has;
  $("retake").hidden = !has;
  $("retake").disabled = busy;
  $("next").hidden = !(has && v.result && !state.views[other].result);
  $("next").textContent = `次へ：${VIEW_LABEL[other]}を撮る`;
  $("controls").hidden = busy;

  // 計測結果
  renderSummary(done);
  for (const view of VIEWS) { $(`group-${view}`).dataset.active = String(view === state.view); renderMetrics(view); }

  // AIコメント（デモの写真はキーがなくてもサンプルを出せる）
  const noKey = !aiKey() && !demoPhotos();
  $("runAi").disabled = busy || state.aiBusy || !done.length || noKey;
  $("runAi").textContent = state.aiBusy ? "作成中…" : state.ai ? "作り直す" : "作成";
  $("aiHint").textContent = state.aiBusy ? "AIがコメントを作成しています…"
    : noKey ? "AIコメントは使えません。Gemini のキーが設定されていません（オーナーが Firebase の settings/ai に入れます）。"
    : !done.length ? "撮影して計測すると作成できます。"
    : done.length === 1 ? `${VIEW_LABEL[done[0]]}だけの計測です。両方そろえると精度が上がります。`
    : "撮影した写真と計測値から、会員向けの説明とおすすめ種目を作ります。AIに会員名は送りません。";
  renderAi();

  // 記録
  $("saveBtn").hidden = !state.store;
  $("saveBtn").disabled = busy || state.saveBusy || !done.length || !recordsOn();
  $("saveBtn").textContent = state.saveBusy ? "保存中…" : "この記録を保存";
  $("pdfBtn").disabled = busy || !done.length;
  renderRecords();
}

function renderSummary(done){
  const box = $("summary");
  box.replaceChildren();
  if (!done.length) { box.append(el("span", "", "まだ計測がありません。上の「撮影」から撮影してください。")); return; }
  const counts = { good:0, watch:0, alert:0 };
  for (const v of done) for (const m of state.views[v].result.metrics) counts[m.status]++;
  for (const s of ["alert","watch","good"]) if (counts[s]) box.append(el("span", `pc-chip ${s}`, `${STATUS_LABEL[s]} ${counts[s]}`));
  box.append(el("span", "", `${done.map(v => VIEW_LABEL[v]).join("・")}の${Object.values(counts).reduce((a,b)=>a+b,0)}項目`));
  box.append(el("p", "pc-prev", state.previous
    ? `前回（${state.previous.date || "日付不明"}）の記録と比べています。項目を押すと、その向きの写真に切り替わります。`
    : "項目を押すと、その向きの写真に切り替わります。"));
}

function renderMetrics(view){
  const box = $(`metrics-${view}`);
  const s = state.views[view];
  box.replaceChildren();
  if (!s.result) {
    box.append(el("p", "pc-placeholder", s.error ? "全身を検出できませんでした。撮り直してください。" : `${VIEW_LABEL[view]}は未計測です。`));
    return;
  }
  const ul = el("ul", "pc-metrics");
  const prev = state.previous?.views?.[view]?.metrics || [];
  for (const m of s.result.metrics) {
    const li = el("li");
    const b = el("button", "pc-m"); b.type = "button"; b.dataset.go = view;
    b.title = `${VIEW_LABEL[view]}の写真を表示`;
    const l = el("span", "pc-m-l"); l.append(el("span", "pc-m-label", m.label), el("span", "pc-m-dir", m.dir));
    const val = el("span", "pc-m-val", m.value.toFixed(1)); val.append(el("small", "", m.unit));
    const r = el("span", "pc-m-r"); r.append(el("span", `pc-status ${m.status}`, STATUS_LABEL[m.status]));
    const pm = prev.find(x => x.key === m.key);
    if (pm) {
      const diff = round1(m.value - pm.value);
      const cls = Math.abs(diff) < 0.3 ? "" : diff < 0 ? " better" : " worse";
      const text = Math.abs(diff) < 0.3 ? `前回 ${pm.value.toFixed(1)}${m.unit}（変化なし）`
        : `前回 ${pm.value.toFixed(1)}${m.unit} → ${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(1)}${m.unit}`;
      r.append(el("span", `pc-delta${cls}`, text));
    }
    b.append(l, val, r); li.append(b); ul.append(li);
  }
  box.append(ul);
  if (s.result.warnings.length) {
    const w = el("ul", "pc-warnings");
    s.result.warnings.forEach(t => w.append(el("li", "", t)));
    box.append(w);
  }
}

const PRI_ORDER = { high:0, medium:1, low:2 };
const PRI_TEXT = { high:"優先度 高", medium:"優先度 中", low:"優先度 低" };
function sectionHead(title, sub){
  const h = el("h3", "pc-ai-h", title);
  if (sub) h.append(el("span", "", sub));
  return h;
}
function renderAi(){
  const out = $("aiOut");
  out.replaceChildren();
  const a = state.ai;
  if (!a) {
    if (!state.aiBusy) out.append(el("p", "small pc-ai-empty", "総評、気になるポイント、おすすめの種目（声かけ例つき）、インストラクター向けメモが表示されます。"));
    return;
  }
  if (a.sample) out.append(el("p", "pc-sample", "デモ用のサンプルコメントです。実際の撮影では Gemini が作成します。"));
  if (a.summary) {
    const lead = el("div", "pc-ai-lead");
    lead.append(el("div", "pc-ai-k", "会員への総評"), el("p", "", a.summary));
    out.append(lead);
  }
  if (Array.isArray(a.findings) && a.findings.length) {
    out.append(sectionHead("気になるポイント", "優先度の高い順"));
    const ul = el("ul", "pc-fl");
    const list = a.findings.slice().sort((x, y) => (PRI_ORDER[x.priority] ?? 9) - (PRI_ORDER[y.priority] ?? 9));
    for (const f of list) {
      const li = el("li", `pc-f ${f.priority || ""}`);
      const head = el("div", "pc-f-head");
      head.append(el("b", "", f.area || ""));
      if (PRI_TEXT[f.priority]) head.append(el("span", `pc-pri ${f.priority}`, PRI_TEXT[f.priority]));
      li.append(head, el("p", "", f.observation || ""));
      ul.append(li);
    }
    out.append(ul);
  }
  if (Array.isArray(a.exercises) && a.exercises.length) {
    out.append(sectionHead("おすすめの種目", `${a.exercises.length}種目`));
    const ol = el("ol", "pc-xl");
    a.exercises.forEach((x, i) => {
      const li = el("li", "pc-x");
      li.append(el("span", "pc-x-n", String(i + 1)));
      const d = el("div");
      d.append(el("b", "", x.name || ""));
      if (x.target) d.append(el("p", "t", x.target));
      if (x.cue) { const c = el("p", "cue"); c.append(el("span", "", "声かけの例"), document.createTextNode(x.cue)); d.append(c); }
      li.append(d); ol.append(li);
    });
    out.append(ol);
  }
  if (a.instructor_notes) {
    const n = el("div", "pc-ai-notes");
    n.append(el("b", "", "インストラクター向けメモ（会員には見せない）"), el("p", "", a.instructor_notes));
    out.append(n);
  }
}

function el(tag, cls = "", text){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
let sayTimer = null;
let lastSay = { text:"", tone:"" };
function say(text, tone){
  lastSay = { text, tone: tone || "" };
  const m = $("msg");
  if (m) { m.textContent = text; m.dataset.tone = tone || ""; }
  clearTimeout(sayTimer);
  if (text && tone !== "error") sayTimer = setTimeout(() => {
    if (lastSay.text !== text) return;
    lastSay = { text:"", tone:"" };
    const m2 = $("msg"); if (m2) m2.textContent = "";
  }, 6000);
}
function showView(view){ state.view = view; say(""); render(); }

/* ============================================================
   Gemini（試験運用：この端末から直接呼ぶ。キーは settings/ai、モデルは config.js の gemini）
   ============================================================ */
const aiKey = () => state.configAi.apiKey || "";
const aiModel = () => state.configAi.model || DEFAULT_MODEL;
const demoPhotos = () => VIEWS.some(v => state.views[v].result && state.views[v].demo);
const SYSTEM_PROMPT = `あなたはピラティススタジオのインストラクターを補助するアシスタントです。
会員の立位姿勢の写真（正面・側面）と、骨格検出から計算済みの計測値を受け取り、会員に伝えるコメントとおすすめの種目を作ります。

守ること:
- 角度などの数値は、渡された計測値だけを使う。写真から新しい数値を推定して書かない。
- 写真は、服装・撮影の向き・検出のズレなど、計測値の信頼性を確かめる補助として使う。
- 医療的な診断や病名、治療の示唆はしない。病名や疾患名は使わず、「傾向」「バランス」「クセ」など日常の言葉で表現する。
- 会員に見せる文章は前向きに書き、体型を否定したり不安をあおったりしない。
- 痛みやしびれが気になる場合に医療機関へ相談をすすめる内容は、instructor_notes に書く。
- 前回の計測値がある場合は、変化にも触れる。
- 種目は一般的なピラティスのマット種目・リフォーマー種目から、所見に合うものを3〜5個選ぶ。

次のJSONだけを返す（前置きやコードブロックは付けない）:
{
  "summary": "会員向けの総評。2〜3文",
  "findings": [{ "area": "部位", "observation": "会員向けの説明。1〜2文", "priority": "high | medium | low" }],
  "exercises": [{ "name": "種目名", "target": "この種目の狙い", "cue": "インストラクターの声かけ例" }],
  "instructor_notes": "インストラクター向けの補足。計測の信頼性、次回の撮影で気をつける点など"
}`;

function metricsForPrompt(views){
  const out = {};
  for (const v of VIEWS) {
    const m = views?.[v]?.metrics;
    if (!m) continue;
    out[VIEW_LABEL[v]] = m.map(x => ({ 項目:x.label, 値:`${x.value}${x.unit}`, 向き:x.dir, 判定:STATUS_LABEL[x.status] }));
  }
  return out;
}

async function runAi(){
  // デモの写真が含まれるときは、APIを呼ばずにサンプルコメントを表示する
  if (demoPhotos()) {
    state.aiBusy = true; render();
    await sleep(1400);
    state.ai = SAMPLE.ai;
    state.aiBusy = false;
    say("AIコメントを作成しました（デモ用のサンプルです）。");
    render();
    return;
  }
  if (!aiKey()) { say("AIコメントは使えません。Gemini のキーが設定されていません（オーナーが Firebase の settings/ai に入れます）。", "error"); return; }
  const current = {};
  for (const v of VIEWS) if (state.views[v].result) current[v] = { metrics: state.views[v].result.metrics, warnings: state.views[v].result.warnings };

  const parts = [];
  parts.push({ text: `今回の計測値:\n${JSON.stringify(metricsForPrompt(current), null, 2)}` });
  const warns = VIEWS.flatMap(v => (current[v]?.warnings || []).map(w => `${VIEW_LABEL[v]}: ${w}`));
  if (warns.length) parts.push({ text: `計測時の注意:\n${warns.join("\n")}` });
  if (state.previous) parts.push({ text: `前回（${state.previous.date || "日付不明"}）の計測値:\n${JSON.stringify(metricsForPrompt(state.previous.views), null, 2)}` });
  for (const v of VIEWS) {
    const src = state.views[v].src;
    if (!src || !state.views[v].result) continue;
    const small = toCanvas(src, src.width, src.height, MAX_AI_PHOTO);
    parts.push({ text: `【${VIEW_LABEL[v]}の写真】` });
    parts.push({ inlineData: { mimeType:"image/jpeg", data: small.toDataURL("image/jpeg", 0.85).split(",")[1] } });
  }

  state.aiBusy = true; render();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(aiModel())}:generateContent`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-goog-api-key": aiKey() },
      body: JSON.stringify({
        systemInstruction: { parts:[{ text: SYSTEM_PROMPT }] },
        contents: [{ role:"user", parts }],
        generationConfig: { responseMimeType:"application/json" },
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message || `HTTP ${res.status}`;
      const hint = res.status === 400 || res.status === 403 ? "Gemini のキー（Firebase の settings/ai）とモデル（config.js の gemini.model）を確認してください。"
        : res.status === 404 ? "モデルが見つかりません。config.js の gemini.model を確認してください。"
        : res.status === 429 ? "利用上限に達しました。少し待ってから再度作成してください。"
        : "時間をおいて再度作成してください。";
      throw new Error(`AIコメントを作成できませんでした。${hint}（${detail}）`);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("");
    if (!text) throw new Error(`AIから回答が返りませんでした（${cand?.finishReason || data.promptFeedback?.blockReason || "理由不明"}）。写真を撮り直すか、再度作成してください。`);
    state.ai = JSON.parse(text.replace(/```json|```/g, "").trim());
    say("AIコメントを作成しました。");
  } catch (err) {
    console.error(err);
    const msg = err.name === "AbortError" ? "AIの応答に時間がかかりすぎたため中断しました。再度作成してください。"
      : err instanceof SyntaxError ? "AIの回答を読み取れませんでした。再度作成してください。"
      : err.message || "AIコメントを作成できませんでした。";
    say(msg, "error");
  } finally {
    clearTimeout(timer);
    state.aiBusy = false;
    render();
  }
}

/* ============================================================
   記録の保存と比較
   計測値・AIコメントは posture_records、縮小した写真は posture_photos に保存する。
   読み書きは index.html が渡す store が行う（デモでは localStorage）。
   会員を選んでいないときの記録は user_id が null（新規のお客様など）。あとから紐付け直せる
   ============================================================ */
const round4 = (n) => Math.round(n * 10000) / 10000;
const fmtYmd = (v) => v ? String(v).slice(0, 10).replace(/-/g, "/") : "日付不明";
const confirmBox = (msg, ok, danger) => typeof askConfirm === "function" ? askConfirm(msg, ok, danger) : Promise.resolve(window.confirm(msg));
/* いま記録の対象にしている会員ID。サンプル表示中は（架空の会員なので）会員と紐付けない */
const curUid = () => state.demo ? "" : state.memberId;
/* いま出している一覧の種類。会員を選んでいればその会員、そうでなければ「紐付いていない記録」 */
const recordsKey = () => curUid() ? "u:" + curUid() : "unlinked";
/* 記録を扱えるか。サンプル表示中は、架空の記録が本物の保存先に入らないよう、アプリのデモモードのときだけ扱う */
const recordsOn = () => !!state.store && (!state.demo || !!state.store.demo);
const clearPrevious = () => { state.previous = null; state.prevId = null; state.prevAuto = false; };

/* 写真に骨格線を重ねて小さくした JPEG（長い辺 640px）。記録に入れる */
function photoThumb(view){
  const v = state.views[view];
  if (!v.src || !v.result) return null;
  const full = document.createElement("canvas");
  drawOverlay(view, full);
  const s = Math.min(1, 640 / Math.max(full.width, full.height));
  const c = document.createElement("canvas");
  c.width = Math.round(full.width * s); c.height = Math.round(full.height * s);
  c.getContext("2d").drawImage(full, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}
/* いまの計測から記録を組み立てる（写真は別） */
function recordFromState(){
  const rec = { user_id: curUid() || null, name: memberName(), date: $("date").value || localDate(new Date()), views:{}, ai: state.ai || null, summary:{ good:0, watch:0, alert:0 } };
  for (const v of VIEWS) {
    const r = state.views[v].result;
    if (!r) continue;
    for (const m of r.metrics) rec.summary[m.status]++;
    rec.views[v] = {
      metrics: r.metrics.map(({ key, label, value, signed, unit, dir, status }) => ({ key, label, value, signed, unit, dir, status })),
      warnings: r.warnings,
      // x, y, 可視性を並べた 1 次元の配列（Firestore は配列の入れ子を保存できない）
      landmarks: r.norm.flatMap(p => [round4(p.x), round4(p.y), Math.round((p.visibility ?? 0) * 100) / 100]),
    };
  }
  return JSON.parse(JSON.stringify(rec));   // undefined を落とす（Firestore は undefined を受け付けない）
}
async function saveRecord(){
  if (!recordsOn() || state.saveBusy) return;
  const done = VIEWS.filter(v => state.views[v].result);
  if (!done.length) { say("先に撮影して計測してください。", "error"); return; }
  if (!state.demo && !state.memberId && !state.tempName) { say("会員を選ぶか、仮のお名前を入れてから保存してください。", "error"); chooseMember(); return; }
  const rec = recordFromState();
  // 同じ日の記録があれば上書きにする。一覧を読めていなければ先に読み直す
  if (state.recordsBusy || state.recordsError || state.recordsKey !== recordsKey()) await loadRecords();
  const dup = state.recordsKey === recordsKey()
    ? state.records.find(r => r.date === rec.date && (curUid() || r.name === rec.name)) : null;
  if (dup && !(await confirmBox(`${fmtYmd(rec.date)} の記録がすでにあります。今回の内容で上書きしますか？`, "上書きする"))) return;
  state.saveBusy = true; render();
  try {
    const photos = { front: photoThumb("front"), side: photoThumb("side") };
    let id = dup?.id;
    if (dup) await state.store.update(dup.id, rec, photos);
    else id = await state.store.save(rec, photos);
    state.lastSavedId = id;
    say(dup ? "記録を上書きしました。"
      : curUid() ? "記録を保存しました。"
      : "記録を保存しました（会員と紐付けなし）。会員登録のあとで「会員に紐付ける」から付けられます。");
  } catch (err) {
    console.error(err);
    say("記録を保存できませんでした。通信環境を確認して、もう一度お試しください。", "error");
  }
  state.saveBusy = false;
  await loadRecords();
}

/* 選んでいる会員（または紐付いていない記録）の一覧を読み込む。
   読み込めたら、比較相手を自分で選んでいなければ直近の記録と自動で比べる */
let recordsSeq = 0;
async function loadRecords(){
  if (!recordsOn()) { state.records = []; state.recordsKey = null; state.recordsBusy = false; render(); return; }
  const key = recordsKey(), seq = ++recordsSeq;
  state.recordsBusy = true; state.recordsError = false;
  if (state.recordsKey !== key) { state.records = []; state.recordsKey = null; }
  render();
  try {
    const rows = curUid() ? await state.store.list(curUid()) : await state.store.unlinked();
    if (seq !== recordsSeq) return;   // 読み込んでいる間に対象が変わった
    state.records = rows; state.recordsKey = key;
  } catch (err) {
    console.error(err);
    if (seq !== recordsSeq) return;
    state.recordsError = true;
  }
  state.recordsBusy = false;
  autoPrevious();
  render();
}
/* 直近の記録を比較相手にする。サンプル表示中や、自分で比較相手を選んでいるときは変えない。
   保存したばかりの記録は（自分自身との比較になるので）飛ばす */
function autoPrevious(){
  if (state.demo || state.prevOff || (state.previous && !state.prevAuto)) return;
  const same = (r) => curUid() ? true : !!state.tempName && r.name === state.tempName;
  const hit = state.records.find(r => r.id !== state.lastSavedId && same(r));
  if (hit) { state.previous = hit; state.prevId = hit.id; state.prevAuto = true; }
  else if (state.prevAuto) clearPrevious();
}
function useAsPrevious(rec){
  if (state.prevId === rec.id) { clearPrevious(); state.prevOff = true; say("比較をやめました。"); }
  else { state.previous = rec; state.prevId = rec.id; state.prevAuto = false; state.prevOff = false; say(`${fmtYmd(rec.date)} の記録と比べています。各項目に変化が表示されます。`); }
  render();
}
function renderRecords(){
  const box = $("records");
  box.replaceChildren();
  if (!state.store) return;
  if (!recordsOn()) { box.append(el("p", "pc-rec-empty", "サンプル表示中は記録を保存できません。「デモを終了」すると、会員の記録を扱えます。")); return; }
  const mine = !!curUid(), m = memberOf(curUid());
  const head = el("div", "pc-rec-h");
  head.append(el("b", "", mine ? `${m ? m.name : ""}さんの記録` : "会員と紐付いていない記録"));
  if (!state.recordsBusy && !state.recordsError) head.append(el("span", "", `${state.records.length}件`));
  box.append(head);
  if (state.recordsBusy && !state.records.length) { box.append(el("p", "pc-rec-empty", "記録を読み込んでいます…")); return; }
  if (state.recordsError) { box.append(el("p", "pc-rec-empty", "記録を読み込めませんでした。通信環境を確認して、タブを開き直してください。")); return; }
  if (!state.records.length) {
    box.append(el("p", "pc-rec-empty", mine
      ? "まだ記録がありません。撮影して「この記録を保存」を押すと、ここに並びます。"
      : "会員を選ぶと、その方の過去の記録がここに並びます。会員と紐付けずに保存した記録は、ここに出ます。"));
    return;
  }
  for (const r of state.records) {
    const row = el("div", "pc-rec"); row.dataset.id = r.id;
    const t = el("div", "pc-rec-t");
    t.append(el("b", "", fmtYmd(r.date)));
    if (!mine) t.append(el("span", "pc-rec-name", r.name || "（名前なし）"));
    const s = r.summary || {};
    for (const k of ["alert","watch","good"]) if (s[k]) t.append(el("span", `pc-chip ${k}`, `${STATUS_LABEL[k]} ${s[k]}`));
    const vs = VIEWS.filter(v => r.views?.[v]).map(v => VIEW_LABEL[v]).join("・");
    if (vs) t.append(el("span", "", vs));
    if (r.ai) t.append(el("span", "", "コメントあり"));
    const a = el("div", "pc-rec-a");
    const mk = (act, label, pressed) => {
      const b = el("button", "btn sm ghost", label); b.type = "button"; b.dataset.act = act;
      if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
      return b;
    };
    const on = state.prevId === r.id;
    a.append(mk("compare", on ? "比較中" : "比べる", on), mk("open", "開く"), mk("link", mine ? "紐付け先を変える" : "会員に紐付ける"), mk("remove", "削除"));
    row.append(t, a); box.append(row);
  }
}
function onRecordAction(e){
  const b = e.target.closest("[data-act]");
  if (!b || state.demoRunning) return;
  const id = b.closest(".pc-rec")?.dataset.id;
  const rec = state.records.find(r => String(r.id) === id);
  if (!rec) return;
  ({ compare:useAsPrevious, open:openRecord, link:linkRecord, remove:removeRecord })[b.dataset.act]?.(rec);
}
/* 記録の紐付け先を変える（会員に付ける、別の会員に付け替える、仮の名前にする） */
function linkRecord(rec){
  openMemberPicker({
    title: "記録の紐付け先を選ぶ", current: rec.user_id || "", tempName: rec.user_id ? "" : rec.name,
    async onPick(id, name){
      if ((id || null) === (rec.user_id || null) && name === rec.name) return;
      try {
        await state.store.link(rec.id, id, name);
        say(id ? `${fmtYmd(rec.date)} の記録を ${name} さんに紐付けました。` : `${fmtYmd(rec.date)} の記録を「${name}」（会員と紐付けなし）にしました。`);
      } catch (err) {
        console.error(err);
        say("紐付けを変えられませんでした。通信環境を確認して、もう一度お試しください。", "error");
      }
      if (state.prevId === rec.id) clearPrevious();
      await loadRecords();
    },
  });
}
async function removeRecord(rec){
  const ok = await confirmBox(`${fmtYmd(rec.date)} の記録（${rec.name || "名前なし"}）を削除します。写真と計測値も消え、元に戻せません。`, "削除する", true);
  if (!ok) return;
  try {
    await state.store.remove(rec.id);
    if (state.prevId === rec.id) clearPrevious();
    say("記録を削除しました。");
  } catch (err) {
    console.error(err);
    say("記録を削除できませんでした。通信環境を確認して、もう一度お試しください。", "error");
  }
  await loadRecords();
}
/* 記録を開いて見る（下から出る画面）。写真はこのときに読み込む */
async function openRecord(rec){
  const body = document.getElementById("ovBody");
  const s = rec.summary || {};
  const chips = ["alert","watch","good"].filter(k => s[k]).map(k => `<span class="pc-chip ${k}">${STATUS_LABEL[k]} ${Number(s[k])}</span>`).join("");
  const table = VIEWS.filter(v => rec.views?.[v]).map(v => `
    <tr><th colspan="3">${VIEW_LABEL[v]}</th></tr>
    ${(rec.views[v].metrics || []).map(m => `<tr><td>${esc(m.label)}<br><small style="color:var(--muted)">${esc(m.dir || "")}</small></td><td>${Number(m.value).toFixed(1)}<small>${esc(m.unit)}</small></td><td><span class="pc-status ${esc(m.status)}">${STATUS_LABEL[m.status] || ""}</span></td></tr>`).join("")}`).join("");
  const a = rec.ai;
  const list = (title, items) => items?.length ? `<b>${title}</b><ul>${items.join("")}</ul>` : "";
  const ai = a ? `<div class="pc-rv-ai">
      ${a.sample ? `<p class="small" style="margin:0 0 6px;font-weight:700">デモ用のサンプルコメント</p>` : ""}
      ${a.summary ? `<b>会員への総評</b><p style="margin:0 0 10px">${esc(a.summary)}</p>` : ""}
      ${list("気になるポイント", (a.findings || []).map(f => `<li>${esc(f.area || "")}：${esc(f.observation || "")}</li>`))}
      ${list("おすすめの種目", (a.exercises || []).map(x => `<li>${esc(x.name || "")}${x.target ? `（${esc(x.target)}）` : ""}</li>`))}
    </div>` : "";
  const on = state.prevId === rec.id;
  body.innerHTML = `
    <div class="pc pc-sheet">
      <h3>${esc(fmtYmd(rec.date))} の記録</h3>
      <div class="sub">${esc(rec.name || "（名前なし）")}${rec.user_id ? "" : "　会員と紐付けなし"}</div>
      <div class="pc-rv-photos">${VIEWS.map(v => `<figure><div class="pc-rv-ph" data-v="${v}"></div><figcaption>${VIEW_LABEL[v]}</figcaption></figure>`).join("")}</div>
      <div class="pc-rv-sum">${chips}</div>
      <table class="pc-rv">${table}</table>
      ${ai}
      <div class="pc-sheet-foot">
        <button class="btn" id="pc-rvCompare" type="button" aria-pressed="${on}">${on ? "比較をやめる" : "この記録と今回を比べる"}</button>
        <button class="btn ghost" id="pc-rvClose" type="button">閉じる</button>
      </div>
    </div>`;
  document.getElementById("pc-rvClose").addEventListener("click", () => closeOv());
  document.getElementById("pc-rvCompare").addEventListener("click", () => { closeOv(); useAsPrevious(rec); });
  openOv();
  try {
    const ph = await state.store.photos(rec.id);
    for (const v of VIEWS) {
      const slot = body.querySelector(`.pc-rv-ph[data-v="${v}"]`);
      if (!slot) continue;   // 読み込んでいる間に閉じた
      if (ph?.[v]) { const img = new Image(); img.src = ph[v]; img.alt = `${VIEW_LABEL[v]}の写真`; slot.replaceWith(img); }
      else slot.replaceWith(el("div", "pc-rv-none", "写真なし"));
    }
  } catch (err) {
    console.error(err);
    body.querySelectorAll(".pc-rv-ph").forEach(slot => slot.replaceWith(el("div", "pc-rv-none", "写真を読み込めませんでした")));
  }
}

/* ============================================================
   PDFレポート（印刷用のA4レイアウトを組み立て、ブラウザの印刷でPDFに保存）
   色と書体はアプリのテーマに合わせる
   ============================================================ */
const PRI_LABEL = { high:"優先度 高", medium:"優先度 中", low:"優先度 低" };

// 16進の色を混ぜる（PDF化のライブラリは color-mix を読めないので、先に計算しておく）
function mixHex(a, b, t){
  const h = (c) => c.replace("#", "").replace(/^(.)(.)(.)$/, "$1$1$2$2$3$3");
  const A = h(a), B = h(b);
  const ch = (i) => Math.round(parseInt(A.slice(i, i+2), 16) * (1 - t) + parseInt(B.slice(i, i+2), 16) * t).toString(16).padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

/* レポート本文。
   1 ページ目：写真と計測表。2 ページ目：インストラクターコメント（2 段組で 1 枚に収める。
   収まらないときはフレームの中のスクリプトが文字を少し小さくし、それでも収まらなければ縦に流して複数ページに分ける）。
   スタッフ用メモは memo=true のときだけ最後のページに付ける */
function reportHTML(preview, memo){
  const member = memberName() || "（会員名なし）";
  const date = $("date").value || localDate(new Date());
  const done = VIEWS.filter(v => state.views[v].result);
  const prev = state.previous;
  const counts = { good:0, watch:0, alert:0 };
  for (const v of done) for (const m of state.views[v].result.metrics) counts[m.status]++;

  const photo = (view) => {
    const s = state.views[view];
    if (!s.src) return `<div class="ph ph-empty"><span>${VIEW_LABEL[view]}は未撮影</span></div>`;
    const cv = document.createElement("canvas");
    drawOverlay(view, cv);
    const small = toCanvas(cv, cv.width, cv.height, 1400);
    return `<div class="ph"><img src="${small.toDataURL("image/jpeg", 0.88)}" alt="${VIEW_LABEL[view]}"></div>`;
  };

  const table = (view) => {
    const s = state.views[view];
    const sub = view === "front" ? "左右のバランス" : "前後のバランス";
    if (!s.result) return `<section class="tbl"><h2>${VIEW_LABEL[view]}<small>${sub}</small></h2><p class="none">未計測</p></section>`;
    const pm = prev?.views?.[view]?.metrics || [];
    const rows = s.result.metrics.map(m => {
      const p = pm.find(x => x.key === m.key);
      let delta = "";
      if (p) {
        const diff = round1(m.value - p.value);
        const cls = Math.abs(diff) < 0.3 ? "" : diff < 0 ? " better" : " worse";
        delta = `<span class="delta${cls}">${Math.abs(diff) < 0.3 ? `前回 ${p.value.toFixed(1)}${m.unit}（変化なし）` : `前回 ${p.value.toFixed(1)}${m.unit} → ${diff < 0 ? "▼" : "▲"}${Math.abs(diff).toFixed(1)}${m.unit}`}</span>`;
      }
      return `<tr>
        <td class="lbl"><b>${esc(m.label)}</b><span>${esc(m.dir)}</span></td>
        <td class="val">${m.value.toFixed(1)}<small>${m.unit}</small></td>
        <td class="st"><span class="status ${m.status}">${STATUS_LABEL[m.status]}</span>${delta}</td>
      </tr>`;
    }).join("");
    const warns = s.result.warnings.length ? `<ul class="warn">${s.result.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
    return `<section class="tbl"><h2>${VIEW_LABEL[view]}<small>${sub}</small></h2><table>${rows}</table>${warns}</section>`;
  };

  const a = state.ai;
  const order = { high:0, medium:1, low:2 };
  const hdHtml = (title, sub) => `<div class="blk hd"><div><h1>${title}</h1><p>${esc(member)}　${esc(date)}${sub ? "　·　" + sub : ""}</p></div><p class="lg">姿勢チェック</p></div>`;
  let comment = "", memoPage = "";
  if (a) {
    const findings = Array.isArray(a.findings) ? a.findings.slice().sort((x, y) => (order[x.priority] ?? 9) - (order[y.priority] ?? 9)) : [];
    const exercises = Array.isArray(a.exercises) ? a.exercises : [];
    const left = (a.sample ? `<p class="blk sample">デモ用のサンプルコメントです。</p>` : "")
      + (a.summary ? `<div class="blk lead"><div class="k">総評</div><p>${esc(a.summary)}</p></div>` : "")
      + (findings.length ? `<h2 class="blk sec">気になるポイント<small>優先度の高い順</small></h2>`
        + findings.map(f => `<div class="blk fd ${esc(f.priority || "")}"><div class="fd-h"><b>${esc(f.area)}</b>${PRI_LABEL[f.priority] ? `<span class="pri ${esc(f.priority)}">${PRI_LABEL[f.priority]}</span>` : ""}</div><p>${esc(f.observation)}</p></div>`).join("") : "");
    const right = exercises.length ? `<h2 class="blk sec">おすすめの種目<small>${exercises.length}種目</small></h2>`
      + exercises.map((x, i) => `<div class="blk ex"><span class="n">${i + 1}</span><div><b>${esc(x.name)}</b>${x.target ? `<p class="t">${esc(x.target)}</p>` : ""}${x.cue ? `<p class="cue"><span>声かけの例</span>${esc(x.cue)}</p>` : ""}</div></div>`).join("") : "";
    comment = `<section class="page cpage" id="cpage">
      ${hdHtml("インストラクターコメント")}
      <div class="cols"><div class="col l">${left}</div><div class="col r">${right}</div></div>
      <p class="blk ft cft">このコメントは撮影時の計測値をもとにしたもので、医療的な診断ではありません。痛みやしびれがある場合は医療機関にご相談ください。</p>
    </section>`;
    if (memo && a.instructor_notes) {
      memoPage = `<section class="page">${hdHtml("スタッフ用メモ", "会員には渡さないページ")}<div class="blk notes"><p>${esc(a.instructor_notes)}</p></div></section>`;
    }
  }

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>姿勢チェック ${esc(member)} ${esc(date)}</title>
<style>${reportCSS(preview)}</style></head><body class="${preview ? "preview" : "print"}">
<div class="sheets" id="sheets">
<section class="page">
  <header class="hd"><div><h1>姿勢チェック レポート</h1><p>${esc(member)}　撮影日 ${esc(date)}${prev ? `　（前回 ${esc(prev.date || "日付不明")} と比較）` : ""}</p></div><p class="lg">${esc(state.demo ? "サンプル表示" : "")}</p></header>
  <div class="photos">
    <div class="pcol"><h3>正面</h3>${photo("front")}</div>
    <div class="pcol"><h3>側面</h3>${photo("side")}</div>
  </div>
  <div class="summary">${["alert","watch","good"].filter(k => counts[k]).map(k => `<span class="chip ${k}">${STATUS_LABEL[k]} ${counts[k]}</span>`).join("")}<span>${done.map(v => VIEW_LABEL[v]).join("・")}の${counts.good + counts.watch + counts.alert}項目を計測。橙の点線は重心の基準線、緑の線は検出した骨格です。</span></div>
  <div class="tables">${table("front")}${table("side")}</div>
  <p class="ft">計測値は写真から推定した目安で、医療的な診断ではありません。撮影の距離・高さ・服装によって値は変わります。前回と比べるときは同じ条件で撮影してください。</p>
</section>
${comment}
${memoPage}
</div>
<script>
(function(){
  var MM = 96 / 25.4;
  var PAGE_H = 273 * MM;          /* 余白を除いた A4 の高さ */
  var FOOT = 9 * MM;              /* ページ番号の分 */
  var LIMIT = PAGE_H - FOOT;
  function h(el){ var cs = getComputedStyle(el); return el.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom); }
  function newPage(before){ var p = document.createElement("section"); p.className = "page"; var sheets = document.getElementById("sheets"); if (before) sheets.insertBefore(p, before); else sheets.appendChild(p); return p; }
  /* コメントの 1 枚：収まる範囲でいちばん大きい文字にする。どう縮めても収まらなければ、縦に流して複数ページへ */
  function fitComment(){
    var cp = document.getElementById("cpage"); if (!cp) return;
    var sizes = [1.12, 1.06, 1, 0.94, 0.88, 0.82];
    for (var i = 0; i < sizes.length; i++) {
      cp.style.setProperty("--fs", sizes[i]);
      var ft = cp.querySelector(".cft");
      var top = cp.getBoundingClientRect().top;
      var bottom = ft.getBoundingClientRect().bottom - top + parseFloat(getComputedStyle(ft).marginBottom);
      if (bottom <= LIMIT) return;
    }
    // 収まらない：ブロックを元の順に縦へ並べ直してページ分け
    cp.style.setProperty("--fs", 1);
    var flow = document.createElement("div"); flow.className = "flow"; flow.id = "flow";
    var next = cp.nextSibling;
    cp.querySelectorAll(":scope > .hd, .col.l > .blk, .col.r > .blk, :scope > .cft").forEach(function(b){ flow.appendChild(b); });
    document.getElementById("sheets").insertBefore(flow, next);
    cp.remove();
    paginate(flow, next);
  }
  /* ブロックを A4 の高さで区切る。「見出し＋その項目」を節として扱い、節が次のページに丸ごと収まるなら丸ごと送る。
     残りが大きいか、節が 1 ページより長いときだけ、項目の切れ目で分けて「（つづき）」を付ける */
  function paginate(flow, before){
    var blocks = Array.prototype.slice.call(flow.children);
    var units = [], i = 0;
    while (i < blocks.length) {
      var b = blocks[i];
      if (b.classList.contains("sec")) {
        var items = [], j = i + 1;
        while (j < blocks.length && (blocks[j].classList.contains("fd") || blocks[j].classList.contains("ex") || blocks[j].classList.contains("ft"))) { items.push(blocks[j]); j++; }
        units.push({ head:b, items:items, title:b.firstChild.textContent }); i = j;
      } else { units.push({ single:b }); i++; }
    }
    var page = null, used = 0;
    function fresh(){ page = newPage(before); used = 0; }
    function put(el){ page.appendChild(el); used += h(el); }
    function cont(title){ var c = document.createElement("h2"); c.className = "blk sec cont"; c.textContent = title + "（つづき）"; put(c); }
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      if (unit.single) {
        var nh = h(unit.single);
        if (unit.single.classList.contains("hd")) { var nx = units[u + 1]; if (nx) nh += nx.single ? h(nx.single) : h(nx.head) + h(nx.items[0] || nx.head); }
        if (!page || (used + nh > LIMIT && used > 0)) fresh();
        put(unit.single); continue;
      }
      var total = h(unit.head); unit.items.forEach(function(it){ total += h(it); });
      if (!page) fresh();
      if (used + total <= LIMIT) { put(unit.head); unit.items.forEach(put); continue; }
      var k = 0, fit = h(unit.head), n = 0;
      while (n < unit.items.length && fit + h(unit.items[n]) <= LIMIT - used) { fit += h(unit.items[n]); n++; }
      var remain = LIMIT - used;
      if (n < 2 || (total <= LIMIT && remain < LIMIT * 0.4)) fresh();
      put(unit.head);
      while (k < unit.items.length) {
        var it = unit.items[k];
        if (used + h(it) > LIMIT && used > 0) { fresh(); cont(unit.title); continue; }
        put(it); k++;
      }
    }
    flow.remove();
  }
  function number(){
    var pages = document.querySelectorAll(".page");
    pages.forEach(function(p, i){
      var f = document.createElement("div"); f.className = "pn";
      f.textContent = ${JSON.stringify(member)} + "　姿勢チェック　" + (i + 1) + " / " + pages.length;
      p.appendChild(f);
    });
  }
  /* プレビュー：A4 のページをそのまま画面の幅に縮める */
  function fit(){
    if (!document.body.classList.contains("preview")) return;
    var sheets = document.getElementById("sheets");
    var w = 210 * MM, s = Math.min(1, (window.innerWidth - 20) / w);
    sheets.style.transform = "scale(" + s + ")";
    document.body.style.height = (sheets.getBoundingClientRect().height + 24) + "px";
  }
  function run(){ fitComment(); number(); fit(); window.__ready = true; }
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(run);
  window.addEventListener("resize", fit);
})();
</script>
</body></html>`;
}

function reportCSS(preview){
  const T = Object.assign({ ink:"#0a0a0a", paper:"#ffffff", smoke:"#f4f4f5", line:"#e4e4e7", muted:"#71717a", danger:"#dc2626", ok:"#16a34a",
    serif:'"Hiragino Mincho ProN","Yu Mincho","YuMincho",serif' }, state.theme || {});
  const watch = mixHex(T.danger, T.ok, 0.5);
  const tint = (c) => mixHex("#ffffff", c, 0.14);
  return `
@page{size:A4 portrait;margin:12mm}
:root{--ink:${T.ink};--paper:${T.paper};--smoke:${T.smoke};--line:${T.line};--muted:${T.muted};--ok:${T.ok};--danger:${T.danger};
  --watch:${watch};--ok-bg:${tint(T.ok)};--watch-bg:${tint(watch)};--danger-bg:${tint(T.danger)};--serif:${T.serif};--fs:1}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{color:var(--ink);font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif;font-size:10.5pt;line-height:1.6;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;overflow-wrap:anywhere;line-break:strict}
.sheets{width:186mm}
.page{position:relative;width:186mm;height:273mm;overflow:hidden;background:#fff;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
.pn{position:absolute;left:0;right:0;bottom:0;padding-top:2mm;border-top:.4pt solid var(--line);font-size:8pt;color:var(--muted);text-align:right}
/* 見出し */
.hd{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:3mm;margin-bottom:5mm;border-bottom:.8pt solid var(--ink)}
.hd h1{margin:0;font-family:var(--serif);font-size:19pt;font-weight:700;letter-spacing:.05em;line-height:1.3}
.hd p{margin:1.5mm 0 0;font-size:10.5pt}
.hd .lg{font-family:var(--serif);font-size:11pt;color:var(--muted);letter-spacing:.06em;white-space:nowrap}
/* 1 ページ目：写真と計測表 */
.photos{display:flex;gap:4mm;margin-bottom:4mm}
.pcol{width:91mm}
.pcol h3{margin:0 0 1.5mm;font-size:9.5pt;font-weight:700;color:var(--muted)}
.ph{width:91mm;height:92mm;background:var(--ink);border-radius:2mm;overflow:hidden;display:flex;align-items:center;justify-content:center}
.ph img{width:100%;height:100%;object-fit:contain;display:block}
.ph-empty span{color:var(--paper);font-size:9.5pt}
.summary{display:flex;align-items:center;gap:2mm;margin:0 0 3mm;font-size:9.5pt;color:var(--muted);flex-wrap:wrap}
.chip{display:inline-block;padding:.4mm 3mm;border-radius:99mm;font-weight:700;font-size:9pt;line-height:1.7}
.chip.good{background:var(--ok-bg);color:var(--ok)}
.chip.watch{background:var(--watch-bg);color:var(--watch)}
.chip.alert{background:var(--danger-bg);color:var(--danger)}
.tables{display:flex;gap:4mm;align-items:flex-start}
.tbl{width:91mm}
.tbl h2{margin:0;padding-bottom:1.5mm;border-bottom:.8pt solid var(--ink);font-family:var(--serif);font-size:13pt;font-weight:700;letter-spacing:.04em}
.tbl h2 small{margin-left:2.5mm;font-family:inherit;font-size:8.5pt;font-weight:400;color:var(--muted)}
.tbl table{width:100%;border-collapse:collapse;table-layout:fixed}
.tbl td{padding:2mm 0;border-bottom:.4pt solid var(--line);vertical-align:middle}
.lbl{width:44mm}.lbl b{display:block;font-weight:700;font-size:10.5pt;line-height:1.35}.lbl span{display:block;font-size:8.5pt;color:var(--muted);line-height:1.4;padding-right:2mm}
.val{width:16mm;text-align:right;font-family:var(--serif);font-size:15pt;line-height:1;white-space:nowrap;padding-right:3mm !important}
.val small{font-size:8.5pt;margin-left:.3mm}
.st{width:31mm}
.status{display:block;font-size:9.5pt;font-weight:700;line-height:1.3}
.status::before{content:"●";font-size:6pt;margin-right:1mm;vertical-align:middle}
.status.good{color:var(--ok)}.status.watch{color:var(--watch)}.status.alert{color:var(--danger)}
.delta{display:block;font-size:8pt;color:var(--muted);line-height:1.35}
.delta.better{color:var(--ok)}.delta.worse{color:var(--danger)}
.warn{margin:2mm 0 0;padding:1.5mm 0 1.5mm 3mm;border-left:.8mm solid ${COLORS.plumb};list-style:none;font-size:8.5pt;color:var(--muted);line-height:1.5}
.none{margin:2mm 0;color:var(--muted)}
.ft{margin:5mm 0 0;padding-top:2mm;border-top:.4pt solid var(--line);font-size:8.5pt;color:var(--muted);line-height:1.6}
/* コメントのページ（2 段組。文字サイズは --fs で一括して増減） */
.cpage{font-size:calc(10pt * var(--fs))}
.cols{display:flex;gap:7mm;align-items:flex-start}
.col.l{flex:0 0 96mm;min-width:0}
.col.r{flex:1 1 auto;min-width:0}
.blk{margin:0 0 3.5mm}
.sample{padding:2mm 3.5mm;background:var(--smoke);border-radius:1.5mm;font-size:.9em;font-weight:700}
.lead{padding:4.5mm 5mm;border-radius:2.5mm;background:var(--smoke)}
.lead .k{font-size:.82em;font-weight:700;letter-spacing:.1em;color:var(--muted);margin-bottom:1.5mm}
.lead p{margin:0;font-size:1.12em;line-height:1.85}
.sec{display:flex;justify-content:space-between;align-items:baseline;margin:5mm 0 3mm;padding-bottom:1.5mm;border-bottom:.8pt solid var(--ink);font-size:1.25em;font-weight:700;letter-spacing:.02em}
.col .sec:first-child{margin-top:0}
.sec small{font-size:.65em;font-weight:400;color:var(--muted)}
.sec.cont{margin-top:0;font-size:1.05em;color:var(--muted);border-bottom-color:var(--line)}
.fd{padding:2.5mm 0 2.5mm 4mm;border-left:1.2mm solid var(--line)}
.fd.high{border-color:var(--danger)}.fd.medium{border-color:var(--watch)}.fd.low{border-color:var(--ok)}
.fd-h{display:flex;align-items:center;justify-content:space-between;gap:3mm;margin-bottom:1.2mm}
.fd-h b{font-size:1.1em;font-weight:700}
.pri{flex:0 0 auto;padding:.6mm 2.5mm;border-radius:99mm;font-size:.76em;font-weight:700;color:#fff;background:var(--muted);white-space:nowrap}
.pri.high{background:var(--danger)}.pri.medium{background:var(--watch)}.pri.low{background:var(--ok)}
.fd p{margin:0;font-size:1em;line-height:1.75}
.ex{display:flex;gap:3mm;padding:2.5mm 0;border-bottom:.4pt solid var(--line);margin:0}
.ex .n{flex:0 0 auto;width:7.5mm;height:7.5mm;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:1.05em;font-weight:700;border:.6pt solid var(--ink);margin-top:.3mm}
.ex b{display:block;font-size:1.1em;font-weight:700;line-height:1.4}
.ex .t{margin:1mm 0 0;font-size:1em;line-height:1.65}
.ex .cue{margin:1.8mm 0 0;padding:1.8mm 3mm;border-radius:2mm;background:var(--smoke);font-size:.95em;line-height:1.65}
.ex .cue span{display:block;font-size:.78em;font-weight:700;letter-spacing:.08em;color:var(--muted);margin-bottom:.4mm}
.cft{margin-top:5mm}
.notes{padding:4mm 5mm;border:.6pt dashed var(--muted);border-radius:2.5mm}
.notes p{margin:0;font-size:10.5pt;line-height:1.8}
/* 縦に流したときのブロック（1 枚に収まらない長文） */
.flow{width:186mm}
/* プレビュー：ページを紙のように並べ、画面の幅に縮める */
body.preview{background:var(--smoke, #eee);padding:10px}
body.preview .sheets{transform-origin:top left;width:210mm}
body.preview .page{margin:0 0 10px;padding:12mm 0 0;height:297mm;width:210mm;box-shadow:0 2px 12px rgba(0,0,0,.14);border:.5pt solid var(--line)}
body.preview .page>*:not(.pn){margin-left:12mm;margin-right:12mm}
body.preview .pn{left:12mm;right:12mm;bottom:12mm}
body.preview .flow{margin:0 12mm}
`;
}

/* 印刷・PDF化に使う A4 固定幅の隠しフレーム。ページ分けが終わるまで待つ */
async function buildPrintFrame(){
  let frame = document.getElementById("pc-printFrame");
  if (frame) frame.remove();
  frame = document.createElement("iframe");
  frame.id = "pc-printFrame";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:820px;height:1200px;border:0;opacity:0;pointer-events:none";
  document.body.append(frame);
  await new Promise((resolve) => { frame.addEventListener("load", resolve, { once:true }); frame.srcdoc = reportHTML(false, state.pdfMemo); });
  const win = frame.contentWindow;
  for (let i = 0; i < 60 && !win.__ready; i++) await sleep(100);
  await Promise.all([...win.document.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
  await sleep(100);
  return frame;
}
function reportFileName(ext){
  const member = (memberName() || "member").replace(/[\\/:*?"<>|\s]/g, "_");
  return `姿勢チェック_${member}_${$("date").value || "nodate"}.${ext}`;
}
/* レポートのプレビューを画面いっぱいに出す。ここから印刷と PDF の保存ができる */
function openReportPreview(){
  if (!VIEWS.some(v => state.views[v].result)) { say("先に撮影して計測してください。", "error"); return; }
  closeReportPreview();
  const ov = document.createElement("div");
  ov.className = "pc-preview"; ov.id = "pc-preview";
  const hasMemo = !!(state.ai && state.ai.instructor_notes);
  ov.innerHTML = `
    <div class="pc-preview-head"><b>レポートのプレビュー</b>
      ${hasMemo ? `<label class="pc-pvMemo"><input type="checkbox" id="pc-pvMemo" ${state.pdfMemo ? "checked" : ""}>スタッフ用メモを付ける</label>` : ""}
      <button class="x" type="button" id="pc-pvClose" aria-label="閉じる">×</button></div>
    <div class="pc-preview-note" id="pc-pvNote"></div>
    <iframe id="pc-pvFrame" title="レポート"></iframe>
    <div class="pc-preview-foot">
      <button class="btn ghost" type="button" id="pc-pvPrint">印刷する</button>
      <button class="btn" type="button" id="pc-pvSave">PDFを保存</button>
    </div>`;
  document.body.append(ov);
  document.body.style.overflow = "hidden";
  document.getElementById("pc-pvFrame").srcdoc = reportHTML(true, state.pdfMemo);
  pvNote("実際の A4 のページをそのまま縮めて表示しています。ピンチで拡大できます。");
  const memoBox = document.getElementById("pc-pvMemo");
  if (memoBox) memoBox.addEventListener("change", (e) => { state.pdfMemo = e.target.checked; document.getElementById("pc-pvFrame").srcdoc = reportHTML(true, state.pdfMemo); });
  document.getElementById("pc-pvClose").addEventListener("click", closeReportPreview);
  document.getElementById("pc-pvPrint").addEventListener("click", printReport);
  document.getElementById("pc-pvSave").addEventListener("click", savePdf);
}
function closeReportPreview(){
  const ov = document.getElementById("pc-preview");
  if (ov) ov.remove();
  document.body.style.overflow = "";
}
function pvNote(text){ const n = document.getElementById("pc-pvNote"); if (n) n.textContent = text || ""; }
function pvBusy(on, label){
  const b = document.getElementById("pc-pvSave"), p = document.getElementById("pc-pvPrint");
  if (b) { b.disabled = on; b.textContent = on ? (label || "準備中…") : "PDFを保存"; }
  if (p) p.disabled = on;
}
/* 印刷：ブラウザの印刷画面を開く。ここから「PDFとして保存」を選ぶこともできる */
async function printReport(){
  if (state.pdfBusy) return;
  state.pdfBusy = true; pvBusy(true, "準備中…");
  try {
    const frame = await buildPrintFrame();
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (err) {
    console.error(err);
    pvNote("印刷画面を開けませんでした。もう一度お試しください。");
  } finally {
    state.pdfBusy = false; pvBusy(false);
  }
}
/* PDFの保存：A4 のページを画像にして PDF にまとめ、ファイルとして保存する */
const PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];
let pdfLibs = null;
function loadPdfLibs(){
  if (window.html2canvas && window.jspdf) return Promise.resolve(true);
  if (!pdfLibs) pdfLibs = Promise.all(PDF_LIBS.map(src => new Promise((res) => {
    const sc = document.createElement("script"); sc.src = src;
    sc.onload = () => res(true); sc.onerror = () => res(false);
    document.head.append(sc);
  }))).then(r => { if (!r.every(Boolean)) pdfLibs = null; return r.every(Boolean) && !!window.html2canvas && !!window.jspdf; });
  return pdfLibs;
}
async function savePdf(){
  if (state.pdfBusy) return;
  state.pdfBusy = true; pvBusy(true, "PDFを作成中…"); pvNote("");
  try {
    const ok = await loadPdfLibs();
    if (!ok) throw new Error("libs");
    const frame = await buildPrintFrame();
    const doc = frame.contentDocument;
    const pages = [...doc.querySelectorAll(".page")];
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit:"mm", format:"a4", orientation:"portrait" });
    const W = 210 - 24, H = 273, M = 12;
    for (let i = 0; i < pages.length; i++) {
      const cv = await window.html2canvas(pages[i], { scale:2, backgroundColor:"#ffffff", useCORS:true, logging:false, windowWidth:820 });
      if (i) pdf.addPage();
      pdf.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", M, M, W, Math.min(H, cv.height * W / cv.width));
    }
    pdf.save(reportFileName("pdf"));
    pvNote("PDFを保存しました。端末のダウンロード先をご確認ください。");
  } catch (err) {
    console.error(err);
    pvNote(err.message === "libs"
      ? "PDF作成の部品を読み込めませんでした。通信環境を確認するか、「印刷する」から「PDFとして保存」を選んでください。"
      : "PDFを作成できませんでした。「印刷する」から「PDFとして保存」を選んでください。");
  } finally {
    state.pdfBusy = false; pvBusy(false);
  }
}

/* ============================================================
   デモ（架空の会員のイラストで、撮影から比較までを体験できる）
   ============================================================ */
// ランドマークに合わせて、スタジオに立つ人物のイラストを描く（実在の人物写真は使わない）
function drawDemoPhoto(view){
  const { w:W, h:H } = SAMPLE.size;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const L = SAMPLE[view].map(([x, y]) => ({ x:x*W, y:y*H }));
  const at = (p, dx = 0, dy = 0) => ({ x:p.x + dx, y:p.y + dy });
  const seg = (a, b, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = "round"; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); };
  const poly = (pts, col, round = 0) => {
    g.fillStyle = col; g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
    g.closePath(); g.fill();
    if (round) { g.strokeStyle = col; g.lineWidth = round; g.lineJoin = "round"; g.stroke(); }
  };
  const oval = (x, y, rx, ry, col, rot = 0) => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };
  const skin = "#E6C4A6", skinShade = "#D3AA8A", top = "#5B6F73", legging = "#3E4A4D", legFar = "#323C3F", hair = "#3A302B";

  // 壁と床
  const wall = g.createLinearGradient(0, 0, 0, H * .8);
  wall.addColorStop(0, "#E6EBE8"); wall.addColorStop(1, "#D2D9D5");
  g.fillStyle = wall; g.fillRect(0, 0, W, H);
  g.fillStyle = "#CDB9A1"; g.fillRect(0, H * .8, W, H * .2);
  g.fillStyle = "rgba(0,0,0,.07)"; g.fillRect(0, H * .8, W, 5);

  if (view === "front") {
    poly([{x:W*.35,y:H*.845},{x:W*.65,y:H*.845},{x:W*.74,y:H*.995},{x:W*.26,y:H*.995}], "#8FA59B");
    oval((L[27].x + L[28].x) / 2, H * .925, 130, 20, "rgba(30,40,38,.16)");
    seg(L[12], L[14], 36, skin); seg(L[14], L[16], 30, skin); oval(L[20].x, L[20].y - 8, 19, 24, skin);
    seg(L[11], L[13], 36, skin); seg(L[13], L[15], 30, skin); oval(L[19].x, L[19].y - 8, 19, 24, skin);
    seg(L[24], L[26], 70, legging); seg(L[26], L[28], 50, legging);
    seg(L[23], L[25], 70, legging); seg(L[25], L[27], 50, legging);
    seg(L[30], L[32], 26, skin); seg(L[29], L[31], 26, skin);
    poly([at(L[24], -40, -30), at(L[23], 40, -30), at(L[23], 42, 30), at(L[24], -42, 30)], legging, 24);
    poly([at(L[12], -8, -4), at(L[11], 8, -4), at(L[23], 26, -12), at(L[24], -26, -12)], top, 34);
    const ms = { x:(L[11].x + L[12].x) / 2, y:(L[11].y + L[12].y) / 2 };
    const me = { x:(L[7].x + L[8].x) / 2, y:(L[7].y + L[8].y) / 2 };
    seg(at(ms, 0, -12), at(me, 0, 34), 46, skin);
    const rot = Math.atan2(L[7].y - L[8].y, L[7].x - L[8].x);
    oval(me.x, me.y - 30, 70, 74, hair, rot);
    oval(L[7].x, L[7].y, 12, 17, skinShade); oval(L[8].x, L[8].y, 12, 17, skinShade);
    oval(me.x, me.y - 6, 58, 72, skin, rot);
    oval(me.x, me.y - 58, 64, 36, hair, rot);
  } else {
    g.fillStyle = "#8FA59B"; g.fillRect(W * .14, H * .918, W * .72, H * .03);
    g.fillStyle = "#7A9086"; g.fillRect(W * .14, H * .948, W * .72, H * .008);
    oval(L[27].x + 20, H * .922, 120, 14, "rgba(30,40,38,.16)");
    seg(L[12], L[14], 32, skinShade); seg(L[14], L[16], 28, skinShade);
    seg(L[24], L[26], 66, legFar); seg(L[26], L[28], 48, legFar); seg(L[30], L[32], 24, skinShade);
    poly([at(L[23], -56, -26), at(L[23], 46, -26), at(L[23], 40, 40), at(L[23], -48, 46)], legging, 30);
    poly([at(L[11], -40, 4), at(L[11], 46, 12), at(L[23], 40, -8), at(L[23], -50, -6)], top, 30);
    seg(L[23], L[25], 72, legging); seg(L[25], L[27], 52, legging);
    seg(L[29], L[31], 26, skin); seg(L[27], L[29], 24, skin);
    seg(at(L[11], 4, -12), at(L[7], 12, 30), 48, skin);
    oval(L[7].x - 18, L[7].y - 26, 66, 70, hair);
    oval(L[7].x + 22, L[7].y - 14, 62, 74, skin);
    poly([at(L[0], -8, -22), at(L[0], 12, 2), at(L[0], -10, 6)], skin);
    oval(L[7].x - 6, L[7].y - 52, 62, 42, hair);
    oval(L[7].x - 62, L[7].y - 44, 28, 28, hair);
    oval(L[7].x, L[7].y, 13, 18, skinShade);
    seg(L[11], L[13], 34, skin); seg(L[13], L[15], 30, skin); oval(L[19].x, L[19].y - 6, 18, 24, skin);
  }
  return c;
}

function buildDemoPrevious(){
  const d = new Date(); d.setDate(d.getDate() - 31);
  const views = {};
  for (const v of VIEWS) {
    const r = state.views[v].result;
    if (!r) continue;
    views[v] = {
      metrics: r.metrics.map(m => {
        const value = round1(Math.max(0, m.value + (SAMPLE.prevDelta[m.key] ?? 0)));
        return { key:m.key, label:m.label, value, signed:value, unit:m.unit, dir:m.dir, status:grade(value, TH[thKey(m.key)]) };
      }),
      warnings: [],
    };
  }
  return { app:"posture-check", version:1, member:SAMPLE.member, date:localDate(d), views, ai:null };
}
async function startDemo(){
  if (state.demoRunning) return;
  stopCamera();
  state.demo = true; state.demoRunning = true;
  state.views = { front:emptyView(), side:emptyView() };
  state.previous = null; state.ai = null;
  state.date = localDate(new Date()); $("date").value = state.date;
  for (const view of VIEWS) {
    state.view = view;
    const photo = drawDemoPhoto(view);
    state.views[view] = { src:photo, result:null, error:null, demo:true };
    render();
    say(`${VIEW_LABEL[view]}の骨格を検出しています…`);
    await sleep(700);
    const norm = SAMPLE[view].map(([x, y, visibility]) => ({ x, y, z:0, visibility }));
    applyLandmarks(view, photo, norm);
    render();
    await sleep(350);
  }
  state.previous = buildDemoPrevious(); state.prevId = null; state.prevAuto = false; state.prevOff = false;
  state.view = "front";
  state.demoRunning = false;
  render();
  loadRecords();   // サンプル表示中は「紐付いていない記録」の一覧にする
  say("サンプル会員の計測結果と、1か月前との比較を表示しています。「AIコメント」の作成も試せます。");
}
function endDemo(){
  state.demo = false;
  state.views = { front:emptyView(), side:emptyView() };
  clearPrevious(); state.prevOff = false; state.ai = null; state.view = "front"; state.lastSavedId = null;
  state.date = localDate(new Date()); $("date").value = state.date;
  render();
  loadRecords();   // 会員を選んでいれば、その方の一覧と直近の記録との比較に戻す
  say("デモを終了しました。撮影から始められます。");
}

/* ============================================================
   組み込み（index.html から呼ぶ）
   ============================================================ */
function ensureStyle(){
  if (document.getElementById("pc-style")) return;
  const s = document.createElement("style");
  s.id = "pc-style"; s.textContent = CSS;
  document.head.append(s);
}
function bind(){
  document.querySelectorAll('.pc-views [role="tab"]').forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  $("pickMember").addEventListener("click", chooseMember);
  $("date").addEventListener("change", (e) => { state.date = e.target.value; });
  $("startCam").addEventListener("click", startCamera);
  $("shoot").addEventListener("click", shoot);
  $("flip").addEventListener("click", () => { state.facing = state.facing === "user" ? "environment" : "user"; startCamera(); });
  $("retake").addEventListener("click", () => { state.views[state.view] = emptyView(); state.ai = null; state.lastSavedId = null; autoPrevious(); say(""); render(); });
  $("next").addEventListener("click", () => showView(VIEWS.find(k => k !== state.view)));
  $("file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
  $("saveBtn").addEventListener("click", saveRecord);
  $("records").addEventListener("click", onRecordAction);
  $("pdfBtn").addEventListener("click", openReportPreview);
  $("runAi").addEventListener("click", runAi);
  $("startDemo").addEventListener("click", startDemo);
  $("endDemo").addEventListener("click", endDemo);
  // 計測項目や「写真を見る」を押したら、その向きの写真に切り替えて撮影欄を見せる
  document.querySelector(".pc").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (!go || state.demoRunning) return;
    showView(go.dataset.go);
    document.querySelector(".pc-stage")?.scrollIntoView({ behavior:"smooth", block:"center" });
  });
}

// スペースで撮影、1・2で正面・側面（姿勢分析を開いているときだけ）
document.addEventListener("keydown", (e) => {
  if (!state.mounted) return;
  if (e.target.matches("input,select,textarea")) return;
  if (document.getElementById("ov")?.classList.contains("show")) return;
  if (e.key === " " && !$("shoot").hidden && !$("shoot").disabled) { e.preventDefault(); shoot(); }
  if (e.key === "1") showView("front");
  if (e.key === "2") showView("side");
});
window.addEventListener("pagehide", stopCamera);

window.Posture = {
  /* container: 画面を描く要素
     opts: { members:[{id,name,kana,guest}], theme:SHOP.theme,
             store:{ list, unlinked, save, update, link, photos, remove, demo }（記録の読み書き。demo はアプリのデモモード）,
             ai:{ apiKey, model }（apiKey は Firestore の settings/ai、model は config.js の gemini） } */
  mount(container, opts = {}){
    stopCamera();
    ensureStyle();
    state.members = opts.members || [];
    state.theme = opts.theme || {};
    state.store = opts.store || null;
    state.configAi = opts.ai || {};
    if (state.memberId && !memberOf(state.memberId)) { state.memberId = ""; clearPrevious(); }
    if (!state.date) state.date = localDate(new Date());
    container.innerHTML = template();
    state.mounted = true;
    $("date").value = state.date;
    bind();
    if (lastSay.text) { $("msg").textContent = lastSay.text; $("msg").dataset.tone = lastSay.tone; }
    render();
    ensureEngine();
    loadRecords();
  },
  /* タブを離れるとき。カメラを止め、撮った写真や計測値は残す */
  unmount(){
    if (!state.mounted) return;
    stopCamera();
    closeReportPreview();
    state.mounted = false;
    const cd = $("countdown"); if (cd) cd.innerHTML = "";
  },
};
})();
