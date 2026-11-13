/* Large-player trial: same media node, owner-requested Savoye prototype only. */
(() => {
'use strict';
const $=id=>document.getElementById(id),panel=$('concept-animation'),video=$('concept-animation-video'),summary=$('concept-animation-summary'),close=$('concept-animation-close'),error=$('concept-animation-error'),enlarge=$('concept-animation-enlarge');
if(!panel||!video||!summary||!close||!enlarge)return;
const home=document.createComment('concept-video-home');video.before(home);
const modal=document.createElement('dialog');modal.id='concept-animation-modal';modal.setAttribute('aria-labelledby','concept-modal-title');
modal.innerHTML='<div id="concept-modal-shell"><header class="concept-modal-toolbar"><h2 id="concept-modal-title"></h2><button type="button" id="concept-modal-fullscreen">全螢幕</button><button type="button" id="concept-modal-close" autofocus>關閉動畫，返回導覽</button></header><div id="concept-modal-stage"></div><p id="concept-modal-help">按播放鍵開始；字幕可由播放器選單開啟。關閉後回到原本的 3D 導覽位置。</p><p id="concept-modal-status" role="status"></p></div>';
document.body.append(modal);
const shell=$('concept-modal-shell'),stage=$('concept-modal-stage'),exit=$('concept-modal-close'),full=$('concept-modal-fullscreen'),status=$('concept-modal-status');
$('concept-modal-title').textContent=$('concept-animation-title').textContent;
let opener=null,oldOverflow='',opening=false;
const captionsOff=()=>{for(const track of Array.from(video.textTracks||[]))track.mode='disabled';};captionsOff();video.addEventListener('loadedmetadata',captionsOff,{once:true});
const signal=open=>window.dispatchEvent(new CustomEvent('architecture-concept-modal',{detail:{open}}));
const restore=()=>{if(!opening)return;opening=false;video.pause();home.after(video);document.documentElement.style.overflow=oldOverflow;signal(false);enlarge.setAttribute('aria-expanded','false');(opener?.isConnected?opener:enlarge).focus({preventScroll:true});};
const dismiss=async()=>{video.pause();if(document.fullscreenElement&&shell.contains(document.fullscreenElement)){try{await document.exitFullscreen();}catch{}}if(modal.open)modal.close();else restore();};
enlarge.addEventListener('click',()=>{if(opening)return;opener=document.activeElement;oldOverflow=document.documentElement.style.overflow;video.pause();if(document.pointerLockElement&&document.exitPointerLock)document.exitPointerLock();signal(true);stage.append(video);opening=true;status.textContent='';document.documentElement.style.overflow='hidden';try{modal.showModal();}catch{modal.setAttribute('open','');modal.setAttribute('aria-modal','true');}enlarge.setAttribute('aria-expanded','true');exit.focus({preventScroll:true});});
exit.addEventListener('click',dismiss);modal.addEventListener('close',restore);modal.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
full.addEventListener('click',async()=>{try{if(document.fullscreenElement===shell){await document.exitFullscreen();}else if(shell.requestFullscreen){await shell.requestFullscreen();}else if(video.webkitEnterFullscreen){video.webkitEnterFullscreen();}else{status.textContent='此瀏覽器使用滿版視窗觀看；可隨時關閉返回導覽。';}}catch{status.textContent='此瀏覽器使用滿版視窗觀看；可隨時關閉返回導覽。';}});
document.addEventListener('fullscreenchange',()=>{full.textContent=document.fullscreenElement===shell?'離開全螢幕':'全螢幕';});
modal.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'&&!document.fullscreenElement){e.preventDefault();dismiss();}});
for(const name of ['pointerdown','pointermove','pointerup','click','wheel','touchstart','touchmove'])modal.addEventListener(name,e=>e.stopPropagation());
const collapse=()=>{video.pause();panel.open=false;summary.focus({preventScroll:true});};close.addEventListener('click',collapse);panel.addEventListener('toggle',()=>{if(!panel.open)video.pause();});
panel.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'&&panel.open&&document.fullscreenElement!==video){e.preventDefault();collapse();}});
video.addEventListener('error',()=>{if(error)error.hidden=false;status.textContent='影片暫時無法播放，請稍後再試。';});window.addEventListener('pagehide',()=>video.pause());
})();
