'use strict';

/* ============================================================
   共通部品：画面の小物（AppKit.ui）
   ・エラー／お知らせのバナー（#errorBanner / #infoBanner、中に <span> と閉じる <button>）
   ・HTMLエスケープ、日付の表示、ファイルのダウンロード
   ※ 共通部品の中で一番最初に読み込むこと
   ============================================================ */

window.AppKit = window.AppKit || {};
AppKit.VERSION = '20261014-1'; // 共通部品を直したら更新（YYYYMMDD-通番）

AppKit.ui = (() => {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');

  function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function fmtDateTime(s) { const d = new Date(s); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

  function banner(id, m) {
    const b = document.getElementById(id);
    if (!b) { alert(m); return; }
    b.querySelector('span').textContent = m;
    b.hidden = false;
  }
  const showError = m => banner('errorBanner', m);
  const showInfo = m => banner('infoBanner', m);
  function hideBanners() { ['errorBanner', 'infoBanner'].forEach(id => { const b = document.getElementById(id); if (b) b.hidden = true; }); }
  // バナーの × で閉じる
  document.addEventListener('click', e => { const b = e.target.closest('.banner > button'); if (b) b.parentElement.hidden = true; });

  function download(name, data, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return { $, $$, esc, pad2, todayISO, fmtDateTime, showError, showInfo, hideBanners, download };
})();
