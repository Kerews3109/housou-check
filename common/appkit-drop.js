'use strict';

/* ============================================================
   共通部品：ファイル取込（AppKit.fileDrop）
   ・点線のドロップ枠（.dropzone のボタン）をクリック → ファイル選択
   ・画面のどこにドロップしても取込（入力欄の上でも横取りするため capture で受ける）
   ・ドラッグ中は画面全体に「ここで離すと取り込みます」を表示
   使い方：
     AppKit.fileDrop({ input: <input type=file>, clickTargets: [枠ボタン, ...], onFile: file => { ... } });
   ============================================================ */

AppKit.fileDrop = function ({ input, clickTargets = [], onFile, overlayText = 'ここで離すと取り込みます' }) {
  clickTargets.filter(Boolean).forEach(el => el.addEventListener('click', () => input.click()));
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) onFile(f); });

  // 全画面の表示（HTMLに #dropOverlay が無ければ作る）
  let overlay = document.getElementById('dropOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dropOverlay'; overlay.hidden = true;
    overlay.innerHTML = '<div></div>';
    overlay.firstChild.textContent = overlayText;
    document.body.appendChild(overlay);
  }

  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const setDragging = on => { overlay.hidden = !on; document.body.classList.toggle('dragging', on); };
  let depth = 0;
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; setDragging(true); } }, true);
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } }, true);
  window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }, true);
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); depth = 0; setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) onFile(f);
  }, true);
};
