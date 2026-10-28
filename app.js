'use strict';

/* ============================================================
   包装チェックアプリ
   ・製品を選ぶ → 撮影（見本写真を半透明で重ねる）→ 見本と並べて OK／NG → その場で合否
   ・色で判定：目印（例：黄色い楕円）と、色で確かめる場所を登録した製品は、撮影すると機械が判定する（colorjudge.js。いちばん優先）
   ・自動判定：ラベルなしの写真とラベルの場所（四角）を登録した製品は、見本と見比べて機械が判定する（judge.js）
   ・結果は記録しない（作業者の手助け用）
   ・見本（写真・チェック項目）はこのブラウザの IndexedDB に保存。
     ファイル（見本データ.json）に書き出して、ほかのスマホで読み込める。
     配布用に 見本データ.js を書き出してアプリのフォルダに入れると、開いた時点で見本が入る（手元より新しければ置き換え）。
   ============================================================ */

const APP_VERSION = document.querySelector('meta[name="app-version"]').content; // 版は index.html の app-version に書く
const DATA_FILE = '見本データ.json';  // スマホどうしの受け渡し用
const BUNDLE_FILE = '見本データ.js'; // 配布するアプリに同梱する用
const { $, esc, showError, showInfo, hideBanners, download } = AppKit.ui;

/* ---------- 保存（IndexedDB） ---------- */
const store = (() => {
  const DB_NAME = 'housou-check', ST = 'kv', KEY = 'data';
  let dbp = null;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(ST);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(ST, mode);
      const req = fn(t.objectStore(ST));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    load: () => tx('readonly', s => s.get(KEY)),
    save: data => tx('readwrite', s => s.put(data, KEY)),
  };
})();

const emptyData = () => ({ app: '包装チェックアプリ', format: 1, updatedAt: '', products: [] });
let data = emptyData();

async function saveData() {
  data.updatedAt = new Date().toISOString();
  try { await store.save(data); }
  catch (e) { showError('保存できませんでした（スマホの空き容量が足りない可能性があります）：' + e.message); throw e; }
}

function validData(d) {
  return d && d.app === '包装チェックアプリ' && Array.isArray(d.products);
}

/* ---------- 画面の切り替え ---------- */
const VIEWS = {
  list:  { el: '#viewList',  title: '包装チェック', parent: null },
  shoot: { el: '#viewShoot', title: '',            parent: 'list' },
  check: { el: '#viewCheck', title: '',            parent: 'list' },
  admin: { el: '#viewAdmin', title: '見本の登録',  parent: 'list' },
  edit:  { el: '#viewEdit',  title: '見本の編集',  parent: 'admin' },
};
let current = 'list';
let pendingInfo = ''; // 戻った先の画面で出すお知らせ

function showView(name) {
  if (current === 'shoot' && name !== 'shoot') stopCamera();
  current = name;
  Object.entries(VIEWS).forEach(([k, v]) => { $(v.el).hidden = k !== name; });
  const v = VIEWS[name];
  $('#title').textContent = v.title || (checking.product ? checking.product.name : '');
  $('#btnBack').hidden = !v.parent;
  $('#btnAdmin').hidden = name !== 'list';
  hideBanners();
  renderCount();
  window.scrollTo(0, 0);
}
function go(name) { history.pushState({ v: name }, ''); showView(name); }
function back() { history.back(); }

window.addEventListener('popstate', e => {
  const to = (e.state && e.state.v) || 'list';
  if (current === 'edit' && editing.dirty && to !== 'edit') {
    if (!confirm('保存していない変更があります。破棄して戻りますか？')) { history.pushState({ v: 'edit' }, ''); return; }
    editing.dirty = false;
  }
  showView(to);
  if (to === 'list') renderList();
  if (to === 'admin') renderAdmin();
  if (to === 'shoot') startShoot();
  if (to === 'edit') { checking.test = false; renderEdit(); }
  if (pendingInfo) { showInfo(pendingInfo); pendingInfo = ''; }
});

/* ---------- 画像 ---------- */
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めませんでした')); i.src = src; });
}
// 長い辺を max px に縮めて JPEG の dataURL にする。crop を渡すと、その範囲だけを切り出す
function toJpeg(src, max, crop) {
  const sw = crop ? crop.w : (src.videoWidth || src.naturalWidth);
  const sh = crop ? crop.h : (src.videoHeight || src.naturalHeight);
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d').drawImage(src, crop ? crop.x : 0, crop ? crop.y : 0, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
async function fileToJpeg(file, max, ar) {
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImage(url);
    return toJpeg(im, max, ar ? centerCrop(im.naturalWidth, im.naturalHeight, ar) : null);
  } finally { URL.revokeObjectURL(url); }
}
// 縦横比 ar になるよう、中央を切り出す範囲
function centerCrop(w, h, ar) {
  if (w / h > ar) { const cw = h * ar; return { x: (w - cw) / 2, y: 0, w: cw, h }; }
  const ch = w / ar; return { x: 0, y: (h - ch) / 2, w, h: ch };
}
async function imageAr(src) { const im = await loadImage(src); return im.naturalWidth / im.naturalHeight; }

const areaName = (a, i) => `${'①②③④⑤⑥⑦⑧⑨⑩'[i] || i + 1}${a.name ? a.name : ''}`;
/* 自動判定の設定（colorjudge.js）
   p.color = { anchor: { h, s, v, box, ar, fill, inner }（目印）, areas: [{ x, y, w, h（0〜1）, name, look, color }] }
   look：場所で見るもの（なし＝色、'gray'＝グレーのキャップ。'smooth'＝なめらかさ は 20261028-4 までの設定）
   ※ 20261028-5 で「見本と見比べて判定」（judge.js・p.auto）と「目視で確認する項目」（p.items）をやめた（前の版のデータに残っていても使わない） */
const colorReady = p => !!(p && p.image && p.color && p.color.anchor && p.color.areas && p.color.areas.length && p.color.areas.every(a => a.color));
const methodOf = p => colorReady(p) ? 'color' : null;
/* 真上から撮る写真（オーバーキャップ。20261028-6 から。任意）
   p.top = { image（真上の見本写真）, base（見本で、枠の中のいちばん大きいグレーのかたまりが枠の何割か）,
             w, h, fill, touch（そのかたまりの形。20261028-7 から。キャップ以外のグレーの物を「あり」にしないために比べる）,
             v（測ったときの枠の版 ColorJudge.TOP_VERSION。20261028-8 で枠を大きくした） }
   設定があると、横から撮った判定が合格したあと、続けて真上から撮って判定する（目印は使わず、画面の枠にキャップを合わせてもらう） */
const topReady = p => !!(p && p.top && p.top.image && p.top.base >= ColorJudge.TOP_MIN && !(p.top.touch > ColorJudge.TOP_TOUCH));
const TOP_NAME = 'オーバーキャップ（真上）';

