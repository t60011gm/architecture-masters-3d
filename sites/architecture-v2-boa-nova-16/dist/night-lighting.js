import * as THREE from 'three';
import { ArchitecturalLighting } from './webgpu-lighting.js';
import { RectAreaLightTexturesLib } from './webgpu-vendor/addons/lights/RectAreaLightTexturesLib.js';

// All dimensions and photometric parameters are educational approximations unless
// the per-building source record explicitly says otherwise. No indirect GI.
const vec = a => new THREE.Vector3(...a);
const clamp = THREE.MathUtils.clamp;
let ltcInitialized = false;
function subsetGeometry(source, indices) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) g.setAttribute(name, attr);
  g.morphAttributes = source.morphAttributes; g.morphTargetsRelative = source.morphTargetsRelative;
  g.setIndex(indices); g.userData = {...source.userData};
  g.computeBoundingBox(); g.computeBoundingSphere(); return g;
}
function inBand(rule, center) {
  if (rule.minY !== undefined && center.y < rule.minY) return false;
  if (rule.maxY !== undefined && center.y > rule.maxY) return false;
  if (rule.bounds?.min && center.toArray().some((v,i)=>v<rule.bounds.min[i])) return false;
  if (rule.bounds?.max && center.toArray().some((v,i)=>v>rule.bounds.max[i])) return false;
  return true;
}
// Split triangles by world-space centroid, retaining positions, normals and UVs.
// Material names may cover lamps AND roofs. Never enable an entire mixed mesh.
export function bindEmissiveMaterials(model, rules = []) {
  model.updateMatrixWorld(true);
  const meshes = []; model.traverse(o=>{if(o.isMesh)meshes.push(o);});
  const bindings = [], diagnostics = [];
  for (const mesh of meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // All undocumented original emissions, including skylights, are disabled.
    for(const m of materials) if(m.emissive) m.emissiveIntensity=0;
    if(materials.length !== 1) continue;
    const material = materials[0], match = rules.filter(r=>r.name===material.name);
    if(!match.length || !material.emissive) continue;
    const g=mesh.geometry, p=g.attributes.position, index=g.index;
    const buckets=match.map(()=>[]), off=[], center=new THREE.Vector3(), v=new THREE.Vector3();
    const count=index?index.count:p.count;
    for(let i=0;i<count;i+=3){
      const ids=[0,1,2].map(k=>index?index.getX(i+k):i+k);center.set(0,0,0);
      for(const id of ids)center.add(v.fromBufferAttribute(p,id));
      center.multiplyScalar(1/3).applyMatrix4(mesh.matrixWorld);
      const slot=match.findIndex(rule=>inBand(rule,center));
      (slot<0?off:buckets[slot]).push(...ids);
    }
    const sourceParent=mesh.parent;
    for(let i=0;i<match.length;i++){
      const rule=match[i], indices=buckets[i]; if(!indices.length)continue;
      const m=material.clone(); m.name=material.name; m.emissive.set(rule.color || '#fff0d4');m.emissiveIntensity=0;
      const emitter=mesh.clone(false); emitter.geometry=subsetGeometry(g,indices);emitter.material=m;
      emitter.name=(mesh.name||material.name)+' — documented emitter '+i;
      emitter.userData={...mesh.userData,skipAO:true,historicEmitter:true};
      emitter.castShadow=false;emitter.receiveShadow=true;sourceParent.add(emitter);
      bindings.push({material:m,intensity:rule.intensity ?? 2.3});
      diagnostics.push({name:material.name,triangles:indices.length/3,minY:rule.minY??null,maxY:rule.maxY??null,worldCentroidFilter:true});
    }
    mesh.geometry=subsetGeometry(g,off);
    if(!off.length){mesh.userData.skipCollision=true;mesh.userData.skipAO=true;mesh.geometry.setDrawRange(0,0);}
  }
  return {bindings,diagnostics};
}
function materialFor(spec) {
  return new THREE.MeshStandardMaterial({color:spec.color||'#d8d3c8',roughness:spec.roughness??.65,metalness:spec.metalness??0,
    emissive:spec.emissive||'#000000',emissiveIntensity:0,side:spec.doubleSided?THREE.DoubleSide:THREE.FrontSide});
}
export function buildAdditions(specs=[]) {
  const group=new THREE.Group();group.name='Source-informed supplementary geometry — teaching estimates';
  const bindings=[];let meshCount=0;
  function add(spec,parent){
    const type=spec.type;let geometry;
    if(type==='group'){
      const g=new THREE.Group();g.position.fromArray(spec.position||[0,0,0]);if(spec.rotation)g.rotation.set(...spec.rotation.map(THREE.MathUtils.degToRad));parent.add(g);
      for(const child of spec.children||[])add(child,g);return;
    }
    if(type==='grid'){
      const g=new THREE.Group();g.position.fromArray(spec.position||[0,0,0]);if(spec.rotation)g.rotation.set(...spec.rotation.map(THREE.MathUtils.degToRad));parent.add(g);
      const [width,depth]=spec.size||[4,4], rows=clamp(spec.rows||4,1,40),columns=clamp(spec.columns||4,1,40),t=spec.thickness||.08,h=spec.height||.12;
      for(let i=0;i<=rows;i++)add({...spec,type:'beam',position:[0,0,-depth/2+i*depth/rows],size:[width,h,t],rotation:[0,0,0]},g);
      for(let i=0;i<=columns;i++)add({...spec,type:'beam',position:[-width/2+i*width/columns,0,0],size:[t,h,depth],rotation:[0,0,0]},g);
      return;
    }
    if(['box','panel','beam','linear'].includes(type))geometry=new THREE.BoxGeometry(...(spec.size||[1,.1,1]));
    else if(['sphere','globe'].includes(type))geometry=new THREE.SphereGeometry(spec.radius??.12,20,12);
    else if(['cylinder','pendant'].includes(type))geometry=new THREE.CylinderGeometry(spec.radiusTop??spec.radius??.1,spec.radiusBottom??spec.radius??.1,spec.height??.3,20,1,!!spec.openEnded);
    else if(type==='torus')geometry=new THREE.TorusGeometry(spec.radius??.2,spec.tube??.015,8,32);
    else throw new Error('Unsupported supplementary geometry: '+type);
    const material=materialFor(spec),mesh=new THREE.Mesh(geometry,material);mesh.name=spec.name||'Teaching '+type;
    mesh.position.fromArray(spec.position||[0,0,0]);if(spec.rotation)mesh.rotation.set(...spec.rotation.map(THREE.MathUtils.degToRad));
    mesh.castShadow=spec.castShadow ?? !spec.emissive;mesh.receiveShadow=true;
    mesh.userData.skipCollision=spec.collision===false;mesh.userData.skipAO=spec.ao===false||!!spec.emissive;
    parent.add(mesh);meshCount++;
    if(spec.emissive)bindings.push({material,intensity:spec.emissiveIntensity??2.3});
  }
  for(const spec of specs)add(spec,group);
  return {group,bindings,meshCount};
}
export class NightLighting extends ArchitecturalLighting {
  constructor(renderer,scene,catalog,configuration={}){
    super(renderer,scene,catalog);this.configuration=configuration;this.lampsOn=true;this.quality='high';this.mobile=false;
    this.lamps=[];this.bindings=[];this.activeSignature='';this.lastCamera=new THREE.Vector3(Infinity,Infinity,Infinity);
    this.fixtures=new THREE.Group();this.fixtures.name='Documented fixture locations and educational direct light';scene.add(this.fixtures);
    const additions=buildAdditions(configuration.additions||[]);this.geometry=additions.group;this.bindings.push(...additions.bindings);this.fixtures.add(this.geometry);
    this.diagnostics.indoor={summary:configuration.summary||'',configuration:'Source-informed educational approximation; no measured photometry',
      sourceCount:configuration.sources?.length||0,documentedEmissions:[],additions:additions.meshCount,availableLights:0,activeLights:0,
      indirectBounce:false,hardwareRayTracing:false,worldUnits:'retained GLB world coordinates',brightnessUnits:'point/spot candela; area luminance cd/m²; educational estimates',
      maxActiveLights:{high:Math.min(24,configuration.maxActiveLights?.high??16),low:Math.min(12,configuration.maxActiveLights?.low??8)},
      selection:'nearest configured lights to current camera; visible emitters retained outside the direct-light budget',warnings:[]};
    for(const [i,s] of (configuration.lights||[]).entries())this.addLight(s,i);
    this.diagnostics.indoor.availableLights=this.lamps.length;
    this.hasLighting=this.lamps.length>0||this.bindings.length>0;
    this.updateLamps();
  }
  bindModel(model){
    const result=bindEmissiveMaterials(model,this.configuration.emissiveMaterials||[]);this.bindings.push(...result.bindings);
    this.diagnostics.indoor.documentedEmissions=result.diagnostics;
    const matched=new Set(result.diagnostics.map(d=>d.name));
    for(const rule of this.configuration.emissiveMaterials||[])if(!matched.has(rule.name))this.diagnostics.indoor.warnings.push('No matching emitter triangles: '+rule.name);
    this.hasLighting=this.lamps.length>0||this.bindings.length>0;this.updateLamps();return result.diagnostics;
  }
  addLight(s,i){
    const color=s.color||'#ffe5bc',intensity=Math.max(0,s.intensity??35),distance=s.distance??12;
    let light;
    if(s.type==='point')light=new THREE.PointLight(color,intensity,distance,2);
    else if(s.type==='spot'){
      light=new THREE.SpotLight(color,intensity,distance,THREE.MathUtils.degToRad(clamp(s.angle??55,1,89)),s.penumbra??.65,2);
      light.target.position.copy(vec(s.position)).add(vec(s.direction||[0,-1,0]).normalize());this.fixtures.add(light.target);
    }else if(s.type==='area'){
      if(!ltcInitialized){THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());ltcInitialized=true;}
      light=new THREE.RectAreaLight(color,intensity,s.width??1,s.height??.2);
    }else throw new Error('Unsupported light type: '+s.type);
    light.name=s.name||`Historical direct source ${i+1}`;light.position.fromArray(s.position);
    if(s.type==='area')light.lookAt(vec(s.position).add(vec(s.direction||[0,-1,0]).normalize()));
    light.userData={baseIntensity:intensity,shadowCandidate:!!s.shadow,priority:s.priority??1,sourceType:s.type,
      cameraYMin:s.cameraYMin,cameraYMax:s.cameraYMax};
    if(light.shadow){
      light.shadow.mapSize.set(512,512);light.shadow.camera.near=.025;light.shadow.camera.far=Math.max(distance,1);
      light.shadow.bias=-.0002;light.shadow.normalBias=.006;light.shadow.radius=1;
    }
    light.visible=false;this.fixtures.add(light);this.lamps.push(light);
  }
  updateForCamera(position,force=false){
    // Optional inclusive world-Y bands keep configured floor-specific direct
    // lights out of other floors. Visible fixture geometry remains unchanged.
    const eligible=this.lamps.map(light=>(light.userData.cameraYMin===undefined||position.y>=light.userData.cameraYMin)
      &&(light.userData.cameraYMax===undefined||position.y<=light.userData.cameraYMax));
    const eligibilitySignature=eligible.map(v=>v?'1':'0').join('');
    if(!force&&this.lastCamera.distanceToSquared(position)<.56&&eligibilitySignature===this.eligibilitySignature)return false;
    this.eligibilitySignature=eligibilitySignature;
    this.lastCamera.copy(position);
    const cap=this.diagnostics.indoor.maxActiveLights[this.quality==='low'?'low':'high'];
    const ranked=this.lamps.map((light,i)=>({light,i,score:light.position.distanceToSquared(position)/Math.max(.1,light.userData.priority)})).filter(v=>eligible[v.i]).sort((a,b)=>a.score-b.score);
    const selected=new Set(ranked.slice(0,cap).map(v=>v.i));let shadowMaps=0,shadowLights=0;
    const shadowBudget=this.quality==='high'?(this.mobile?2:6):0;
    const maxShadowLights=this.quality==='high'?(this.configuration.maxShadowLights??2):0;
    // Clear the previous selection too: filtered-out lights no longer appear
    // in ranked and must not stay enabled after moving between floor bands.
    for(const light of this.lamps){light.visible=false;light.intensity=0;light.castShadow=false;}
    for(const {light,i} of ranked){
      light.visible=this.lampsOn&&selected.has(i);light.intensity=light.visible?light.userData.baseIntensity:0;
      const cost=light.isPointLight?6:light.isSpotLight?1:0;
      const shadow=light.visible&&light.userData.shadowCandidate&&cost>0&&shadowMaps+cost<=shadowBudget&&shadowLights<maxShadowLights;
      light.castShadow=shadow;if(shadow){shadowMaps+=cost;shadowLights++;}
    }
    const signature=this.lamps.map((l,i)=>l.visible?`${i}:${l.castShadow?1:0}`:'').join(',');const changed=signature!==this.activeSignature;this.activeSignature=signature;
    Object.assign(this.diagnostics.indoor,{enabled:this.lampsOn,activeLights:this.lamps.filter(l=>l.visible).length,shadowMaps,shadowLights,preset:this.preset,quality:this.quality});
    return changed;
  }
  updateLamps(){
    for(const binding of this.bindings)binding.material.emissiveIntensity=this.lampsOn?binding.intensity:0;
    this.updateForCamera(Number.isFinite(this.lastCamera.x)?this.lastCamera:this.center||new THREE.Vector3(),true);
  }
  setLamps(on){this.lampsOn=!!on;this.updateLamps();}
  setQuality(value,mobile){super.setQuality(value,mobile);this.quality=value;this.mobile=mobile;this.updateLamps();}
  makeNightSky(){
    if(this.nightSky)return this.nightSky;
    const width=128,height=64,data=new Float32Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const v=y/(height-1),h=Math.exp(-Math.pow((v-.5)/.13,2)),j=(y*width+x)*4;
      data[j]=.004+.025*h;data[j+1]=.009+.04*h;data[j+2]=.025+.065*h;data[j+3]=1;
    }
    const hdr=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
    hdr.colorSpace=THREE.LinearSRGBColorSpace;hdr.mapping=THREE.EquirectangularReflectionMapping;hdr.needsUpdate=true;
    this.nightSky={hdr,environment:this.pmrem.fromEquirectangular(hdr)};return this.nightSky;
  }
  async select(id){
    if(id!=='night'){const ok=await super.select(id);this.updateLamps();return ok;}
    ++this.request;this.preset='night';const env=this.makeNightSky();
    this.scene.background=env.hdr;this.scene.backgroundIntensity=1;this.scene.backgroundBlurriness=0;
    this.scene.environment=env.environment.texture;this.scene.environmentIntensity=1;
    this.sun.color.set('#a8c6ff');this.sun.intensity=.2;
    this.sun.position.copy(this.center).add(vec([-1,1.6,.9]).normalize().multiplyScalar(this.radius*3));
    this.sun.target.updateMatrixWorld();this.sun.updateMatrixWorld();this.fitShadowCamera();this.expose();this.updateLamps();return true;
  }
  expose(){if(this.preset==='night')this.renderer.toneMappingExposure=this.brightness;else super.expose();}
}
