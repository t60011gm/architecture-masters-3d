# 25 Architecture Masters — 3D Teaching Websites

Backup of the existing public collection at https://architecture-tours-25-v2.jackylin.chatgpt.site and all 25 linked material-and-lighting edition work sites.

Each website is backed up under `sites/<original-slug>/dist/`. Serve an individual `dist` folder with any static HTTP server. The original navigation retains its live links; `index.html` provides a local backup index. No build is required. WebGL/WebGPU requirements and graceful fallbacks remain as implemented in each site.

`site-sources.json` records exact saved versions and source commits. `backup-manifest.json` records original source file checksums; `github-snapshot-manifest.json` records this GitHub runtime edition. Hosting identity, credentials, Git history and internal QA records are excluded. Original live sites and URLs are unchanged.

## Rights and scope
This is an educational backup, not a blanket open-source license. Original source/accuracy descriptions and all bundled third-party library license files are preserved. Architectural works, research references and any third-party assets retain their respective rights. No new license is imposed.

## 自動分段模型載入

七個大型 GLB 以 10 MB 分段保存。進入個別作品頁面後，瀏覽器依序下載該模型的分段，自動合併並驗證 SHA-256，再交給原有 GLTFLoader。WebGL 與 WebGPU 兩條載入流程均已接上，不須手動還原。其他十八個模型維持原單檔。原正式網站不變。

在儲存庫根目錄執行 `python3 -m http.server 8000`，開啟 http://localhost:8000 ，由本地導覽進入作品。也可單獨服務各 `dist/`，務必包含其中的 `backup-parts/` 和 `model-parts.json`。SHA-256 需要 HTTPS 或 localhost，不能直接使用 file://。分段不減少總下載量或模型解析度；合併需要額外記憶體。

需要獨立 GLB 時，可選擇執行 `python3 restore-large-files.py`，還原時會核對長度和 SHA-256。`node test-split-models.mjs` 可重跑七個模型的位元組重組、相對路徑與載入器介面測試。測試未包含實際 GPU 渲染：雲端 Chromium 啟動受系統 socket 權限限制。