// 真上の写真の枠（キャップを合わせる枠）を描く。state は 'pass' / 'fail' / 'unsure'
function drawGuide(el, state) {
  const g = ColorJudge.TOP_GUIDE;
  el.innerHTML = `<span class="area top-mark${state ? ' ' + state : ''}" style="left:${g.x * 100}%;top:${g.y * 100}%;width:${g.w * 100}%;height:${g.h * 100}%"></span>`;
}
// 写真の上に、目印の枠と判定する場所の四角を描く（x, y は写真に対する 0〜1）。states は場所ごとの 'pass' / 'fail' / 'unsure'
function drawMarks(el, areas, states, anchor) {
  const pos = b => `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
  el.innerHTML = (anchor ? `<span class="anchor" style="${pos(anchor)}"><em>目印</em></span>` : '') + (areas || []).map((a, i) => {
    const st = states && states[i] ? ' ' + states[i] : '';
    return `<span class="area carea${st}" style="${pos(a)}"><em>${i + 1}</em></span>`;
  }).join('');
}

/* ---------- ① 製品を選ぶ ---------- */
function productButton(p, attrs) {
  const img = p.image ? `<img src="${p.image}" alt="">` : '<span class="noimg">写真なし</span>';
  const m = methodOf(p);
  const how = [m ? (topReady(p) ? '自動判定（横＋真上）' : '自動判定') : '自動判定の設定なし', count && count.productId === p.id && attrs.startsWith('data-id') ? `合格 ${passCount()} 個` : ''].filter(Boolean).join('・');
  return `<button class="product" ${attrs}>${img}<span class="p-text"><b>${esc(p.name)}</b>` +
    `<small>${esc(p.code || '')}${p.code ? '　' : ''}${how}</small></span><span class="chev">›</span></button>`;
}
function sortedProducts() {
  return data.products.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}
function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = sortedProducts().filter(p => !q || (p.name + ' ' + (p.code || '')).toLowerCase().includes(q));
  $('#productList').innerHTML = list.map(p => productButton(p, `data-id="${p.id}"`)).join('');
  $('#emptyList').hidden = data.products.length > 0;
  if (data.products.length && !list.length) $('#productList').innerHTML = '<div class="empty">見つかりません。</div>';
}
$('#search').addEventListener('input', renderList);
$('#productList').addEventListener('click', e => {
  const b = e.target.closest('.product'); if (!b) return;
  const p = data.products.find(x => x.id === b.dataset.id); if (!p) return;
  // 別の製品に切り替えるときは、数えていた合格数をクリアする（数えていれば確認する）
  if (count && count.productId !== p.id && (passCount() || count.fail) &&
      !confirm(`「${count.name}」の合格数（${passCount()} 個）をクリアして、「${p.name}」に切り替えますか？`)) return;
  if (!count || count.productId !== p.id) { count = newCount(p); saveCount(); }
  checking.product = p; checking.test = false; checking.container = null; checking.qrStop = null;
  resetSteps();
  go('shoot'); startShoot();
});

/* ---------- 合格数（日産数量との照合用） ----------
   製品を選んでチェックしている間の、合格の数（と不合格の回数）。iPhone に保存し、アプリを閉じても消えない。
   消えるのは「クリア」ボタンを押したとき・別の製品に切り替えたとき（どちらも確認してから）・日付が変わったとき（自動）。
   判定を試すでは数えない。1 回のチェック（結果の画面）で数えるのは 1 回だけ。結果が変わったら（目視の NG など）数え直す。
   品種コードのある製品（容器の QR を読む）：容器ごとに最後の結果を覚え（items）、合格数は「合格した容器の数」。
     同じ容器を何度チェックしても 1 個と数える。今日チェックした容器No.は、二重チェックを止めるのにも使う
   品種コードの無い製品：合格の回数を数える。二重に数えたときは、結果の画面の「数えない（−1）」で戻す */
const COUNT_KEY = 'housou-check-count';
let count = loadCount();
function loadCount() {
  try {
    const c = JSON.parse(localStorage.getItem(COUNT_KEY));
    if (c && c.productId) return Object.assign({ items: {}, day: dayOf(new Date(c.since || Date.now())) }, c);
  } catch (e) { /* 読めなければ 0 から */ }
  return null;
}
function saveCount() {
  try { if (count) localStorage.setItem(COUNT_KEY, JSON.stringify(count)); else localStorage.removeItem(COUNT_KEY); } catch (e) { /* 保存できなくても数えることは続ける */ }
}
function dayOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function newCount(p) { return { productId: p.id, name: p.name, pass: 0, fail: 0, items: {}, since: new Date().toISOString(), day: dayOf(new Date()) }; }
const byContainer = p => !!(p && p.kind);
function passCount() {
  if (!count) return 0;
  const p = data.products.find(x => x.id === count.productId);
  return byContainer(p) ? Object.values(count.items).filter(v => v.verdict === 'pass').length : count.pass;
}
// 日付が変わっていたら、数え直す（二重チェックの範囲も「その日のうち」）
function rollDay() {
  if (!count || count.day === dayOf(new Date())) return;
  const p = data.products.find(x => x.id === count.productId);
  if (!p) return;
  count = newCount(p);
  saveCount();
  renderCount();
  showInfo('日付が変わったので、合格数とチェック済みの容器をクリアしました。');
}
const counting = () => !!(count && checking.product && !checking.test && count.productId === checking.product.id);
// 結果の画面の判定（'pass' / 'fail' / それ以外）に合わせて数える
function syncCount(state) {
  if (!counting() || checking.noCount) return;
  state = state === 'pass' || state === 'fail' ? state : null;
  if (state === checking.countState) return;
  rollDay();
  if (checking.container) {
    // 容器ごと：その容器の最後の結果を覚える（判定できないときは前の結果のまま）。不合格は回数も数える
    if (checking.countState === 'fail') count.fail = Math.max(0, count.fail - 1);
    if (state === 'fail') count.fail++;
    if (state) count.items[checking.container] = { at: new Date().toISOString(), verdict: state };
  } else {
    if (checking.countState) count[checking.countState] = Math.max(0, count[checking.countState] - 1);
    if (state) count[state]++;
  }
  checking.countState = state;
  saveCount();
  renderCount();
}
function renderCount() {
  const el = $('#counter'), show = (current === 'shoot' || current === 'check') && counting();
  el.hidden = !show;
  $('#btnUncount').hidden = !(show && current === 'check' && checking.countState === 'pass' && !checking.container);
  if (!show) return;
  $('#cntPass').textContent = passCount();
  const d = new Date(count.since), hm = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#cntSub').textContent = byContainer(checking.product)
    ? `チェック済み ${Object.keys(count.items).length} 個（不合格 ${count.fail} 回） ／ ${hm} から`
    : `不合格 ${count.fail} 回 ／ ${hm} から`;
}
$('#btnCntClear').addEventListener('click', () => {
  if (!counting()) return;
  if ((passCount() || count.fail) && !confirm(`合格数（${passCount()} 個）と不合格の回数（${count.fail} 回）をクリアして、0 から数え直しますか？` +
      (byContainer(checking.product) ? '\nチェック済みの容器の記録も消えます（同じ容器をもう一度チェックできるようになります）。' : ''))) return;
  count = newCount(checking.product);
  checking.countState = null;
  saveCount();
  renderCount();
});
$('#btnUncount').addEventListener('click', () => {
  if (!counting() || checking.countState !== 'pass') return;
  count.pass = Math.max(0, count.pass - 1);
  checking.countState = null; checking.noCount = true; // この結果の画面では、もう数えない
  saveCount();
  renderCount();
  showInfo('この容器は数えませんでした（合格数を 1 つ戻しました）。');
});

/* ---------- 容器の QR（容器No.） ----------
   製品に品種コードがあるとき、ラベルの判定の前に容器の QR を読む（判定を試すでは読まない）。
   QR の中身は「品種コード 2 文字＋容器の番号 6 桁」の 8 文字（例：E2000460 → 品種 E2（100kg ELEX）・No.000460）
   ・違う品種の容器 → 「設定していない品種です」で止める（作業者が「次の容器へ」を押すまで進まない）
   ・今日すでにチェックした容器 → 一旦止めて、もう一度チェックするか（不合格を貼り直したあとなど）を選んでもらう
   QR の読み取りは jsQR（lib/jsQR.js、Apache License 2.0）。iPhone の中だけで読み、どこにも送らない */
const KINDS = { D2: '15kg ELEX', E2: '100kg ELEX', F1: '210kg EL', F3: '200kg 準一級', F4: '230kg ELEX', I1: '190kg ELEX', I2: '190kg ELEX35%', I3: '190kg 高純29%' };
const kindName = k => KINDS[k] ? `${k}（${KINDS[k]}）` : k;
function parseNo(t) {
  const m = /^([A-Z0-9]{2})(\d{6})$/.exec(String(t || '').trim().toUpperCase());
  return m ? { no: m[0], kind: m[1], num: m[2] } : null;
}
const fmtNo = no => `${no.slice(0, 2)}-${no.slice(2)}`;
const hhmm = iso => { const d = new Date(iso); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const needQr = () => !!(checking.product && checking.product.kind && !checking.test);
const waitingQr = () => needQr() && !checking.container;
const qrLoop = { timer: 0, busy: false };
function startQr() {
  stopQr();
  $('#liveStatus').hidden = false;
  $('#liveStatus').textContent = '容器の QR を写してください。';
  qrLoop.timer = setInterval(qrTick, 250);
}
function stopQr() { clearInterval(qrLoop.timer); qrLoop.timer = 0; }
function qrTick() {
  if (qrLoop.busy) return;
  if (current !== 'shoot' || !stream) { stopQr(); return; }
  const v = $('#video'); if (!v.videoWidth) return;
  qrLoop.busy = true;
  try {
    const t = readQr(frameCanvas(v, 800));
    if (t && !acceptNo(t)) $('#liveStatus').textContent = `容器No. ではない QR です（${t.slice(0, 20)}）。容器の QR を写してください。`;
  } catch (e) { /* 次の映像で読み直す */ } finally { qrLoop.busy = false; }
}
function readQr(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const r = jsQR(d.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
  return r && r.data ? r.data : '';
}
// 写真（ファイル）から QR を読む。大きめで読めなければ、縮めて読み直す
async function readQrFromFile(f) {
  const url = URL.createObjectURL(f);
  try {
    const im = await loadImage(url);
    for (const max of [1600, 800]) {
      const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      const t = readQr(c);
      if (t) return t;
    }
    return '';
  } finally { URL.revokeObjectURL(url); }
}
// 読んだ容器No.を確かめる。容器No.の形でなければ false
function acceptNo(text) {
  const n = parseNo(text), p = checking.product;
  if (!n) return false;
  stopQr();
  rollDay();
  const done = counting() && count.items[n.no];
  if (n.kind !== p.kind) checking.qrStop = { type: 'kind', n };
  else if (done) checking.qrStop = { type: 'dup', n, done };
  if (checking.qrStop) { play('fail'); renderQr(); return true; }
  setContainer(n.no);
  return true;
}
function setContainer(no) {
  checking.container = no; checking.qrStop = null;
  play('read');
  renderQr();
  if (checking.live) startAuto();
}
// 容器の QR を読むところから始める
function startQrStage() {
  checking.container = null; checking.qrStop = null;
  stopAuto();
  if (checking.step === 'top') { resetSteps(); startShoot(); return; }
  renderQr();
  if (checking.live) startQr();
}
function renderQr() {
  const p = checking.product, use = needQr(), wait = waitingQr(), stop = checking.qrStop;
  $('#containerBar').hidden = !use;
  if (use) {
    $('#containerNo').innerHTML = checking.container ? `容器No. <b>${fmtNo(checking.container)}</b>` : `① 容器の QR を読んでください（${esc(kindName(p.kind))}）`;
    $('#btnQrReset').hidden = !checking.container;
    $('#btnQrManual').hidden = !!checking.container;
  }
  const qs = $('#qrStop');
  qs.hidden = !stop;
  if (stop) {
    qs.className = 'qr-stop ' + stop.type;
    $('#qrStopMsg').innerHTML = stop.type === 'kind'
      ? `<b>設定していない品種です</b>読んだ容器：${fmtNo(stop.n.no)}（${esc(kindName(stop.n.kind))}）<br>この製品：${esc(kindName(p.kind))}`
      : `<b>この容器はチェック済みです</b>${fmtNo(stop.n.no)} ／ ${hhmm(stop.done.at)} に${stop.done.verdict === 'pass' ? '合格' : '不合格'}`;
    $('#btnQrAgain').hidden = stop.type !== 'dup';
    $('#liveStatus').hidden = true;
  }
  // QR を読むまでは、ラベルの判定に使うもの（見本の重ね・撮影ボタンなど）を出さない
  const img = stepImage();
  $('#ghost').hidden = wait || !img;
  $('#ghostCtl').hidden = wait || !img || !checking.live;
  $('#btnShutter').hidden = wait || !checking.live;
  $('#btnPhoto').textContent = wait ? 'QR を撮影' : 'カメラで撮影';
  $('#btnPick').querySelector('b').textContent = wait ? '保存した写真から QR を読む' : '保存した写真で判定する';
  $('#topGuide').hidden = wait || checking.step !== 'top';
  renderSteps();
  $('#shootHint').textContent = stop ? '' : wait
    ? (checking.live ? '容器の QR を写してください。読み取ると「ピッ」と鳴ります。' : '「QR を撮影」で容器の QR を撮ってください。')
    : shootHint();
}
// 撮影の画面の説明（今の段階に合わせる）
function shootHint() {
  const p = checking.product;
  if (checking.step === 'top') return checking.live
    ? '真上から、キャップを緑の枠いっぱいに合わせてください。自動で判定します。決まらないときは「撮影」を押してください。'
    : '真上から、キャップとつばが写真いっぱいに写るように撮ってください。';
  const side = topReady(p) ? '横から、' : '';
  if (!checking.live) return `${side}見本と同じ向き・距離で撮ってください。`;
  return methodOf(p) === 'color' ? `${side}ラベルを写すと、自動で判定します。決まらないときは「撮影」を押してください。` : '容器を写して、撮影してください。';
}
// 横 → 真上 の段階の表示（真上の設定がある製品だけ）
function renderSteps() {
  const p = checking.product, el = $('#stepBar');
  el.hidden = !topReady(p) || waitingQr() || !!checking.qrStop;
  if (el.hidden) return;
  const top = checking.step === 'top';
  el.innerHTML = `<span class="${top ? 'done' : 'on'}">${top ? '✓ ' : ''}横から（ラベル）</span><span class="arrow">→</span><span class="${top ? 'on' : ''}">真上から（キャップ）</span>` +
    (top ? '<button class="btn" type="button" data-side-again>横から撮り直す</button>' : '');
}
$('#stepBar').addEventListener('click', e => {
  if (!e.target.closest('[data-side-again]')) return;
  resetSteps(); startShoot();
});
$('#btnQrReset').addEventListener('click', startQrStage);
$('#btnQrNext').addEventListener('click', startQrStage);
$('#btnQrAgain').addEventListener('click', () => { if (checking.qrStop) setContainer(checking.qrStop.n.no); });
$('#btnQrManual').addEventListener('click', () => {
  const t = prompt('容器No.（QR の下の 8 文字。例：E2000460）を入れてください。');
  if (t == null) return;
  if (!acceptNo(t)) showError('容器No. として読めません。品種 2 文字＋番号 6 桁の 8 文字で入れてください（例：E2000460）。');
});

/* ---------- ② 撮影 ---------- */
// test：見本の編集の「判定を試す」から来たとき（保存前の見本で判定する）
// step：'side'（横から。目印でラベルを判定）→ 'top'（真上から。オーバーキャップ。真上の設定がある製品で、横が合格したとき）
// sideRes：横の判定結果（真上へ進んだとき）、topShot・topRes：真上の写真と判定結果
const checking = { product: null, shot: null, aligned: false, test: false, ar: 0.75, auto: null, token: 0, step: 'side', sideRes: null, topShot: null, topRes: null };
let stream = null;
function resetSteps() { checking.step = 'side'; checking.sideRes = null; checking.topShot = null; checking.topRes = null; }
const stepImage = () => checking.step === 'top' ? checking.product.top.image : checking.product.image;

async function startShoot() {
  const p = checking.product; if (!p) { showView('list'); return; }
  if (checking.step === 'top' && !topReady(p)) resetSteps();
  const top = checking.step === 'top', img = stepImage();
  $('#title').textContent = checking.test ? '判定を試す' : p.name;
  const stage = $('#stage');
  // 枠の縦横比を見本に合わせる（見本が無ければ 3:4）
  let ar = 0.75;
  if (img) ar = await imageAr(img);
  checking.ar = ar;
  stage.style.setProperty('--ar', ar);
  $('#ghostImg').src = img || '';
  $('#ghost').hidden = !img;
  $('#ghostCtl').hidden = !img;
  if (top) $('#ghostMarks').innerHTML = '';
  else drawMarks($('#ghostMarks'), methodOf(p) ? p.color.areas : [], null, methodOf(p) ? p.color.anchor.box : null);
  const g = ColorJudge.TOP_GUIDE;
  Object.assign($('#topGuide').style, { left: g.x * 100 + '%', top: g.y * 100 + '%', width: g.w * 100 + '%', height: g.h * 100 + '%' });
  applyOpacity();

  rollDay();
  // 横 → 真上に進むときは、カメラを止めずにそのまま使う（iPhone でカメラを開き直すと時間がかかるため）
  stopAuto(); stopQr();
  const live = top && stream ? true : await startCamera();
  checking.live = live;
  if (live && !waitingQr()) startAuto();
  if (live && waitingQr() && !checking.qrStop) startQr();
  $('#btnShutter').hidden = !live;
  $('#btnPhoto').hidden = live;
  $('#video').hidden = !live;
  const msg = $('#stageMsg');
  if (live) {
    msg.hidden = true;
  } else {
    // カメラを画面に映せないとき（https でない場合など）は、見本を表示して撮影ボタンで撮る
    $('#ghost').style.opacity = 1;
    $('#ghostCtl').hidden = true;
    msg.hidden = !!img;
    msg.textContent = 'この開き方ではカメラを画面に映せません。下の「カメラで撮影」から撮ってください。';
  }
  renderQr();
}
async function startCamera() {
  stopCamera();
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false,
    });
    if (current !== 'shoot') { stopCamera(); return false; }
    const v = $('#video');
    v.srcObject = stream;
    await v.play().catch(() => {});
    return true;
  } catch (e) {
    stream = null;
    if (e && e.name === 'NotAllowedError') showError('カメラの使用が許可されていません。ブラウザの設定でカメラを許可してください。');
    return false;
  }
}
function stopCamera() {
  stopAuto();
  stopQr();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('#video').srcObject = null;
}
function applyOpacity() { $('#ghost').style.opacity = $('#ghostOpacity').value / 100; }
$('#ghostOpacity').addEventListener('input', applyOpacity);

// 画面に映っている範囲（枠の縦横比）だけを切り出す → 見本と同じ構図になる
function frameCrop(v) {
  const ar = parseFloat(getComputedStyle($('#stage')).getPropertyValue('--ar')) || 0.75;
  let w = v.videoWidth, h = v.videoHeight;
  if (w / h > ar) w = h * ar; else h = w / ar;
  return { x: (v.videoWidth - w) / 2, y: (v.videoHeight - h) / 2, w, h };
}
$('#btnShutter').addEventListener('click', () => {
  const v = $('#video');
  if (!v.videoWidth) { showError('カメラの準備ができていません。少し待ってからもう一度押してください。'); return; }
  stopAuto();
  judgeStep(toJpeg(v, 1280, frameCrop(v)));
});
// 撮影ボタン・保存した写真：今の段階（横／真上）で判定して、次へ進む
async function judgeStep(shot) {
  const p = checking.product, st = $('#liveStatus');
  st.hidden = false; st.textContent = '判定しています…';
  try {
    if (checking.step === 'top') topDecided(shot, await ColorJudge.judgeTop(shot, p.top));
    else sideDecided(shot, await ColorJudge.judge(shot, p.color));
  } catch (e) {
    showError('判定できませんでした：' + e.message);
    if (checking.live && current === 'shoot') startAuto();
  }
}
// 横の判定が決まった：合格で真上の設定があれば真上へ、それ以外は結果へ
function sideDecided(shot, r) {
  checking.shot = shot; checking.aligned = true;
  if (r.verdict === 'pass' && topReady(checking.product)) {
    checking.sideRes = r; checking.step = 'top'; checking.topShot = null; checking.topRes = null;
    play('read');
    if (current !== 'shoot') { history.replaceState({ v: 'shoot' }, ''); showView('shoot'); }
    startShoot();
    return;
  }
  openCheck(r); // 決めた映像の判定結果をそのまま使う（撮り直して判定し直すと、結果が変わることがあるため）
}
function topDecided(shot, r) {
  checking.topShot = shot; checking.topRes = r;
  openCheck(checking.sideRes);
}

/* 自動判定（色で判定で、カメラを画面に映しているとき）
   映像を AUTO_EVERY ミリ秒おきに判定し、同じ結果（場所ごとのあり・なしまで同じ）が続いたら、その映像で決める。
   写す途中のぶれた・半分だけ写った映像で決めないよう、合格は AUTO_PASS 回、不合格は AUTO_FAIL 回続けて同じときだけ決める
   （不合格の取り違えのほうが作業を止めるので、少し長く見る）。「判定できない」は数えない
   真上の段階：横から真上へカメラを動かす途中の景色で決めないよう、始めの AUTO_TOP_WAIT ミリ秒は決めず、不合格は AUTO_TOP_FAIL 回続けて決める */
const AUTO_EVERY = 300, AUTO_PASS = 3, AUTO_FAIL = 5, AUTO_TOP_FAIL = 8, AUTO_TOP_WAIT = 1000;
const auto = { timer: 0, busy: false, hist: [], since: 0 };
function startAuto() {
  stopAuto();
  if (methodOf(checking.product) !== 'color') return;
  $('#liveStatus').hidden = false;
  $('#liveStatus').textContent = checking.step === 'top' ? 'キャップを緑の枠いっぱいに合わせてください…' : '目印（例：黄色い楕円）を探しています…';
  auto.since = Date.now();
  auto.timer = setInterval(autoTick, AUTO_EVERY);
}
function stopAuto() {
  clearInterval(auto.timer); auto.timer = 0; auto.hist = [];
  $('#liveMarks').innerHTML = '';
  $('#liveStatus').hidden = true;
}
function frameCanvas(v, max) {
  const r = frameCrop(v), k = Math.min(1, max / Math.max(r.w, r.h));
  const c = document.createElement('canvas');
  c.width = Math.round(r.w * k); c.height = Math.round(r.h * k);
  c.getContext('2d').drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}
async function autoTick() {
  if (auto.busy) return;
  if (current !== 'shoot' || !stream) { stopAuto(); return; }
  const v = $('#video'); if (!v.videoWidth) return;
  auto.busy = true;
  try {
    const p = checking.product, c = frameCanvas(v, 1280), top = checking.step === 'top';
    const r = top ? await ColorJudge.judgeTop(c, p.top) : await ColorJudge.judge(c, p.color);
    if (!auto.timer) return; // 判定している間に画面が変わった
    if (!top) drawMarks($('#liveMarks'), r.anchorBox ? r.areas.map(a => a.box) : [], r.areas.map(a => a.verdict), r.anchorBox || null);
    const sig = r.verdict === 'unsure' ? '' : top ? r.verdict : r.verdict + ':' + r.areas.map(a => a.verdict).join(',');
    auto.hist.push(sig);
    if (auto.hist.length > AUTO_TOP_FAIL) auto.hist.shift();
    let n = 0; for (let i = auto.hist.length - 1; i >= 0 && auto.hist[i] === sig; i--) n++;
    $('#liveStatus').textContent = r.why === 'noanchor' ? '目印（例：黄色い楕円）を探しています…'
      : top && r.why === 'shape' ? 'キャップの形・大きさが見本と違います。真上から、キャップを緑の枠いっぱいに合わせてください。'
      : !sig ? (top ? 'はっきりしません。真上から、キャップを緑の枠いっぱいに合わせてください。' : 'はっきりしません。目印と判定する場所がはっきり写るようにしてください。')
      : '判定しています…そのまま動かさないでください。';
    const need = r.verdict === 'pass' ? AUTO_PASS : top ? AUTO_TOP_FAIL : AUTO_FAIL;
    if (sig && n >= need && !(top && Date.now() - auto.since < AUTO_TOP_WAIT)) {
      stopAuto();
      const shot = c.toDataURL('image/jpeg', 0.82);
      if (top) topDecided(shot, r); else sideDecided(shot, r);
    }
  } catch (e) {
    // 1 回うまくいかなくても、次の映像で判定し直す
  } finally { auto.busy = false; }
}

/* 判定の知らせ
   合格：高い音「ピロン」・画面を緑に光らせる・短く振動
   不合格：低い音「ブッブー」・画面を赤く光らせる・長めに 2 回振動（合格と聞き分けられるように）
   iPhone の Safari は、画面のタップのあとでないと音を出せないため、タップのたびに音の準備をしておく。
   ※ iPhone の消音モードのときは、音が出ないことがある（ブラウザの中で音を作る方法のため）
   振動は、ブラウザから振動できる端末（Android など）だけ（iPhone の Safari は振動できない） */
const SOUNDS = {
  read: { wave: 'sine', vol: 0.35, tones: [[1760, 0, 0.09]] },                         // QR を読んだ「ピッ」
  pass: { wave: 'sine', vol: 0.4, tones: [[880, 0, 0.2], [1320, 0.12, 0.2]] },         // [周波数, 始まり（秒）, 長さ（秒）]
  fail: { wave: 'square', vol: 0.15, tones: [[220, 0, 0.22], [220, 0.3, 0.38]] },
};
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { audioCtx = null; }
}
['touchend', 'click'].forEach(t => document.addEventListener(t, unlockAudio, { passive: true }));
function notify(verdict) {
  if (verdict !== 'pass' && verdict !== 'fail') return; // 判定できないときは知らせない
  if (navigator.vibrate) navigator.vibrate(verdict === 'pass' ? 200 : [300, 150, 300]);
  const f = $('#flash');
  f.className = 'flash'; void f.offsetWidth; f.className = 'flash on ' + verdict;
  play(verdict);
}
function play(name) {
  if (!audioCtx) return;
  const sd = SOUNDS[name], t = audioCtx.currentTime;
  sd.tones.forEach(([hz, dt, dur]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = sd.wave; o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(sd.vol, t + dt + 0.01);
    if (sd.wave === 'square') g.gain.setValueAtTime(sd.vol, t + dt + dur - 0.02); // ブザーは同じ大きさで鳴らし続ける
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + dt); o.stop(t + dt + dur + 0.02);
  });
}

$('#btnPhoto').addEventListener('click', () => $('#photoInput').click());
$('#btnPick').addEventListener('click', () => $('#pickInput').click());
['#photoInput', '#pickInput'].forEach(sel => $(sel).addEventListener('change', () => {
  const f = $(sel).files[0]; $(sel).value = '';
  if (f) usePhotoFile(f);
}));
// 撮った写真・保存してある写真で判定する（パソコンで試すときは、スマホで撮った写真を選ぶかドロップする）
async function usePhotoFile(f) {
  if (!f.type.startsWith('image/')) { showError('写真（画像）のファイルを選んでください。'); return; }
  if (waitingQr()) {
    if (current !== 'shoot') return;
    try {
      const t = await readQrFromFile(f);
      if (!t) showError('写真から QR を読み取れませんでした。QR を大きく、はっきり写してください。');
      else if (!acceptNo(t)) showError(`容器No. ではない QR です（${t.slice(0, 20)}）。`);
    } catch (e) { showError(e.message); }
    return;
  }
  if (current === 'check') resetSteps(); // 結果の画面に写真を落としたら、新しい容器として横から
  stopCamera();
  try { await judgeStep(await fileToJpeg(f, 1280)); } // 目印を探すので切り出さない
  catch (e) { showError(e.message); }
}

/* ---------- ③ 結果 ---------- */
// pre：自動判定で決めたときの判定結果（その映像で判定し直さない）
function openCheck(pre) {
  const p = checking.product;
  checking.auto = null;
  checking.countState = null; checking.noCount = false;
  // 撮影 → 結果は「戻る」で撮影へ戻れるよう、履歴を置き換える
  history.replaceState({ v: 'check' }, '');
  showView('check');
  if (checking.test) $('#title').textContent = '判定を試す';
  if (pre) {
    checking.auto = pre;
    notify(finalVerdict(pre));
  } else if (methodOf(p) && checking.shot) {
    checking.auto = 'pending';
    const token = ++checking.token;
    ColorJudge.judge(checking.shot, p.color)
      .catch(e => ({ verdict: 'unsure', why: 'error', message: e.message, areas: [] }))
      .then(r => { if (token === checking.token) { checking.auto = r; renderCheck(); notify(r.verdict); } });
  }
  renderCheck();
}
// 横の判定と真上の判定を合わせた結果（真上は、横が合格して真上まで撮ったときだけ）
function finalVerdict(side) {
  const t = checking.topRes;
  return side && side.verdict === 'pass' && t ? t.verdict : side ? side.verdict : 'unsure';
}
function renderCheck() {
  const p = checking.product, method = methodOf(p);
  const useAuto = !!method && !!checking.shot;
  const auto = useAuto && checking.auto && checking.auto !== 'pending' ? checking.auto : null;
  const top = auto && auto.verdict === 'pass' ? checking.topRes : null, fin = auto ? finalVerdict(auto) : null;
  // 真上の写真（見本と並べる。枠の四角を判定の色で描く）
  $('#compareTop').hidden = !(top && checking.topShot);
  if (top && checking.topShot) {
    $('#cmpTopSample').src = p.top.image;
    $('#cmpTopShot').src = checking.topShot;
    drawGuide($('#cmpTopSampleMarks'));
    drawGuide($('#cmpTopShotMarks'), top.verdict);
  }
  const areas = method ? p.color.areas : [];
  const states = auto ? areas.map((_, i) => auto.areas[i] ? auto.areas[i].verdict : 'unsure') : null;
  $('#cmpSample').src = p.image || '';
  $('#cmpSample').closest('figure').hidden = !p.image;
  $('#cmpShotFig').hidden = !checking.shot;
  if (checking.shot) $('#cmpShot').src = checking.shot;
  $('#compare').classList.toggle('single', !p.image || !checking.shot);
  $('#compare').hidden = !p.image && !checking.shot;
  drawMarks($('#cmpSampleMarks'), areas, null, method ? p.color.anchor.box : null);
  // 撮影写真の四角は、目印から求めた場所に描く
  if (checking.aligned && auto && auto.anchorBox) drawMarks($('#cmpShotMarks'), auto.areas.map(r => r.box), states, auto.anchorBox);
  else $('#cmpShotMarks').innerHTML = '';

  // 試しの判定では、場所ごとの判定の数字も見せる
  const sc = $('#score');
  sc.hidden = !(checking.test && auto && auto.areas.length);
  const topRow = !top ? '' : top.ratio == null
    ? `<div class="score-row"><b>${TOP_NAME}</b>：見本の真上の写真でキャップが見つからないため、判定できません</div>`
    : `<div class="score-row"><b>${TOP_NAME}</b>　グレーのかたまり 枠の ${Math.round(top.ratio * 100)}%（見本 ${Math.round(top.base * 100)}% の ${Math.round(top.ratio / top.base * 100)}%。` +
      `${Math.round(top.on * 1000) / 10}%以上で「あり」、${Math.round(top.off * 1000) / 10}%以下で「なし」）${top.why === 'shape' ? '<br>※ 形・大きさが見本のキャップと違うため「判定できません」' : ''}
        <div class="bar top-bar"><i style="left:${Math.min(100, top.ratio / top.base * 100)}%"></i></div></div>`;
  if (!sc.hidden) {
    sc.innerHTML = `色の量（見本での量の ${Math.round(ColorJudge.ON * 100)}%以上で「あり」、${Math.round(ColorJudge.OFF * 100)}%以下で「なし」。グレーのキャップは、その行に書いた大きさ）` +
      auto.areas.map((ar, i) => {
        const name = esc(areaName(areas[i], i)), base = ar.base * 100;
        if (ar.kind === 'gray') {
          if (ar.ratio == null) return `<div class="score-row"><b>${name}</b>：見本で、囲んだ範囲にキャップが見つからないため、判定できません</div>`;
          return `<div class="score-row"><b>${name}</b>　グレーのかたまり 目印の ${ar.ratio.toFixed(2)} 倍（見本 ${ar.base.toFixed(2)} 倍。${ColorJudge.GRAY_ON} 倍以上で「あり」、${ColorJudge.GRAY_OFF} 倍以下で「なし」）${ar.why === 'out' ? '（写真の外にはみ出し）' : ''}
            <div class="bar gray-bar"><i style="left:${Math.min(100, ar.ratio * 100)}%"></i></div></div>`;
        }
        if (ar.kind === 'smooth') {
          if (ar.ratio == null) return `<div class="score-row"><b>${name}</b>：見本でこの場所がなめらかではないため、判定できません</div>`;
          return `<div class="score-row"><b>${name}</b>　なめらか ${Math.round(ar.ratio * 100)}%（見本 ${Math.round(ar.base * 100)}%。${Math.round(ColorJudge.SMOOTH_ON * 100)}%以上で「あり」、${Math.round(ColorJudge.SMOOTH_OFF * 100)}%以下で「なし」）${ar.why === 'out' ? '（写真の外にはみ出し）' : ''}
            <div class="bar smooth-bar"><i style="left:${Math.min(100, ar.ratio * 100)}%"></i></div></div>`;
        }
        if (ar.ratio == null) return `<div class="score-row"><b>${name}</b>：見本でこの色がほとんど無いため、判定できません</div>`;
        const pct = Math.min(100, ar.ratio / Math.max(ar.base, 1e-6) * 100); // 見本での量を 100 としたときの量
        return `<div class="score-row"><b>${name}</b>　${(ar.ratio * 100).toFixed(2)}%（見本 ${base.toFixed(2)}% の ${Math.round(ar.ratio / Math.max(ar.base, 1e-6) * 100)}%）${ar.why === 'out' ? '（写真の外にはみ出し）' : ''}
          <div class="bar color-bar"><i style="left:${pct}%"></i></div></div>`;
      }).join('') + topRow +
      '<div class="scale color-scale"><span>なし</span><span>判定できない</span><span>あり（見本の量）</span></div>';
  }
  $('#btnNext').textContent = checking.test ? 'もう一度試す' : '次の容器へ';
  $('#btnRetake').hidden = checking.test;
  $('#btnEndTry').hidden = !checking.test;

  const r = $('#result');
  r.hidden = false;
  if (!method) {
    r.className = 'result wait'; r.innerHTML = '<div class="r-big">自動判定の設定がありません</div><div class="r-sub">「見本の登録」で、この製品の自動判定を設定してください。</div>';
  } else if (!checking.shot) {
    r.className = 'result wait'; r.innerHTML = '<div class="r-big">撮影してください</div><div class="r-sub">「撮り直す」から撮影してください。</div>';
  } else if (!auto) {
    r.className = 'result wait'; r.innerHTML = '<div class="r-big">判定中…</div>';
  } else if (top && fin === 'fail') {
    r.className = 'result fail';
    r.innerHTML = `<div class="r-big">不合格</div><div class="r-sub">ない場所：${TOP_NAME}</div>`;
  } else if (top && fin === 'unsure') {
    r.className = 'result unsure';
    r.innerHTML = `<div class="r-big">判定できません</div><div class="r-sub">${TOP_NAME}：${top.why === 'nobase' ? '見本の真上の写真でキャップが見つかっていません（見本の登録を見直してください）' : top.why === 'shape' ? 'グレーの物の形・大きさが、見本のキャップと違います（キャップが緑の枠に合っていないか、キャップ以外の物が写っています）' : 'はっきりしません'}<br>「撮り直す」で、横からもう一度撮ってください。</div>`;
  } else if (auto.verdict === 'fail') {
    r.className = 'result fail';
    r.innerHTML = `<div class="r-big">不合格</div><div class="r-sub">${areas.length > 1 ? 'ない場所：' + namesWith(areas, auto, 'fail') : 'ラベルが貼られていません。'}</div>`;
  } else if (auto.verdict === 'unsure') {
    r.className = 'result unsure'; r.innerHTML = `<div class="r-big">判定できません</div><div class="r-sub">${unsureText(areas, auto)}</div>`;
  } else {
    const n = areas.length + (top ? 1 : 0);
    r.className = 'result pass';
    r.innerHTML = `<div class="r-big">合格</div><div class="r-sub">${n > 1 ? `すべての場所（${n} か所${top ? '。真上のキャップを含む' : ''}）が OK です。` : 'ラベルがあります。'}</div>`;
  }
  if (checking.container) r.insertAdjacentHTML('afterbegin', `<div class="r-no">容器No. ${fmtNo(checking.container)}</div>`);
  syncCount(r.classList.contains('pass') ? 'pass' : r.classList.contains('fail') ? 'fail' : null);
}
// 判定がある場所の名前を並べる（例：①充シール、③Lot）
const namesWith = (areas, auto, verdict) => esc(areas.map((a, i) => auto.areas[i] && auto.areas[i].verdict === verdict ? areaName(a, i) : '').filter(Boolean).join('、'));
function unsureText(areas, auto) {
  if (auto.why === 'error') return esc(`判定できませんでした（${auto.message}）。撮り直してください。`);
  if (auto.why === 'noanchor') return '目印が見つかりません。目印（例：黄色い楕円）全体がはっきり写るように撮り直してください。';
  const WHY = { mid: 'はっきりしません', out: '写真の外にはみ出しています（容器全体が写るように）', nobase: '見本でこの場所の色・キャップが見つかっていません（見本の登録を見直してください）',
    same: '目印と同じ色を測る設定になっています（見本の登録で「囲み直す」をしてください）' };
  const lines = auto.areas.map((r, i) => r.verdict === 'unsure' ? `${areas.length > 1 ? areaName(areas[i], i) + '：' : ''}${WHY[r.why] || ''}` : '').filter(Boolean);
  return esc(lines.join(' ／ ')) + '<br>目印と判定する場所がはっきり写るように撮り直してください。';
}
// next：次の容器へ（容器の QR から読み直す）。撮り直すは同じ容器のまま
function retake(next) {
  if (next === true) { checking.container = null; checking.qrStop = null; }
  resetSteps();
  history.replaceState({ v: 'shoot' }, ''); showView('shoot'); startShoot();
}
$('#btnNext').addEventListener('click', () => retake(true));
$('#btnRetake').addEventListener('click', () => retake(false));
$('#btnEndTry').addEventListener('click', back);

// 拡大表示
['#compare', '#compareTop'].forEach(sel => $(sel).addEventListener('click', e => {
  const pic = e.target.closest('.pic'); if (!pic) return;
  $('#zoomImg').src = pic.querySelector('img').src;
  $('#zoomMarks').innerHTML = pic.querySelector('.marks').innerHTML;
  $('#zoom').hidden = false;
}));
$('#zoom').addEventListener('click', () => { $('#zoom').hidden = true; });

/* ---------- ④ 見本の登録（一覧・ファイル） ---------- */
function renderAdmin() {
  $('#adminList').innerHTML = data.products.length
    ? sortedProducts().map(p => productButton(p, `data-id="${p.id}"`)).join('')
    : '<div class="empty">まだ登録がありません。「＋ 製品を追加」から登録してください。</div>';
}
$('#btnAdmin').addEventListener('click', () => { go('admin'); renderAdmin(); });
$('#adminList').addEventListener('click', e => {
  const b = e.target.closest('.product'); if (!b) return;
  const p = data.products.find(x => x.id === b.dataset.id);
  if (p) openEdit(p);
});
$('#btnNewProduct').addEventListener('click', () => openEdit(null));

$('#btnExport').addEventListener('click', () => {
  if (!data.products.length) { showError('書き出す見本がありません。'); return; }
  download(DATA_FILE, JSON.stringify(data), 'application/json');
  showInfo(`「${DATA_FILE}」に書き出しました（${data.products.length} 製品）。`);
});
// 配布用：アプリのフォルダに置くと、開いた時点で見本が入っている
$('#btnExportBundle').addEventListener('click', () => {
  if (!data.products.length) { showError('書き出す見本がありません。'); return; }
  download(BUNDLE_FILE, '// 包装チェックアプリの見本データ（アプリの画面「配布用に書き出す」で作成。手で編集しない）\nwindow.MIHON_DATA = ' + JSON.stringify(data) + ';\n', 'text/javascript');
  showInfo(`「${BUNDLE_FILE}」に書き出しました（${data.products.length} 製品）。アプリのフォルダの同じ名前のファイルと置き換えて配布してください。`);
});

async function importFile(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { showError('ファイルを読めませんでした。見本データのファイル（.json）を選んでください。'); return; }
  if (!validData(d)) { showError('このファイルは包装チェックアプリの見本データではありません。'); return; }
  if (data.products.length && !confirm(`今の見本（${data.products.length} 製品）を、ファイルの内容（${d.products.length} 製品）に置き換えます。よろしいですか？`)) return;
  data = Object.assign(emptyData(), d);
  await store.save(data);
  renderAdmin(); renderList();
  showInfo(`見本データを読み込みました（${data.products.length} 製品）。`);
}
AppKit.fileDrop({
  input: $('#importInput'), clickTargets: [$('#btnImport')],
  onFile: f => {
    if (current === 'edit' && f.type.startsWith('image/')) setEditPhoto(f); // 編集中に画像を落としたら見本写真に
    else if ((current === 'shoot' || current === 'check') && f.type.startsWith('image/')) usePhotoFile(f); // 撮影・結果の画面なら、その写真で判定
    else importFile(f);
  },
});

/* ---------- ⑤ 見本の編集 ---------- */
// areaIdx：囲んでいる途中の場所の番号（新しく足すときは場所の数と同じ）、pickAnchor：目印をタップで選んでいる途中
const editing = { p: null, isNew: false, areaIdx: null, pickAnchor: false, drawStart: null, dirty: false };
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function openEdit(p) {
  editing.isNew = !p;
  editing.p = p ? JSON.parse(JSON.stringify(p)) : { id: newId(), name: '', code: '', image: '' };
  editing.p.color = Object.assign({ anchor: null, areas: [] }, editing.p.color);
  if (editing.p.top && !editing.p.top.image) delete editing.p.top;
  // 前の版で登録した真上の見本（キャップの形が無い・枠の大きさが違う）は、今の枠で測り直す
  if (editing.p.top && editing.p.top.v !== ColorJudge.TOP_VERSION) {
    const t = editing.p.top;
    t.remeasured = true;
    ColorJudge.measureTop(t.image).then(m => { if (editing.p.top === t) { Object.assign(t, m); editing.dirty = true; renderTop(); } });
  }
  // 20261028-4 までの「なめらかさ」の場所は、グレーのキャップに変えて測り直す
  editing.p.color.areas.forEach(a => { if (a.look === 'smooth') { a.look = 'gray'; delete a.fitv; } });
  editing.areaIdx = null; editing.pickAnchor = false; editing.drawStart = null; editing.dirty = false;
  $('#edName').value = editing.p.name;
  $('#edCode').value = editing.p.code || '';
  $('#edKind').innerHTML = '<option value="">使わない（容器の QR を読まない）</option>' +
    Object.keys(KINDS).map(k => `<option value="${k}">${esc(kindName(k))}</option>`).join('') +
    (editing.p.kind && !KINDS[editing.p.kind] ? `<option value="${esc(editing.p.kind)}">${esc(editing.p.kind)}</option>` : '');
  $('#edKind').value = editing.p.kind || '';
  $('#btnDelete').hidden = editing.isNew;
  go('edit');
  renderEdit();
  // 前の版の測り方で決めた場所は、今の測り方で測り直す（目印があるときだけ。保存すると今の測り方の場所になる）
  const old = editing.p.color.anchor && editing.p.image ? editing.p.color.areas.filter(a => a.fitv !== ColorJudge.FIT_VERSION) : [];
  if (old.length) {
    Promise.all(old.map(a => measureColorArea(a))).then(() => {
      editing.dirty = true;
      showInfo('自動判定の場所を、新しい測り方で測り直しました。「判定を試す」で確かめてから保存してください。');
    });
  }
}
function renderEdit() {
  const p = editing.p;
  $('#edPic').hidden = !p.image;
  $('#edPicEmpty').hidden = !!p.image;
  if (p.image) $('#edPic').src = p.image;
  drawColorMarks();
  renderTop();
  $('#edPicWrap').classList.toggle('marking', editing.pickAnchor);
  $('#edPicWrap').classList.toggle('drawing', editing.areaIdx != null);
  const hint = $('#edMarkHint');
  hint.hidden = editing.areaIdx == null && !editing.pickAnchor;
  if (editing.pickAnchor) hint.textContent = '見本写真の、いつも貼ってある鮮やかな色の部分（例：黄色い楕円のふち）をタップしてください。';
  if (editing.areaIdx != null) hint.textContent = `見本写真の上を指でなぞって、判定する場所 ${editing.areaIdx + 1} を囲んでください（例：赤い充シール、白い Lot 枠、キャップが写る口の上の広い範囲）。`;
  renderColor();
}
$('#edName').addEventListener('input', () => { editing.dirty = true; });
$('#edCode').addEventListener('input', () => { editing.dirty = true; });
$('#edKind').addEventListener('change', () => { editing.dirty = true; });
function startArea(i) {
  editing.areaIdx = editing.areaIdx === i ? null : i; editing.pickAnchor = false; // 囲んでいる途中にもう一度押すとやめる
  renderEdit();
  if (editing.areaIdx != null) $('#edPicWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 見本写真の上を指でなぞって四角を描く
function picPoint(e) {
  const r = $('#edPic').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
function rectOf(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
$('#edPicWrap').addEventListener('pointerdown', e => {
  if (editing.areaIdx == null || !editing.p.image) return;
  e.stopPropagation();
  e.preventDefault();
  $('#edPicWrap').setPointerCapture(e.pointerId);
  editing.drawStart = picPoint(e);
});
$('#edPicWrap').addEventListener('pointermove', e => {
  if (!editing.drawStart) return;
  const preview = editing.p.color.areas.slice();
  preview[editing.areaIdx] = rectOf(editing.drawStart, picPoint(e));
  drawColorMarks(preview);
});
$('#edPicWrap').addEventListener('pointerup', e => {
  if (!editing.drawStart) return;
  const a = rectOf(editing.drawStart, picPoint(e));
  editing.drawStart = null;
  if (a.w < 0.03 || a.h < 0.03) { showError('四角が小さすぎます。見たい場所を指でなぞって囲んでください。'); renderEdit(); return; }
  const areas = editing.p.color.areas, idx = editing.areaIdx, old = areas[idx];
  // 囲んだ四角は drawn に残しておき、測り直すときに使う。見るもの（look）は囲み直しても変えない
  areas[idx] = Object.assign({}, a, { name: old ? old.name : '', drawn: a }, old && old.look ? { look: old.look } : {});
  editing.areaIdx = null; editing.dirty = true;
  measureColorArea(areas[idx]);
  renderEdit();
});

$('#edPicWrap').addEventListener('click', async e => {
  if (!editing.pickAnchor || !editing.p.image) return;
  const pt = picPoint(e);
  editing.pickAnchor = false;
  const r = await ColorJudge.pickAnchor(editing.p.image, pt.x, pt.y);
  if (r.error) showError(r.error);
  else { editing.p.color.anchor = r; editing.dirty = true; editing.p.color.areas.forEach(a => measureColorArea(a)); } // 目印の色は場所の色に選ばないため、測り直す
  renderEdit();
});
$('#btnEdPhoto').addEventListener('click', () => $('#edPhotoInput').click());
$('#edPhotoInput').addEventListener('change', () => {
  const f = $('#edPhotoInput').files[0]; $('#edPhotoInput').value = '';
  if (f) setEditPhoto(f);
});
async function setEditPhoto(f) {
  try {
    const had = editing.p.image && editing.p.color.areas.length;
    editing.p.image = await fileToJpeg(f, 1280);
    editing.dirty = true;
    // 目印は選び直してもらい、場所は新しい写真で測り直す（目印を選んだときに測る）
    editing.p.color.anchor = null;
    editing.p.color.areas.forEach(a => { a.color = null; });
    renderEdit();
    if (had) showInfo('写真を変えました。目印を選び直してください。判定する場所の四角がずれていたら、囲み直してください。');
  } catch (e) { showError(e.message); }
}
// ---- 自動判定の設定 ----
function drawColorMarks(preview) {
  const c = editing.p.color, el = $('#edColorMarks');
  if (!c) { el.innerHTML = ''; return; }
  drawMarks(el, preview || c.areas, null, c.anchor ? c.anchor.box : null);
}
// 囲んだ四角（drawn）で、場所の見るものを測る
//   色：目印と違う色のうちいちばん多い色を測り、場所の四角はその色のある部分に合わせて小さくする
//   グレーのキャップ：囲んだ四角のまま、いちばん大きいグレーのかたまりの大きさを測る
// （v20261027-1 で登録した場所には drawn が無いので、その場所の四角のまま測る）
async function measureColorArea(a) {
  if (!editing.p.image) return;
  const drawn = a.drawn || { x: a.x, y: a.y, w: a.w, h: a.h };
  a.drawn = drawn;
  if (a.look === 'gray') {
    Object.assign(a, drawn);
    a.color = editing.p.color.anchor ? await ColorJudge.measureGray(editing.p.image, drawn, editing.p.color.anchor) : null;
    a.fitv = ColorJudge.FIT_VERSION;
    renderEdit();
    return;
  }
  const c = await ColorJudge.measureArea(editing.p.image, drawn, editing.p.color.anchor);
  if (c.fit) Object.assign(a, c.fit);
  delete c.fit;
  a.color = c; a.fitv = ColorJudge.FIT_VERSION;
  renderEdit();
}
// 色合い（度）を、だいたいの色の名前にする
const colorName = h => h < 15 || h >= 335 ? '赤' : h < 40 ? 'だいだい' : h < 70 ? '黄' : h < 165 ? '緑' : h < 195 ? '水色' : h < 255 ? '青' : h < 295 ? '紫' : 'ピンク';
const swatch = c => c && c.base ? `<span class="swatch" style="background:hsl(${Math.round(c.h)},${Math.round(Math.min(1, c.s) * 100)}%,45%)"></span>` : '<span class="swatch none"></span>';
let colorStatusToken = 0;
function renderColor() {
  const p = editing.p, c = p.color;
  const an = $('#cjAnchorInfo');
  an.innerHTML = c.anchor ? `${swatch({ h: c.anchor.h, s: c.anchor.s, base: 1 })} 目印を選びました（見本写真の「目印」の枠）` : '';
  const ba = $('#btnCjAnchor');
  ba.disabled = !p.image;
  ba.classList.toggle('on', editing.pickAnchor);
  ba.textContent = editing.pickAnchor ? '選ぶのをやめる' : c.anchor ? '目印を選び直す' : '目印をタップして選ぶ';
  $('#cjAreaList').innerHTML = c.areas.map((a, i) => {
    const on = editing.areaIdx === i;
    const gray = a.look === 'gray';
    const amount = !a.color ? '測っています…' : gray ? `グレー ${a.color.base.toFixed(2)}倍`
      : `${a.color.base ? colorName(a.color.h) + ' ' : ''}${(a.color.base * 100).toFixed(1)}%`;
    // スマホの幅でも押しやすいよう 2 段にする（上：番号・名前・量／下：見るもの・囲み直す・削除）
    return `<li class="area-row c-row${on ? ' on' : ''}" data-i="${i}">
      <span class="area-no c">${i + 1}</span>${gray ? '<span class="swatch smooth"></span>' : swatch(a.color)}
      <input type="text" value="${esc(a.name || '')}" placeholder="名前（任意）例：充シール">
      <small class="amount" title="見本でのこの色の量・キャップの大きさ（目印の何倍か）">${amount}</small>
      <div class="row2">
        <label class="look">見るもの <select data-look="${i}"><option value="color"${gray ? '' : ' selected'}>色</option><option value="gray"${gray ? ' selected' : ''}>グレーのキャップ</option></select></label>
        <button data-redo="${i}">${on ? 'やめる' : '囲み直す'}</button>
        <button class="del" data-adel="${i}">削除</button>
      </div>
    </li>`;
  }).join('');
  const bb = $('#btnCjArea'), adding = editing.areaIdx === c.areas.length;
  bb.disabled = !p.image || !c.anchor; // 目印の色を場所の色に選ばないため、目印を先に選ぶ
  bb.classList.toggle('on', adding);
  bb.textContent = adding ? '囲むのをやめる' : c.areas.length ? '＋ 場所を追加して囲む' : '判定する場所を囲む';
  $('#btnCjTry').disabled = !colorReady(p);

  const st = $('#cjStatus');
  const lack = [!p.image && '見本の写真', !c.anchor && '目印', !c.areas.length && '判定する場所'].filter(Boolean);
  if (!c.anchor && !c.areas.length) { st.className = 'auto-status warn'; st.textContent = '自動判定には「目印」と「判定する場所」が必要です。'; return; }
  if (lack.length) { st.className = 'auto-status warn'; st.textContent = `自動判定には、あと「${lack.join('」「')}」が必要です。`; return; }
  const few = c.areas.map((a, i) => a.color && !a.color.kind && a.color.base < ColorJudge.MIN_BASE ? areaName(a, i) : '').filter(Boolean);
  const nocap = c.areas.map((a, i) => a.color && a.color.kind === 'gray' && a.color.base < ColorJudge.GRAY_MIN ? areaName(a, i) : '').filter(Boolean);
  // 目印と同じ色（例：黄色の映り込み）が場所の色になっていると、ラベルが無くても「あり」になりやすい（v20261027-1 で登録した場所）
  const same = c.areas.map((a, i) => a.color && !a.color.kind && a.color.base && ColorJudge.hueDist(a.color.h, c.anchor.h) <= ColorJudge.AVOID_TOL ? areaName(a, i) : '').filter(Boolean);
  if (same.length) { st.className = 'auto-status warn'; st.textContent = `目印と同じ色が、場所の色として選ばれています：${same.join('、')}。「囲み直す」で囲み直してください。`; return; }
  if (nocap.length) { st.className = 'auto-status warn'; st.textContent = `グレーのキャップで見る場所に、見本の写真でキャップが見つかりません：${nocap.join('、')}。キャップ全体が入るように、口の上を広めに囲み直してください。`; return; }
  if (few.length) { st.className = 'auto-status warn'; st.textContent = `色がほとんど無い場所があります：${few.join('、')}。はっきりした色（赤・青など）がある部分を囲み直してください。灰色のオーバーキャップは、その場所の「見るもの」を「グレーのキャップ」にしてください。`; return; }
  if (!colorReady(p)) { st.className = 'auto-status'; st.textContent = '場所の色を測っています…'; return; }
  st.className = 'auto-status ok';
  st.textContent = `自動判定の準備ができました（${c.areas.length} か所）。「判定を試す」で確かめてください。`;
}
$('#btnCjAnchor').addEventListener('click', () => {
  editing.pickAnchor = !editing.pickAnchor; editing.areaIdx = null;
  renderEdit();
  if (editing.pickAnchor) $('#edPicWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#btnCjArea').addEventListener('click', () => startArea(editing.p.color.areas.length));
$('#cjAreaList').addEventListener('click', e => {
  const redo = e.target.closest('[data-redo]'), del = e.target.closest('[data-adel]');
  if (redo) startArea(+redo.dataset.redo);
  if (del) { editing.p.color.areas.splice(+del.dataset.adel, 1); editing.areaIdx = null; editing.dirty = true; renderEdit(); }
});
$('#cjAreaList').addEventListener('change', e => {
  const sel = e.target.closest('[data-look]'); if (!sel) return;
  const a = editing.p.color.areas[+sel.dataset.look];
  if (sel.value === 'gray') a.look = 'gray'; else delete a.look;
  a.color = null; editing.dirty = true;
  renderEdit();
  measureColorArea(a);
});
$('#cjAreaList').addEventListener('input', e => {
  if (e.target.closest('[data-look]')) return;
  const li = e.target.closest('.area-row'); if (!li) return;
  editing.p.color.areas[+li.dataset.i].name = e.target.value.trim(); editing.dirty = true;
});
$('#btnCjTry').addEventListener('click', () => {
  if (!colorReady(editing.p)) return;
  checking.product = editing.p; checking.test = true;
  resetSteps();
  go('shoot'); startShoot();
});

// ---- 真上から撮る写真（オーバーキャップ） ----
function renderTop() {
  const t = editing.p.top, el = $('#topStatus');
  $('#edTopPic').hidden = !t;
  $('#edTopEmpty').hidden = !!t;
  $('#btnEdTopDel').hidden = !t;
  $('#btnEdTop').textContent = t ? '真上の写真を撮り直す・選び直す' : '真上の写真を撮る・選ぶ';
  if (t) { $('#edTopPic').src = t.image; drawGuide($('#edTopMarks')); } else $('#edTopMarks').innerHTML = '';
  if (!t) { el.className = 'auto-status'; el.textContent = '真上の写真がないときは、横から撮るだけで判定します。'; return; }
  if (t.base == null) { el.className = 'auto-status'; el.textContent = 'キャップを測っています…'; return; }
  if (!(t.base >= ColorJudge.TOP_MIN)) {
    el.className = 'auto-status warn';
    el.textContent = `緑の枠の中にキャップが見つかりません（グレーのかたまり 枠の ${Math.round(t.base * 100)}%）。キャップが付いた容器を、キャップとつばが緑の枠いっぱいに収まる距離で、真上から撮り直してください。`;
    return;
  }
  if (t.touch > ColorJudge.TOP_TOUCH) {
    el.className = 'auto-status warn';
    el.textContent = 'キャップが緑の枠からはみ出しています（または、キャップのまわりもグレーです）。少し離れて、キャップ全体が枠の中に入るように真上から撮り直してください。';
    return;
  }
  if (t.remeasured) {
    el.className = 'auto-status warn';
    el.textContent = '緑の枠を大きくしました（キャップに近づいて撮れるように）。この真上の写真は前の枠に合わせて撮ったものなので、キャップとつばが緑の枠いっぱいに収まる距離で撮り直してください。';
    return;
  }
  const sideCap = editing.p.color.areas.some(a => a.look === 'gray');
  el.className = 'auto-status ' + (sideCap ? 'warn' : 'ok');
  el.textContent = `キャップが見つかりました（グレーのかたまり 枠の ${Math.round(t.base * 100)}%）。横の判定が合格したあと、真上から撮って判定します。` +
    (sideCap ? '横の「判定する場所」にも「グレーのキャップ」があります。真上で見るなら、横のその場所は削除してください（残すと、横と真上の両方で判定します）。' : '');
}
$('#btnEdTop').addEventListener('click', () => $('#edTopInput').click());
$('#edTopInput').addEventListener('change', async () => {
  const f = $('#edTopInput').files[0]; $('#edTopInput').value = '';
  if (!f) return;
  try {
    const image = await fileToJpeg(f, 1280);
    const t = editing.p.top = { image, base: null }; editing.dirty = true; // remeasured は付けない（今の枠で撮った写真）
    renderTop();
    Object.assign(t, await ColorJudge.measureTop(image));
    renderTop();
  } catch (e) { showError(e.message); }
});
$('#btnEdTopDel').addEventListener('click', () => {
  if (!confirm('真上の写真を外しますか？（真上からのキャップの判定をしなくなります）')) return;
  delete editing.p.top; editing.dirty = true;
  renderTop();
});

$('#btnSave').addEventListener('click', async () => {
  const p = editing.p;
  p.name = $('#edName').value.trim();
  p.code = $('#edCode').value.trim();
  p.kind = $('#edKind').value;
  if (p.top) delete p.top.remeasured; // 画面の注意のためだけの印なので保存しない
  delete p.items; delete p.auto; // 20261028-4 までの「目視で確認する項目」「見本と見比べて判定」の設定は使わないので消す
  if (!p.name) { showError('製品名を入れてください。'); $('#edName').focus(); return; }
  if (!colorReady(p)) { showError('自動判定の設定（見本の写真・目印・判定する場所）を入れてください。'); renderEdit(); return; }
  if (p.top && !topReady(p)) { showError('真上の写真でキャップがうまく見つかりません。真上の写真を撮り直すか、「真上の写真を外す」を押してください。'); renderTop(); return; }
  if (data.products.some(x => x.id !== p.id && x.name === p.name)) { showError('同じ製品名がすでに登録されています。'); return; }
  p.updatedAt = new Date().toISOString();
  const i = data.products.findIndex(x => x.id === p.id);
  if (i >= 0) data.products[i] = p; else data.products.push(p);
  try { await saveData(); } catch (e) { return; }
  editing.dirty = false;
  pendingInfo = `「${p.name}」を保存しました。`;
  back();
});
$('#btnDelete').addEventListener('click', async () => {
  const p = editing.p;
  if (!confirm(`「${p.name}」の見本を削除します。よろしいですか？`)) return;
  data.products = data.products.filter(x => x.id !== p.id);
  try { await saveData(); } catch (e) { return; }
  editing.dirty = false;
  back();
});

/* ---------- 起動 ---------- */
$('#btnBack').addEventListener('click', back);
$('#appVersion').textContent = 'v' + APP_VERSION;

/* ---------- 新しい版の確認 ----------
   置き場（https）の index.html を、手元の控えを使わずに読み直して版を比べる（アプリを開いたとき・ほかのアプリから戻ったとき）。
   新しい版があれば：製品の一覧の画面なら、すぐ読み込み直す。チェックや見本の編集の途中なら、お知らせを出して、押したら読み込み直す。
   cache: 'reload' で読むと、iPhone の控えも新しい index.html に置き換わるので、読み込み直すと新しい版になる。
   同じ版のために 2 回以上は自動で読み込み直さない（置き場の更新が届いていないときに、読み込み直しをくり返さないため）。
   ファイルを直接開いたときなど、読めないときは何もしない */
async function checkUpdate() {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  try {
    const html = await (await fetch('index.html', { cache: 'reload' })).text();
    const m = /<meta name="app-version" content="([^"]+)"/.exec(html);
    if (!m || m[1] === APP_VERSION) return;
    let tried = '';
    try { tried = sessionStorage.getItem('housou-reloaded-for') || ''; } catch (e) { /* 読めなくても続ける */ }
    if (current === 'list' && tried !== m[1]) {
      try { sessionStorage.setItem('housou-reloaded-for', m[1]); } catch (e) { /* 保存できなくても続ける */ }
      location.reload();
      return;
    }
    showInfo(`新しい版（v${m[1]}）があります。このお知らせを押すと読み込み直します（チェックの途中なら、終わってから押してください）。`);
    // ほかのお知らせに変わったあとは押しても読み込み直さない
    $('#infoBanner span').onclick = e => { if (e.currentTarget.textContent.startsWith('新しい版')) location.reload(); };
  } catch (e) { /* 通信できないときは、今の版のまま使う */ }
}
checkUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
$('#kitVersion').textContent = AppKit.VERSION;

// アプリに同梱した 見本データ.js（window.MIHON_DATA）が手元より新しければ使う。
// <script> で読むので、https でもファイルを直接開いても読める
async function loadBundledData() {
  const d = window.MIHON_DATA;
  if (!validData(d) || (d.updatedAt || '') <= (data.updatedAt || '')) return;
  const first = !data.products.length;
  data = Object.assign(emptyData(), d);
  renderList();
  try { await store.save(data); } catch (e) { /* 保存できなくても、同梱データで使える */ }
  if (!first) showInfo(`最新の見本データに更新しました（${data.products.length} 製品）。`);
}

(async () => {
  history.replaceState({ v: 'list' }, '');
  try {
    const d = await store.load();
    if (validData(d)) data = Object.assign(emptyData(), d);
  } catch (e) {
    if (!validData(window.MIHON_DATA)) showError('このブラウザでは見本を保存できません（プライベートブラウズでは使えません）：' + e.message);
  }
  await loadBundledData();
  renderList();
})();
