import {loadSplitGLTF} from './split-model-loader.mjs';
import { pass, mrt, normalView, builtinAOContext, screenUV, uniform, mix } from 'three/tsl';
import { ao } from './webgpu-vendor/addons/tsl/display/GTAONode.js';
import * as THREE from 'three';
import { OrbitControls } from './webgpu-vendor/OrbitControls.js';
import { GLTFLoader } from './webgpu-vendor/GLTFLoader.js';
import { prepareMaterials, readMaterialPacks } from './webgpu-materials.js';
import { NightLighting } from './night-lighting.js';
import { MeshBVH, acceleratedRaycast, CENTER } from './webgpu-vendor/three-mesh-bvh.module.js';
import { MeshoptDecoder } from './webgpu-vendor/meshopt_decoder.module.js';

const $ = id => document.getElementById(id);
const cfg = await fetch('./config.json').then(r => { if (!r.ok) throw new Error('模型資料讀取失敗'); return r.json(); });
document.title = `${cfg.title}・WebGPU 高畫質試版`;
$('legacy-link').href = cfg.legacyUrl;
const historic = await fetch('./historic-lighting.json').then(r=>{if(!r.ok)throw new Error('照明史料設定讀取失敗');return r.json();});
const catalog = await fetch('./materials.json').then(r=>{if(!r.ok)throw new Error('材質目錄無法讀取');return r.json()});
$('title').textContent = cfg.title;
$('model-number').textContent = String(cfg.number).padStart(2, '0');
$('architect').textContent = cfg.architect;
$('index-link').href = cfg.indexUrl || './';
$('focus').textContent = cfg.focus;
$('dimensions').textContent = cfg.dimensions;
$('uncertainty').textContent = cfg.uncertainty;
$('materials').textContent = cfg.materials;
$('credit').textContent = cfg.credit || '';
$('poster').src = './poster.webp';
$('poster').alt = `${cfg.title}的教育性重建模型外觀`;
for (const src of cfg.sources || []) {
  const li = document.createElement('li'), a = document.createElement('a');
  a.href = src.url; a.textContent = src.title || new URL(src.url).hostname; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); $('sources').append(li);
}

