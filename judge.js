'use strict';

/* ============================================================
   自動判定（Judge）
   撮影した写真の「ラベルの場所（四角）」が、
   「ラベルありの見本」と「ラベルなしの見本」のどちらに近いかで判定する。
   ・写真は小さく縮めてから、四角の中を 16×16 のマスに分け、マスごとの色の平均を比べる
     （明るさと色みに分け、色み（赤・黄・青などの違い）を重く見る）
   ・全体の明るさで割って、明るさの少しの違いをならす
   ・手で持って撮ったときのずれに備え、まず写真全体で容器の位置・大きさをおおまかに合わせ、
     次に場所ごとに「四角の周りの模様」で位置を探し直す（斜めから撮って場所ごとにずれ方が違っても合わせられる）。
     そのうえで四角を少しずらした・大きさを変えた位置も試し、いちばん近いものを使う
   ・どちらとも言えないとき、見本と違いすぎるときは「判定できない」にする（自信のないまま合格にしない）
   スマホの中だけで計算し、写真はどこにも送らない。
   ============================================================ */

const Judge = (() => {
  const WORK_W = 300;          // 計算用に縮めた写真の幅（px）
  const CELLS = 10;            // 四角を何マスに分けるか（縦横）
  // 場所ごとの位置合わせ：四角の「周り」（四角を CTX_E 倍に広げた範囲から、四角の中を除いたところ）の模様で探す。
  // 周りはラベルがあってもなくても同じなので、どちらの見本にも偏らずに位置が決まる。
  // 斜めから撮って場所ごとにずれ方が違っても、場所ごとに合わせるので対応できる
  const CTX_E = 3;             // 周りとして見る範囲（四角の大きさの何倍まで広げるか）
  const CTX_CELLS = 12;        // 周りを見るときのマスの数（縦横）
  const LOCAL = 0.18;          // 場所ごとに探すずれの範囲（写真全体の位置合わせからの、写真の幅・高さに対する割合）
  const LOCAL_SCALE = 0.12;    // 同じく、大きさの範囲（±）
  // 位置が決まったあと、四角の中を比べるときの小さなずれの探し方（狭くする：広いと小さい四角がラベルの外へ逃げる）
  const SHIFT = 0.01;
  const STEP = 0.005;
  const SCALES = [0.97, 1, 1.03];
  const ALIGN_SHIFT = 0.16;    // 写真全体の位置合わせで探すずれの範囲
  const ALIGN_SCALE = 0.16;    // 同じく、大きさの範囲（±）
  const CHROMA = 2;            // 色み（赤み・青み）を明るさの何倍重く見るか
  const TEXTURE = 3;           // 細かい模様（文字・枠）を明るさの何倍重く見るか
  const PASS = 0.7;            // 「ラベルありらしさ」がこれ以上で合格（実物で 65% の誤った合格が出たため 0.6 → 0.7）
  const FAIL = 0.4;            // これ以下で不合格（間は判定できない）
  const FAR = 1.0;             // 見本どうしの違いより、どちらの見本からも遠い → 見本と違いすぎる
  const MIN_REF = 6;           // 見本どうしの違いがこれ未満 → 見分けにくい
  const NG_RATIO = 0.5;        // 場所ごとに使うラベルなしの写真：違いがいちばん大きい写真のこの割合以上の違いがあるもの

  const cache = new Map();

  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めませんでした')); i.src = src; });
  }

  // 写真を縮めて、マスの平均をすぐ出せる形（積分画像）にする。ar を渡すと、その縦横比で中央を切り出す
  async function prep(src, ar) {
    const key = src.length + ':' + src.slice(-80) + ':' + (ar || '');
    if (cache.has(key)) return cache.get(key);
    const img = await loadImg(src);
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (ar) {
      if (sw / sh > ar) { const w = sh * ar; sx = (sw - w) / 2; sw = w; }
      else { const h = sw / ar; sy = (sh - h) / 2; sh = h; }
    }
    const w = WORK_W, h = Math.max(1, Math.round(WORK_W * sh / sw));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;

    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    const gain = 128 / Math.max(1, sum / (w * h));

    // 明るさ（Y）と色み（Cb：青み、Cr：赤み）に分ける。色みは CHROMA 倍して重く見る
    // （反射や影は主に明るさを変え、シールの色の違いは主に色みに出るため）
    // 4 つ目は細かい模様（となりの点との明るさの差）。印刷された文字や枠はここに強く出て、映り込みのなだらかなむらは出にくい
    const Y = new Float32Array(w * h), CB = new Float32Array(w * h), CR = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const R = px[p] * gain, G = px[p + 1] * gain, B = px[p + 2] * gain;
      Y[i] = 0.299 * R + 0.587 * G + 0.114 * B;
      CB[i] = (-0.169 * R - 0.331 * G + 0.5 * B) * CHROMA;
      CR[i] = (0.5 * R - 0.419 * G - 0.081 * B) * CHROMA;
    }
    const W1 = w + 1;
    const ii = [0, 1, 2, 3].map(() => new Float64Array(W1 * (h + 1)));
    for (let y = 0; y < h; y++) {
      const row = [0, 0, 0, 0];
      for (let x = 0; x < w; x++) {
        const i = y * w + x, q = (y + 1) * W1 + (x + 1);
        const tex = (x + 1 < w ? Math.abs(Y[i + 1] - Y[i]) : 0) + (y + 1 < h ? Math.abs(Y[i + w] - Y[i]) : 0);
        const v = [Y[i], CB[i], CR[i], tex * TEXTURE];
        for (let ch = 0; ch < 4; ch++) { row[ch] += v[ch]; ii[ch][q] = ii[ch][q - W1] + row[ch]; }
      }
    }
    const res = { w, h, ii };
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    cache.set(key, res);
    return res;
  }

  // 四角（px）の中を n×n に分けた、マスごとの平均（明るさ・色み 2 つ・細かい模様）の並び。skip(i, j) が真のマスは 0 にする
  function feature(P, x, y, rw, rh, n = CELLS, skip = null) {
    const f = new Float32Array(n * n * 4), W1 = P.w + 1;
    const cw = rw / n, chh = rh / n;
    let k = 0;
    for (let j = 0; j < n; j++) {
      const y0 = clamp(Math.round(y + j * chh), 0, P.h), y1 = clamp(Math.round(y + (j + 1) * chh), y0 + 1, P.h);
      for (let i = 0; i < n; i++) {
        if (skip && skip(i, j)) { k += 4; continue; }
        const x0 = clamp(Math.round(x + i * cw), 0, P.w), x1 = clamp(Math.round(x + (i + 1) * cw), x0 + 1, P.w);
        const cnt = Math.max(1, (x1 - x0) * (y1 - y0));
        for (let ch = 0; ch < 4; ch++) {
          const t = P.ii[ch];
          f[k++] = (t[y1 * W1 + x1] - t[y0 * W1 + x1] - t[y1 * W1 + x0] + t[y0 * W1 + x0]) / cnt;
        }
      }
    }
    return f;
  }
  // 四角の周りの模様（中心 cx, cy、四角の大きさ rw, rh の四角を CTX_E 倍に広げ、四角の中のマスは除く）
  const inner = (i, j) => { const a = CTX_CELLS / CTX_E, b = CTX_CELLS - a; return i >= a - 1e-6 && i < b - 1e-6 && j >= a - 1e-6 && j < b - 1e-6; };
  const ctxFeature = (P, cx, cy, rw, rh) => feature(P, cx - rw * CTX_E / 2, cy - rh * CTX_E / 2, rw * CTX_E, rh * CTX_E, CTX_CELLS, inner);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function dist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
  const areaFeature = (P, A) => feature(P, A.x * P.w, A.y * P.h, A.w * P.w, A.h * P.h);

  // ラベルの場所 1 つ分の見本の特徴。ラベルなしの写真のうち、この場所が「ラベルあり」と見分けられるものだけを使う
  // （場所ごとに別のラベルなしの写真を用意してもよいように：例 写真1＝シールなし、写真2＝Lotラベルなし）
  async function refFeatures(oks, ngs, area) {
    const ok = await Promise.all(oks.map(async s => areaFeature(await prep(s), area)));
    const ngAll = await Promise.all(ngs.map(async s => areaFeature(await prep(s), area)));
    const nearOk = b => Math.min(...ok.map(a => dist(a, b)));
    // 違いがいちばん大きい写真の半分以上の違いがあるものだけを使う（映り込みなどの小さな違いしかない写真は、この場所では使わない）
    const maxNear = Math.max(0, ...ngAll.map(nearOk));
    const ng = ngAll.filter(b => nearOk(b) >= Math.max(MIN_REF, NG_RATIO * maxNear));
    const dRef = ng.length ? Math.min(...ng.map(nearOk)) : Math.max(0, ...ngAll.map(nearOk));
    return { ok, ng, dRef };
  }

  // 見本の確認：場所ごとに、ラベルあり・なしの見本の違いがはっきりしているか
  async function checkSetup(oks, ngs, areas) {
    return Promise.all(areas.map(async a => {
      const r = await refFeatures(oks, ngs, a);
      return { dRef: r.dRef, clear: r.ng.length > 0, ngUsed: r.ng.length };
    }));
  }

  // 写真全体の位置合わせ：写真の中央部分を見本と比べ、容器がどれだけずれ・大きく写っているかを探す
  // 戻り値：{ dx, dy（写真の幅・高さに対する割合）, s（大きさの倍率） }
  async function align(P, srcs) {
    const IN = 0.8; // 比べるのは写真の中央 8 割
    const refs = await Promise.all(srcs.map(async s => { const R = await prep(s); return feature(R, (1 - IN) / 2 * R.w, (1 - IN) / 2 * R.h, IN * R.w, IN * R.h); }));
    let best = { d: Infinity, dx: 0, dy: 0, s: 1 };
    const search = (s0, s1, sStep, x0, x1, y0, y1, step) => {
      for (let s = s0; s <= s1 + 1e-6; s += sStep) {
        const rw = IN * P.w * s, rh = IN * P.h * s;
        for (let dy = y0; dy <= y1 + 1e-6; dy += step) {
          for (let dx = x0; dx <= x1 + 1e-6; dx += step) {
            const f = feature(P, P.w / 2 + dx * P.w - rw / 2, P.h / 2 + dy * P.h - rh / 2, rw, rh);
            for (const r of refs) { const d = dist(f, r); if (d < best.d) best = { d, dx, dy, s }; }
          }
        }
      }
    };
    // 粗く探してから、いちばん合ったところの近くを細かく探す
    search(1 - ALIGN_SCALE, 1 + ALIGN_SCALE, 0.04, -ALIGN_SHIFT, ALIGN_SHIFT, -ALIGN_SHIFT, ALIGN_SHIFT, 0.02);
    const c = best;
    search(c.s - 0.03, c.s + 0.03, 0.01, c.dx - 0.02, c.dx + 0.02, c.dy - 0.02, c.dy + 0.02, 0.005);
    return best;
  }

  // 場所 1 つの位置を、周りの模様で探す。戻り値：{ cx, cy（px）, s（大きさの倍率）, edge（探せる範囲の端だった） }
  async function locate(P, al, srcs, area) {
    const refs = await Promise.all(srcs.map(async src => {
      const R = await prep(src);
      return ctxFeature(R, (area.x + area.w / 2) * R.w, (area.y + area.h / 2) * R.h, area.w * R.w, area.h * R.h);
    }));
    // 写真全体の位置合わせで動かした場所から探しはじめる
    const bx = (0.5 + al.dx + (area.x + area.w / 2 - 0.5) * al.s) * P.w;
    const by = (0.5 + al.dy + (area.y + area.h / 2 - 0.5) * al.s) * P.h;
    let best = { d: Infinity, dx: 0, dy: 0, s: al.s };
    const search = (s0, s1, sStep, x0, x1, y0, y1, step) => {
      for (let s = s0; s <= s1 + 1e-6; s += sStep) {
        const rw = area.w * P.w * s, rh = area.h * P.h * s;
        for (let dy = y0; dy <= y1 + 1e-6; dy += step) {
          for (let dx = x0; dx <= x1 + 1e-6; dx += step) {
            const f = ctxFeature(P, bx + dx * P.w, by + dy * P.h, rw, rh);
            for (const r of refs) { const d = dist(f, r); if (d < best.d) best = { d, dx, dy, s }; }
          }
        }
      }
    };
    // 大きさは「写真全体の位置合わせの値」と「見本と同じ（1）」の両方を含む範囲で探す（全体の値は映り込みで外れることがあるため）
    search(Math.min(1, al.s) * (1 - LOCAL_SCALE), Math.max(1, al.s) * (1 + LOCAL_SCALE), 0.04, -LOCAL, LOCAL, -LOCAL, LOCAL, 0.02);
    const c = best;
    search(c.s - 0.04, c.s + 0.04, 0.01, c.dx - 0.02, c.dx + 0.02, c.dy - 0.02, c.dy + 0.02, 0.005);
    const edge = Math.abs(best.dx) >= LOCAL - 1e-6 || Math.abs(best.dy) >= LOCAL - 1e-6;
    return { cx: bx + best.dx * P.w, cy: by + best.dy * P.h, s: best.s, edge };
  }

  // 場所 1 つの判定。why：'ok'（合格）/ 'missing'（不合格）/ 'far'（見本と違いすぎ）/ 'mid'（どちらとも言えない）/ 'noref'（見本に違いがない）/ 'shift'（位置が見つからない）
  // box：撮影写真の中で見つけた四角（0〜1）
  async function judgeArea(P, al, oks, ngs, area) {
    const refs = await refFeatures(oks, ngs, area);
    if (!refs.ng.length) return { verdict: 'unsure', why: 'noref', score: null, dRef: refs.dRef };
    const loc = await locate(P, al, oks.concat(ngs), area);
    const box = { x: loc.cx / P.w - area.w * loc.s / 2, y: loc.cy / P.h - area.h * loc.s / 2, w: area.w * loc.s, h: area.h * loc.s };
    if (loc.edge) return { verdict: 'unsure', why: 'shift', score: null, dRef: refs.dRef, box };
    let dOk = Infinity, dNg = Infinity;
    const sx = SHIFT * P.w, sy = SHIFT * P.h, st = STEP * Math.max(P.w, P.h);
    for (const s0 of SCALES) {
      const s = s0 * loc.s, rw = area.w * P.w * s, rh = area.h * P.h * s;
      for (let dy = -sy; dy <= sy + 1e-6; dy += st) {
        for (let dx = -sx; dx <= sx + 1e-6; dx += st) {
          const f = feature(P, loc.cx + dx - rw / 2, loc.cy + dy - rh / 2, rw, rh);
          for (const r of refs.ok) dOk = Math.min(dOk, dist(f, r));
          for (const r of refs.ng) dNg = Math.min(dNg, dist(f, r));
        }
      }
    }
    const score = dNg / (dOk + dNg + 1e-9);
    const base = { score, dOk, dNg, dRef: refs.dRef, box };
    if (Math.min(dOk, dNg) > FAR * refs.dRef + MIN_REF) return Object.assign(base, { verdict: 'unsure', why: 'far' });
    if (score >= PASS) return Object.assign(base, { verdict: 'pass', why: 'ok' });
    if (score <= FAIL) return Object.assign(base, { verdict: 'fail', why: 'missing' });
    return Object.assign(base, { verdict: 'unsure', why: 'mid' });
  }

  /* 判定
     shot：撮影した写真（dataURL）、ar：見本の縦横比（撮影写真をこの比で中央から切り出して比べる）
     areas：ラベルの場所（四角）の並び
     戻り値：{ verdict: 'pass'|'fail'|'unsure', why, align, areas: [場所ごとの { verdict, why, score（0〜1、ラベルありらしさ）, dOk, dNg, dRef, box }] }
     全体：どこか 1 つでも不合格なら不合格、それ以外で判定できない場所があれば判定できない、全部合格なら合格 */
  async function judge(shot, ar, oks, ngs, areas) {
    const P = await prep(shot, ar);
    const al = await align(P, oks.concat(ngs));
    const res = [];
    for (const a of areas) res.push(await judgeArea(P, al, oks, ngs, a));
    const verdict = res.some(r => r.verdict === 'fail') ? 'fail' : res.some(r => r.verdict === 'unsure') ? 'unsure' : 'pass';
    return { verdict, why: verdict, align: al, areas: res };
  }

  return { judge, checkSetup, PASS, FAIL };
})();
