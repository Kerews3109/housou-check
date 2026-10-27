'use strict';

/* ============================================================
   色で判定（ColorJudge）
   ・いつもある「目印」（例：黄色い SANTOKU の楕円）を色で探し、その位置・大きさを基準にする
   ・判定する場所（四角）は、目印に対する位置で覚えておく → 手持ちで角度・距離が変わっても、目印に合わせて正しい場所を測れる
   ・場所ごとに「決めた色」（例：充シールの赤、Lotシールの印刷の青）がどれだけあるかを測り、
     見本での量に比べて十分あれば「あり」、ほとんど無ければ「なし」、その間は「判定できない」
   スマホの中だけで計算し、写真はどこにも送らない。
   ============================================================ */

const ColorJudge = (() => {
  const W = 400;              // 計算用に縮めた写真の幅（px）
  const ON = 0.3;             // 見本での色の量のこの割合以上あれば「あり」
  const OFF = 0.1;            // この割合以下なら「なし」（間は判定できない）
  const MIN_BASE = 0.002;     // 見本での色の量がこれ未満の場所は、色が少なすぎて判定に使えない
  const HUE_TOL = 15;         // 色合いの許す幅（度）
  const MIN_ANCHOR = 0.002;   // 目印として見るかたまりの大きさの下限（写真に対する割合）
  const OUT_MAX = 0.4;        // 場所の四角がこれ以上写真の外にはみ出したら判定できない
  const AVOID_TOL = 30;       // 場所の色を決めるとき、目印の色合いからこの幅（度）の色は選ばない
  const FIT_VERSION = 3;      // 場所の四角の決め方の版（変えたら上げる。アプリは見本の編集を開いたときに測り直す）
  const FIT_MARGIN = 0.1;     // 場所の四角のまわりに、少なくとも目印の幅・高さのこの割合の余白をとる
  const FIT_PAD = 0.25;       // 場所の四角を色のある部分に合わせて小さくするとき、まわりに足す余白（色のある部分の大きさに対する割合）

  const cache = new Map();
  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めませんでした')); i.src = src; });
  }
  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx / 255];
  }
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  // 写真を縮めて、点ごとの色合い・鮮やかさ・明るさにする
  // src：写真（data URL）か、カメラの映像を描いた canvas（自動判定。毎回違う絵なので覚えておかない）
  async function prep(src) {
    const isUrl = typeof src === 'string', key = isUrl ? src.length + ':' + src.slice(-80) : null;
    if (isUrl && cache.has(key)) return cache.get(key);
    const img = isUrl ? await loadImg(src) : src;
    const H = Math.max(1, Math.round(W * (img.naturalHeight || img.height) / (img.naturalWidth || img.width)));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const hh = new Float32Array(W * H), ss = new Float32Array(W * H), vv = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { const [a, b, d] = hsv(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); hh[i] = a; ss[i] = b; vv[i] = d; }
    const P = { W, H, hh, ss, vv };
    if (!isUrl) return P;
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    cache.set(key, P);
    return P;
  }

  // 色 { h, s, v } に合う点かどうか（見本の色より少しくすんでいても合うようにする）
  // strict：目印を探すとき。背景の映り込み（同じ色合いでくすんだもの）とつながらないよう、鮮やかさ・明るさをきびしく見る
  function matcher(c, strict) {
    const s0 = strict ? Math.max(0.35, c.s * 0.7) : Math.max(0.25, c.s * 0.5);
    const v0 = strict ? Math.max(0.3, c.v * 0.6) : Math.max(0.2, c.v * 0.45);
    return (P, i) => P.ss[i] >= s0 && P.vv[i] >= v0 && hueDist(P.hh[i], c.h) <= HUE_TOL;
  }

  // 色の合う点のかたまり（つながっている点）を探す。lab：点ごとのかたまり番号
  function components(P, ok) {
    const { W: w, H: h } = P, lab = new Int32Array(w * h).fill(-1), comps = [];
    for (let i = 0; i < w * h; i++) {
      if (lab[i] >= 0 || !ok(P, i)) continue;
      const id = comps.length, st = [i]; lab[i] = id;
      let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      while (st.length) {
        const k = st.pop(), x = k % w, y = (k / w) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && lab[k - 1] < 0 && ok(P, k - 1)) { lab[k - 1] = id; st.push(k - 1); }
        if (x < w - 1 && lab[k + 1] < 0 && ok(P, k + 1)) { lab[k + 1] = id; st.push(k + 1); }
        if (y > 0 && lab[k - w] < 0 && ok(P, k - w)) { lab[k - w] = id; st.push(k - w); }
        if (y < h - 1 && lab[k + w] < 0 && ok(P, k + w)) { lab[k + w] = id; st.push(k + w); }
      }
      comps.push({ id, n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return { lab, comps };
  }
  // かたまりの形：縦横比、埋まり具合、真ん中が同じ色で埋まっている割合（楕円のふちなら小さい）
  function shape(P, lab, o) {
    let inner = 0, cnt = 0;
    for (let y = Math.round(o.y0 + o.h * 0.35); y < o.y0 + o.h * 0.65; y++)
      for (let x = Math.round(o.x0 + o.w * 0.35); x < o.x0 + o.w * 0.65; x++) { cnt++; if (lab[y * P.W + x] === o.id) inner++; }
    return { ar: o.w / o.h, fill: o.n / (o.w * o.h), inner: inner / Math.max(1, cnt) };
  }

  /* 目印を選ぶ：見本の写真の (fx, fy)（0〜1）をタップした場所の色のかたまりを目印にする
     戻り値：{ h, s, v, box（0〜1）, ar, fill, inner } または { error } */
  async function pickAnchor(src, fx, fy) {
    const P = await prep(src);
    const cx = Math.round(fx * (P.W - 1)), cy = Math.round(fy * (P.H - 1));
    // タップした場所のまわり 5×5 の色の平均（色合いは角度なので向きで平均する）
    let sx = 0, sy = 0, s = 0, v = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= P.W || y >= P.H) continue;
      const i = y * P.W + x; sx += Math.cos(P.hh[i] * Math.PI / 180); sy += Math.sin(P.hh[i] * Math.PI / 180); s += P.ss[i]; v += P.vv[i]; n++;
    }
    const color = { h: (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360, s: s / n, v: v / n };
    if (color.s < 0.3 || color.v < 0.25) return { error: 'タップした場所は色がうすい（白・灰色・黒）ため、目印にできません。黄色などの鮮やかな色の部分をタップしてください。' };
    const { lab, comps } = components(P, matcher(color, true));
    // タップした場所（または近く 6 点以内）のかたまり
    let comp = null;
    for (let r = 0; r <= 6 && !comp; r++) for (let y = cy - r; y <= cy + r && !comp; y++) for (let x = cx - r; x <= cx + r && !comp; x++) {
      if (x >= 0 && y >= 0 && x < P.W && y < P.H && lab[y * P.W + x] >= 0) comp = comps[lab[y * P.W + x]];
    }
    if (!comp || comp.n < P.W * P.H * MIN_ANCHOR) return { error: '目印のかたまりが小さすぎます。もっと大きく写っている、いつもある色の部分をタップしてください。' };
    const sh = shape(P, lab, comp);
    return Object.assign(color, sh, { box: { x: comp.x0 / P.W, y: comp.y0 / P.H, w: comp.w / P.W, h: comp.h / P.H } });
  }

  /* 場所の色を決める：見本の写真の四角（0〜1）の中で、いちばん多い鮮やかな色
     avoid：目印の色（あれば）。目印と同じ色合い（例：黄色）は、ステンレスへの映り込みや目印のはみ出しで
            どこにでも出るため、場所の色には選ばない（Lot 枠を大きめに囲むと黄色の映り込みが選ばれていた）
     数は鮮やかさで重みを付ける（くすんだ映り込みより、印刷のはっきりした色を選びやすくする）
     四角は、その色がある部分に合わせて小さくする（fit）。大きく囲むと、撮影写真で隣のラベルの同じ色が入ってしまうため
     戻り値：{ h, s, v, base（見本での色の量 0〜1）, fit（小さくした四角 0〜1） } */
  async function measureArea(src, box, avoid) {
    const P = await prep(src);
    const r = pxBox(P, box), bins = new Float64Array(24), pts = [];
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
      const i = y * P.W + x;
      if (P.ss[i] < 0.35 || P.vv[i] < 0.2 || (avoid && hueDist(P.hh[i], avoid.h) <= AVOID_TOL)) continue;
      bins[Math.floor(P.hh[i] / 15) % 24] += P.ss[i]; pts.push(i);
    }
    let best = 0; for (let b = 1; b < 24; b++) if (bins[b] > bins[best]) best = b;
    if (!bins[best]) return { h: 0, s: 0, v: 0, base: 0 };
    // いちばん多い色合いの近く（±1 区切り）の点の平均
    const hc = best * 15 + 7.5;
    let sx = 0, sy = 0, s = 0, v = 0, n = 0;
    for (const i of pts) if (hueDist(P.hh[i], hc) <= 22.5) { sx += Math.cos(P.hh[i] * Math.PI / 180); sy += Math.sin(P.hh[i] * Math.PI / 180); s += P.ss[i]; v += P.vv[i]; n++; }
    const color = { h: (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360, s: s / n, v: v / n };
    const fit = fitBox(P, r, color, avoid && avoid.box ? avoid : null);
    return Object.assign(color, { base: ratio(P, pxBox(P, fit), color).r, fit });
  }
  /* 四角の中で色の合う点がある範囲（はしの 2% ずつは外れ値として除く）に、まわりの余白を足した四角
     余白：その範囲の FIT_PAD か、目印の大きさの FIT_MARGIN の大きいほう。撮る角度で、目印から場所までの距離が
           目印の高さの 1 割ほど変わるため、そのぶんずれても入るようにする（囲んだ四角より大きくなってもよい）
     範囲は、うすい印刷（文字）も入るよう、ゆるく色合いだけで見る（濃い帯だけに縮まないように） */
  function fitBox(P, r, color, anchor) {
    const ok = (P, i) => P.ss[i] >= 0.2 && P.vv[i] >= 0.2 && hueDist(P.hh[i], color.h) <= HUE_TOL, xs = [], ys = [];
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (ok(P, y * P.W + x)) { xs.push(x); ys.push(y); }
    const whole = { x: r.x0 / P.W, y: r.y0 / P.H, w: (r.x1 - r.x0) / P.W, h: (r.y1 - r.y0) / P.H };
    if (xs.length < 20) return whole;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (a, t) => a[Math.min(a.length - 1, Math.floor(a.length * t))];
    let x0 = q(xs, 0.02), x1 = q(xs, 0.98) + 1, y0 = q(ys, 0.02), y1 = q(ys, 0.98) + 1;
    const mx = anchor ? anchor.box.w * P.W * FIT_MARGIN : 0, my = anchor ? anchor.box.h * P.H * FIT_MARGIN : 0;
    const px = Math.max((x1 - x0) * FIT_PAD, mx), py = Math.max((y1 - y0) * FIT_PAD, my);
    x0 = Math.max(0, x0 - px); x1 = Math.min(P.W, x1 + px); y0 = Math.max(0, y0 - py); y1 = Math.min(P.H, y1 + py);
    return { x: x0 / P.W, y: y0 / P.H, w: (x1 - x0) / P.W, h: (y1 - y0) / P.H };
  }

  function pxBox(P, b) {
    const x0 = Math.round(b.x * P.W), y0 = Math.round(b.y * P.H), x1 = Math.round((b.x + b.w) * P.W), y1 = Math.round((b.y + b.h) * P.H);
    return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(P.W, x1), y1: Math.min(P.H, y1), area: Math.max(1, (x1 - x0) * (y1 - y0)) };
  }
  // 四角の中で色の合う点の割合。out：写真の外にはみ出した割合
  function ratio(P, r, color) {
    const ok = matcher(color);
    let n = 0, t = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { t++; if (ok(P, y * P.W + x)) n++; }
    return { r: n / Math.max(1, t), out: 1 - t / r.area };
  }

  // 撮影写真の中で目印を探す：同じ色のかたまりのうち、形（縦横比・埋まり具合・真ん中）が見本の目印にいちばん近いもの
  function findAnchor(P, a) {
    const { lab, comps } = components(P, matcher(a, true));
    let best = null;
    for (const o of comps) {
      if (o.n < P.W * P.H * MIN_ANCHOR) continue;
      const sh = shape(P, lab, o);
      if (sh.ar < a.ar / 1.5 || sh.ar > a.ar * 1.5 || Math.abs(sh.fill - a.fill) > 0.25 || sh.inner > a.inner + 0.2) continue;
      const score = Math.abs(Math.log(sh.ar / a.ar)) + Math.abs(sh.fill - a.fill) * 2 + Math.abs(sh.inner - a.inner) - Math.log(o.n) * 0.02;
      if (!best || score < best.score) best = { score, x: o.x0 / P.W, y: o.y0 / P.H, w: o.w / P.W, h: o.h / P.H };
    }
    return best;
  }

  /* 判定
     cfg：{ anchor（pickAnchor の結果）, areas: [{ x, y, w, h（見本での四角 0〜1）, h, s, v, base, name }] }
     ※ 場所の色は areas[i].color に入れる（四角の h（高さ）と色合いの h が重なるため）
     戻り値：{ verdict, why, anchorBox（撮影写真での目印 0〜1）, areas: [{ verdict, why, ratio, base, on, off, box }] } */
  async function judge(shot, cfg) {
    const P = await prep(shot);
    const A = findAnchor(P, cfg.anchor);
    if (!A) return { verdict: 'unsure', why: 'noanchor', areas: [] };
    const an = cfg.anchor.box;
    const res = cfg.areas.map(a => {
      // 見本で目印に対してどこにあったかを、撮影写真の目印に当てはめる
      const box = { x: A.x + (a.x - an.x) / an.w * A.w, y: A.y + (a.y - an.y) / an.h * A.h, w: a.w / an.w * A.w, h: a.h / an.h * A.h };
      const base = a.color.base, on = base * ON, off = base * OFF;
      if (base < MIN_BASE) return { verdict: 'unsure', why: 'nobase', ratio: null, base, on, off, box };
      // 目印と同じ色の場所（v20261027-1 で、黄色の映り込みが場所の色に選ばれたもの）は、ラベルが無くても「あり」になりやすいので使わない
      if (hueDist(a.color.h, cfg.anchor.h) <= AVOID_TOL) return { verdict: 'unsure', why: 'same', ratio: null, base, on, off, box };
      const m = ratio(P, pxBox(P, box), a.color);
      if (m.out > OUT_MAX) return { verdict: 'unsure', why: 'out', ratio: m.r, base, on, off, box };
      const verdict = m.r >= on ? 'pass' : m.r <= off ? 'fail' : 'unsure';
      return { verdict, why: verdict === 'pass' ? 'ok' : verdict === 'fail' ? 'missing' : 'mid', ratio: m.r, base, on, off, box };
    });
    const verdict = res.some(r => r.verdict === 'fail') ? 'fail' : res.some(r => r.verdict === 'unsure') ? 'unsure' : 'pass';
    return { verdict, why: verdict, anchorBox: A, areas: res };
  }

  return { pickAnchor, measureArea, judge, hueDist, FIT_VERSION, ON, OFF, MIN_BASE, AVOID_TOL };
})();