const canvas = $('model-canvas'), viewport = $('viewport');
let renderer, scene, camera, controls, model, bounds, radius = 25, lighting, composer, gtao, aoScene, mirrors, needsRender = true;
let activeStop = -1, ready = false, walking = false, canMove = false, yaw = 0, pitch = 0, pointer = null, quality = 'high';
let colliders = [], keys = new Set(), last = 0, moving = false, toastTimer, lastCollision = 0;
// CONCEPT_MODAL_SUSPENSION_START
let conceptModalOpen = false, conceptControlsEnabled = null;
const conceptActivePointers = new Map();
for (const target of [canvas, ...document.querySelectorAll('[data-move]')]) {
  target.addEventListener('pointerdown', e => conceptActivePointers.set(e.pointerId, target), true);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) target.addEventListener(type, e => conceptActivePointers.delete(e.pointerId), true);
}
window.addEventListener('architecture-concept-modal', event => {
  const next = event.detail?.open === true;
  if (next === conceptModalOpen) return;
  if (next) {
    keys.clear(); pointer = null;
    for (const [id, target] of Array.from(conceptActivePointers)) {
      target.dispatchEvent(new PointerEvent('pointercancel', {pointerId: id, bubbles: true}));
      if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id);
    }
    conceptActivePointers.clear();
    conceptControlsEnabled = controls?.enabled ?? null;
    if (controls) {
      controls.enabled = false;
      // Drain residual orbit damping without changing the visible camera or target.
      if (camera && controls.enableDamping) {
        const position = camera.position.clone(), quaternion = camera.quaternion.clone(), target = controls.target.clone(), zoom = camera.zoom;
        controls.enableDamping = false; controls.update(); controls.enableDamping = true;
        camera.position.copy(position); camera.quaternion.copy(quaternion); camera.zoom = zoom;
        controls.target.copy(target); camera.updateProjectionMatrix();
      }
    }
  } else {
    keys.clear(); pointer = null;
    if (controls && conceptControlsEnabled !== null) controls.enabled = conceptControlsEnabled;
    conceptControlsEnabled = null;
  }
  conceptModalOpen = next; needsRender = true;
});
// CONCEPT_MODAL_SUSPENSION_END
let aoWeight = uniform(0.65);
const touchDevice = matchMedia('(pointer:coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
const raycaster = new THREE.Raycaster(), up = new THREE.Vector3(0,1,0), temp = new THREE.Vector3(), normal = new THREE.Vector3();
const keyMoves = {w:'forward',ArrowUp:'forward',s:'back',ArrowDown:'back',a:'left',ArrowLeft:'left',d:'right',ArrowRight:'right'};
const waypoints = cfg.waypoints || [];
const buttons = [];
$('stop-count').textContent = `${waypoints.length} 個視點`;
waypoints.forEach((w, i) => {
  const b = document.createElement('button'); b.className = 'waypoint'; b.disabled = true; b.setAttribute('aria-pressed','false');
  const n = document.createElement('span'); n.className = 'stop-number'; n.textContent = String(i + 1).padStart(2,'0');
  const t = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small');
  strong.textContent = w.label; small.textContent = w.type === 'interior' ? (w.navigation === 'walk' ? '室內 · 眼高步行' : '室內 · 定點環視') : '外觀 · 自由環繞'; t.append(strong,small); b.append(n,t); b.onclick = () => selectStop(i); buttons.push(b); $('waypoints').append(b);
});
function tell(text) { $('status').textContent = text; $('status').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('status').classList.remove('visible'), 3200); }
function fail(error) { ready=false; if(controls)controls.enabled=false; document.querySelectorAll('#quality,#brightness,#indoor-lights,#reset,#walk,[data-light],[data-move]').forEach(b=>b.disabled=true); if(!document.documentElement.dataset.renderBackend)$('backend-status').textContent='無法啟用圖形後端'; document.documentElement.dataset.modelReady='false'; buttons.forEach(b=>b.disabled=true); console.error(error); $('loading').hidden = false; $('load-label').textContent = '互動模型暫時無法開啟'; $('load-detail').textContent = '此瀏覽器未能初始化圖形後端，或模型載入失敗。請使用更新版瀏覽器，或點選「回到穩定版」。外觀預覽與概念動畫仍可使用。'; $('retry').hidden = false; $('retry').onclick = () => location.reload(); $('load-progress').hidden = true; }

