import('./webgpu-viewer.js').catch(error => {
  console.error(error);
  document.documentElement.dataset.modelReady='false';
  document.getElementById('loading').hidden=false;
  document.getElementById('load-label').textContent='模型資料暫時無法載入';
  document.getElementById('load-detail').textContent='請確認網路連線後重試，或更新瀏覽器。外觀預覽仍可參考。';
  document.getElementById('load-progress').hidden=true;
  const retry=document.getElementById('retry');retry.hidden=false;retry.onclick=()=>location.reload();
});