try {
  THREE.ColorManagement.enabled = true;
  renderer = new THREE.WebGPURenderer({canvas, antialias:true, alpha:false, powerPreference:'high-performance', forceWebGL:new URLSearchParams(location.search).get('backend')==='webgl'});
  await renderer.init();
  renderer.onDeviceLost=info=>{ready=false;fail(new Error(info.message||'GPU裝置連線中斷'));};
  const actualBackend = renderer.backend.isWebGPUBackend ? 'WebGPU' : renderer.backend.isWebGLBackend ? 'WebGL 2（備援）' : '未知後端';
  $('backend-status').textContent = actualBackend;
  document.documentElement.dataset.renderBackend=actualBackend;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  scene = new THREE.Scene(); scene.background = new THREE.Color('#cbd9df');
  camera = new THREE.PerspectiveCamera(48,1,.06,2500);
  controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = .075;
  controls.maxPolarAngle = Math.PI*.495; controls.screenSpacePanning = true;
  controls.addEventListener('change', () => needsRender = true);
  lighting = new NightLighting(renderer, scene, catalog, historic);
  new ResizeObserver(resize).observe(viewport); resize();
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, materialPacks] = await Promise.all([
    loadSplitGLTF(loader,'./model.glb',e=>{
      const total=e.total||cfg.bytes, percent=total?Math.min(90,Math.round(e.loaded/total*90)):0;
      $('load-progress').value=percent; $('load-label').textContent=`載入建築 ${percent}%`;
    }),
    readMaterialPacks(renderer,cfg.pbrProfiles||{},catalog),
    lighting.read('daylight')
  ]);
  model = gltf.scene;
  $('load-label').textContent = '建立石材、木紋與玻璃';
  const materials = await prepareMaterials(model, renderer, cfg.pbrProfiles||{}, catalog, materialPacks);
  scene.add(model); lighting.bindModel(model); scene.updateMatrixWorld(true);
  for(const root of [model,lighting.geometry]) root.traverse(o=>{if(o.isMesh&&!o.userData.skipCollision&&o.geometry.attributes.position&&(o.geometry.index?.count??o.geometry.attributes.position.count)>0)colliders.push(o)});
  $('load-label').textContent='準備室內步行';
  const collisionStart=performance.now();
  for(let i=0;i<colliders.length;i++){
    const mesh=colliders[i];
    mesh.geometry.boundsTree=new MeshBVH(mesh.geometry,{strategy:CENTER,targetLeafSize:32,indirect:true});
    mesh.raycast=acceleratedRaycast;
    if(i%4===3)await new Promise(requestAnimationFrame);
  }
  const collision={meshes:colliders.length,buildMs:performance.now()-collisionStart,firstHitOnly:false};
  bounds = new THREE.Box3().setFromObject(model);
  if (cfg.bounds?.min && cfg.bounds?.max) bounds.set(new THREE.Vector3(...cfg.bounds.min),new THREE.Vector3(...cfg.bounds.max));
  const size=bounds.getSize(new THREE.Vector3());radius=Math.max(size.length()/2,8);
  controls.maxDistance=radius*4;controls.minDistance=.8;camera.far=Math.max(1000,radius*15);camera.updateProjectionMatrix();
  lighting.fit(bounds);
  // The normal/depth pass excludes real transparent surfaces, never opaque
  // ceramics or metal glazing bars. Glass therefore cannot become a false wall.
  aoScene = new THREE.Scene();const occluders = model.clone(true);
  occluders.traverse(o=>{if(o.userData.skipAO||o.isLight)o.visible=false});aoScene.add(occluders);
  const supplementaryOccluders=lighting.geometry.clone(true);supplementaryOccluders.traverse(o=>{if(o.userData.skipAO||o.isLight)o.visible=false});aoScene.add(supplementaryOccluders);
  // Use the opaque-only duplicate for AO depth/normals: glass never occludes.
  const prePass = pass(aoScene,camera);
  prePass.setMRT(mrt({output:normalView}));
  gtao = ao(prePass.getTextureNode('depth'),prePass.getTextureNode(),camera);
  gtao.radius.value=.45; gtao.thickness.value=.35; gtao.scale.value=1;
  gtao.samples.value=16; gtao.resolutionScale=.65;
  const scenePass = pass(scene,camera);
  scenePass.contextNode=builtinAOContext(mix(1,gtao.getTextureNode().sample(screenUV).r,aoWeight));
  composer = new THREE.RenderPipeline(renderer);
  composer.outputNode=scenePass;
  ready = true; setQuality('high'); await setLight(historic.defaultPreset||'day'); resetView();
  $('load-label').textContent='完成光影';$('load-progress').value=98;
  await renderer.compileAsync(scene,camera);
  mirrors?.beginFrame();drawFrame(); needsRender=true;requestAnimationFrame(frame);
  buttons.forEach(b=>b.disabled=false);$('indoor-lights').disabled=!lighting.hasLighting;if(!lighting.hasLighting){$('indoor-lights').textContent='無可核實固定室內燈';$('indoor-lights').setAttribute('aria-pressed','false');}$('loading').hidden=true;
  updateQualityLabel();
  document.documentElement.dataset.modelReady='true';
  window.__architectureDiagnostics={version:4,backend:actualBackend,trial:true,threeRevision:THREE.REVISION,materials,lighting:lighting.diagnostics,collision,rendered:true};
  registerTools();
} catch(e) { ready=false; fail(e); }

function resize() {
  if(!renderer)return;
  const w=viewport.clientWidth,h=viewport.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();

  needsRender=true;
}
function updateQualityLabel(){ $('quality-label').textContent=(document.documentElement.dataset.renderBackend||'偵測中')+' · '+(quality==='low'?'流暢':'高畫質'); }
function renderPipelinePreservingState() {
  // RenderPipeline, PassNode and GTAO restore their temporary state only after
  // a successful render. Restore it ourselves before the direct-render fallback.
  const state = THREE.RendererUtils.saveRendererState(renderer);
  const viewportState = renderer.getViewport(new THREE.Vector4());
  const scissorState = renderer.getScissor(new THREE.Vector4());
  const extra = {xr:renderer.xr.enabled, contextNode:renderer.contextNode,
    autoClearColor:renderer.autoClearColor, autoClearDepth:renderer.autoClearDepth,
    autoClearStencil:renderer.autoClearStencil, transparent:renderer.transparent,
    opaque:renderer.opaque, lighting:renderer.lighting, cameraMask:camera.layers.mask};
  const scenes = [scene,aoScene].filter(Boolean).map(value=>({value,name:value.name,
    state:THREE.RendererUtils.saveSceneState(value)}));
  let completed = false;
  try { composer.render(); completed = true; }
  finally {
    if(!completed) {
      THREE.RendererUtils.restoreRendererState(renderer,state);
      renderer.setViewport(viewportState); renderer.setScissor(scissorState);
      renderer.xr.enabled=extra.xr; renderer.contextNode=extra.contextNode;
      for(const key of ['autoClearColor','autoClearDepth','autoClearStencil','transparent','opaque','lighting'])renderer[key]=extra[key];
      camera.layers.mask=extra.cameraMask;
      for(const saved of scenes){THREE.RendererUtils.restoreSceneState(saved.value,saved.state);saved.value.name=saved.name;}
    }
  }
}
function drawFrame(){
  lighting.updateForCamera(camera.position);
  if(quality==='low'){renderer.render(scene,camera);return;}
  try{renderPipelinePreservingState();}
  catch(error){
    console.warn('High quality pipeline failed; using direct rendering.',error);
    $('quality').value='low';setQuality('low');
    $('performance-status').textContent='高畫質效果未能啟用，已切換流暢；目前視角保持不變';
    renderer.render(scene,camera);
  }
}
function setQuality(value) {
  if(!ready||!renderer||!lighting)return;
  quality=value;
  renderer.setPixelRatio(Math.min(devicePixelRatio,value==='low'?1:touchDevice?1.2:value==='high'?2:1.5));
  lighting.setQuality(value,touchDevice);
  mirrors?.setQuality(value);
  if(gtao) gtao.resolutionScale=touchDevice?.5:.65;
  updateQualityLabel();
  resize(); needsRender=true;
}
async function setLight(value) {
  if(!ready)return;
  document.querySelectorAll('[data-light]').forEach(b=>b.disabled=true);
  try {
    if(await lighting.select(value==='night'?'night':value==='warm'?'warm':'daylight')) {
      document.querySelectorAll('[data-light]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.light===value)));
      document.documentElement.dataset.lightPreset=value;
      $('lighting-state').textContent=(value==='night'?'夜景':value==='warm'?'午後':'日景')+' · '+(lighting.hasLighting?'室內燈'+(lighting.lampsOn?'開啟':'關閉'):'無可核實固定室內燈')+' · 視角保持不變';
      needsRender=true;
    }
  } catch(e) {console.error(e);tell('這個光線情境未能載入，請稍後再試');}
  finally {document.querySelectorAll('[data-light]').forEach(b=>b.disabled=!ready);}
}

function orientation(target) { camera.lookAt(...target); const e=new THREE.Euler().setFromQuaternion(camera.quaternion,'YXZ');yaw=e.y;pitch=e.x; }
function setWalk(enabled) {
  walking=enabled; lighting?.setInterior(enabled); needsRender=true; controls.enabled=!walking; keys.clear(); pointer=null;
  $('walk').setAttribute('aria-pressed',String(walking&&canMove));$('walk-hint').hidden=!walking;$('touch-walk').hidden=!(walking&&canMove);
  $('walk-hint').textContent=canMove?'拖曳環視 · WASD／方向鍵步行 · Esc 回到外觀':'定點環視 · 拖曳觀看四周 · Esc 回到外觀';
  $('hint').textContent=walking?(canMove?'拖曳環視 · 方向鈕／WASD步行':'空間較窄，這個視點提供定點環視'):'拖曳旋轉 · 滾輪縮放 · 右鍵平移';
  if(walking){const e=new THREE.Euler().setFromQuaternion(camera.quaternion,'YXZ');yaw=e.y;pitch=e.x;} else {const dir=new THREE.Vector3();camera.getWorldDirection(dir);controls.target.copy(camera.position).addScaledVector(dir,5);controls.update();}
}
function selectStop(i) {
  if(!ready||!waypoints[i])return;
  const w=waypoints[i]; activeStop=i; canMove=w.navigation==='walk';
  // Viewpoints change in place, without an animated camera path through walls.
  camera.position.fromArray(w.position);camera.fov=w.fov||55;camera.updateProjectionMatrix();controls.target.fromArray(w.target);orientation(w.target);
  if(w.type==='exterior' && camera.aspect<1.2){const target=new THREE.Vector3(...w.target);camera.position.sub(target).multiplyScalar(1.2/camera.aspect).add(target);}
  setWalk(w.type==='interior');
  if(!walking){controls.target.fromArray(w.target);controls.update();}
  buttons.forEach((b,n)=>b.setAttribute('aria-pressed',String(n===i)));$('view-label').textContent=w.label;
  needsRender=true;
  if(walking){if(canMove)snapToFloor();tell(canMove?'已進入室內，可拖曳環視或使用方向鈕步行':'已切換室內視點，可拖曳環視');}
  document.documentElement.dataset.activeStop=String(i);
}
function resetView() {
  if(!ready)return;
  const i=waypoints.findIndex(w=>w.type==='exterior');if(i>=0){selectStop(i);return;}
  setWalk(false);const c=bounds.getCenter(new THREE.Vector3());camera.position.copy(c).add(new THREE.Vector3(radius*.9,radius*.55,radius*.9));controls.target.copy(c);camera.lookAt(c);controls.update();$('view-label').textContent='外觀總覽';buttons.forEach(b=>b.setAttribute('aria-pressed','false'));
}
function groundAt(pos, range=3.1) {
  raycaster.set(new THREE.Vector3(pos.x,pos.y-1.15,pos.z),new THREE.Vector3(0,-1,0));raycaster.near=0;raycaster.far=range;
  const hits=raycaster.intersectObjects(colliders,false);
  for(const hit of hits){if(!hit.face)continue;normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);if(Math.abs(normal.y)>.55)return hit.point.y;}return null;
}
function snapToFloor(){const floor=groundAt(camera.position);if(floor!==null&&Math.abs(camera.position.y-floor-1.62)<1.4)camera.position.y=floor+1.62;}
function moveStep(dt) {
  let x=0,z=0;if(keys.has('forward'))z-=1;if(keys.has('back'))z+=1;if(keys.has('left'))x-=1;if(keys.has('right'))x+=1;if(!x&&!z)return;
  const direction=new THREE.Vector3(x,0,z).normalize().applyAxisAngle(up,yaw); const distance=Math.min(dt,.045)*1.7;
  // Check the body's lower, middle and eye-height volumes against real meshes.
  for(const offset of [-1.1,-.45,0]){raycaster.set(camera.position.clone().add(new THREE.Vector3(0,offset,0)),direction);raycaster.near=.03;raycaster.far=distance+.32;const hit=raycaster.intersectObjects(colliders,false).find(h=>{normal.copy(h.face?.normal||up).transformDirection(h.object.matrixWorld);return Math.abs(normal.y)<.75;});if(hit){blocked();return;}}
  const next=camera.position.clone().addScaledVector(direction,distance);const floor=groundAt(next,2.0);raycaster.near=0;
  if(floor===null||Math.abs((floor+1.62)-camera.position.y)>.32){blocked();return;}next.y=floor+1.62;camera.position.copy(next);
}
function blocked(){const now=performance.now();if(now-lastCollision>3500){tell('前方有障礙或落差，請繞行或選擇另一個導覽視點');lastCollision=now;}}
function frame(time){
  requestAnimationFrame(frame);const dt=Math.min((time-last)/1000,.05);last=time;
  if(document.hidden||!renderer||!ready)return;
  if(!conceptModalOpen){if(walking&&canMove&&keys.size){moveStep(dt);needsRender=true;}else if(!walking)controls.update();}
  if(needsRender){try{mirrors?.beginFrame();drawFrame();needsRender=false;}catch(e){ready=false;fail(e);}}
}


$('reset').onclick=resetView;
$('walk').onclick=()=>{if(!ready)return;if(walking&&canMove){resetView();return;}const i=waypoints.findIndex(w=>w.type==='interior'&&w.navigation==='walk');if(i>=0)selectStop(i);else tell('請使用室內定點環視，這個模型尚無足夠的安全步行區域');};
$('quality').onchange=e=>setQuality(e.target.value);
$('indoor-lights').onclick=()=>{if(!ready)return;lighting.setLamps(!lighting.lampsOn);$('indoor-lights').setAttribute('aria-pressed',String(lighting.lampsOn));$('indoor-lights').textContent=lighting.lampsOn?'室內燈：開':'室內燈：關';document.documentElement.dataset.indoorLights=String(lighting.lampsOn);$('lighting-state').textContent=(lighting.preset==='night'?'夜景':lighting.preset==='warm'?'午後':'日景')+' · '+(lighting.hasLighting?'室內燈'+(lighting.lampsOn?'開啟':'關閉'):'無可核實固定室內燈')+' · 視角保持不變';needsRender=true;};
$('brightness').oninput=e=>{lighting?.setBrightness(Number(e.target.value));needsRender=true;};
document.querySelectorAll('[data-light]').forEach(b=>b.onclick=()=>setLight(b.dataset.light));
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{tell('此瀏覽器未提供全螢幕模式');}};
canvas.addEventListener('pointerdown',e=>{if(!walking)return;pointer={x:e.clientX,y:e.clientY,id:e.pointerId};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!walking||!pointer||pointer.id!==e.pointerId)return;yaw-=(e.clientX-pointer.x)*.004;pitch-=(e.clientY-pointer.y)*.004;pitch=THREE.MathUtils.clamp(pitch,-1.35,1.35);camera.quaternion.setFromEuler(new THREE.Euler(pitch,yaw,0,'YXZ'));needsRender=true;pointer.x=e.clientX;pointer.y=e.clientY;});
canvas.addEventListener('pointerup',()=>pointer=null);canvas.addEventListener('pointercancel',()=>pointer=null);
window.addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement)return;if(e.key==='Escape'){if(walking)resetView();return;}if(walking&&keyMoves[e.key]){keys.add(keyMoves[e.key]);e.preventDefault();}});
window.addEventListener('keyup',e=>{if(keyMoves[e.key])keys.delete(keyMoves[e.key]);});window.addEventListener('blur',()=>keys.clear());
document.querySelectorAll('[data-move]').forEach(b=>{b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.move);});for(const event of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(event,()=>keys.delete(b.dataset.move));});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();ready=false;fail(new Error('WebGL context lost'));});

function registerTools(){
  const mc=document.modelContext;if(!mc?.registerTool)return;
  const ac=new AbortController();window.addEventListener('pagehide',()=>ac.abort(),{once:true});
  const register=tool=>{try{Promise.resolve(mc.registerTool(tool,{signal:ac.signal})).catch(e=>console.warn('WebMCP unavailable',e));}catch(e){console.warn('WebMCP unavailable',e);}};
  register({name:'read_architecture_tour',title:'讀取建築導覽視點',description:'取得目前建築、模型限制及可選導覽視點。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:()=>({building:cfg.title,activeStop,waypoints:waypoints.map((w,i)=>({index:i,label:w.label,type:w.type})),accuracy:cfg.uncertainty})});
  register({name:'navigate_architecture_viewpoint',title:'切換建築導覽視點',description:'切換畫面上的建築導覽視點，室內視點啟動步行模式。',inputSchema:{type:'object',properties:{index:{type:'integer',minimum:0}},required:['index'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:input=>{if(!input||!Number.isInteger(input.index)||!waypoints[input.index])throw new Error('無效的導覽視點');selectStop(input.index);return{building:cfg.title,index:activeStop,label:waypoints[activeStop].label,walking};}});
}
