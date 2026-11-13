import * as THREE from 'three';
import { Reflector } from './vendor/addons/objects/Reflector.js';

// Exact faces of retained mirror slabs. Their full geometry remains available
// to collision and AO; only the visible face uses a planar reflection pass.
export function prepareMirrors(scene, model, colliders, specification, mobile) {
  const mirrors = [], fallbacks = [], updated = new Set();
  let renderingReflection = false;
  if (!specification) return {count:0,beginFrame(){},setQuality(){}};
  model.updateMatrixWorld(true);
  const surfaces=[];
  model.traverse(o=>{if(o.isMesh&&o.material.name===specification.materialName)surfaces.push(o)});
  if(surfaces.length!==1)throw new Error('鏡面材質分組與保留模型不符');
  const surface=surfaces[0], original=surface.geometry, sourceIndex=original.index;
  if(!sourceIndex||sourceIndex.count!==specification.sourceTriangleCount*3)throw new Error('鏡面幾何資料不符');
  const proxy=new THREE.Mesh(original,surface.material);
  proxy.matrixAutoUpdate=false;proxy.matrix.copy(surface.matrixWorld);proxy.updateMatrixWorld(true);proxy.raycast=surface.raycast;
  const colliderIndex=colliders.indexOf(surface);if(colliderIndex>=0)colliders[colliderIndex]=proxy;
  const retained=[];
  for(const triangle of specification.retainOriginalTriangleIndices)for(let k=0;k<3;k++)retained.push(sourceIndex.getX(triangle*3+k));
  surface.geometry=original.clone();surface.geometry.setIndex(retained);
  const shader={...Reflector.ReflectorShader,fragmentShader:Reflector.ReflectorShader.fragmentShader.replace('blendOverlay( base.rgb, color )','base.rgb * color')};
  for(const face of specification.faces){
    const center=new THREE.Vector3(...face.worldCentroidM),x=new THREE.Vector3(...face.localXWorld),y=new THREE.Vector3(...face.localYWorld),z=new THREE.Vector3(...face.localZWorld);
    const positions=[];
    for(const triangle of face.triangleIndicesZeroBased)for(let k=0;k<3;k++){
      const v=new THREE.Vector3().fromBufferAttribute(original.attributes.position,sourceIndex.getX(triangle*3+k)).applyMatrix4(surface.matrixWorld).sub(center);
      positions.push(v.dot(x),v.dot(y),v.dot(z));
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();
    const reflector=new Reflector(geometry,{textureWidth:mobile?512:768,textureHeight:mobile?512:768,multisample:0,clipBias:.001,color:new THREE.Color().setRGB(.94,.94,.94),shader});
    reflector.position.copy(center);reflector.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));reflector.name=face.label;
    const terminalMaterial=surface.material.clone();terminalMaterial.envMapIntensity=.08;
    const fallback=new THREE.Mesh(geometry,terminalMaterial);fallback.position.copy(reflector.position);fallback.quaternion.copy(reflector.quaternion);fallback.visible=false;
    scene.add(reflector,fallback);mirrors.push(reflector);fallbacks.push(fallback);
  }
  for(const mirror of mirrors){
    const renderReflection=mirror.onBeforeRender;
    mirror.onBeforeRender=function(renderer,renderScene,camera){
      if(renderingReflection||updated.has(this))return;
      updated.add(this);renderingReflection=true;
      const vis=mirrors.map(x=>x.visible),fallbackVis=fallbacks.map(x=>x.visible);
      const target=renderer.getRenderTarget(),xr=renderer.xr.enabled,shadow=renderer.shadowMap.autoUpdate;
      try{
        mirrors.forEach((other,i)=>{if(other!==this){other.visible=false;fallbacks[i].visible=vis[i]}});
        renderReflection.call(this,renderer,renderScene,camera);
      }finally{
        mirrors.forEach((other,i)=>other.visible=vis[i]);fallbacks.forEach((other,i)=>other.visible=fallbackVis[i]);
        renderer.setRenderTarget(target);renderer.xr.enabled=xr;renderer.shadowMap.autoUpdate=shadow;renderingReflection=false;
      }
    };
  }
  return {count:mirrors.length,bounces:1,beginFrame(){updated.clear()},setQuality(value){const n=value==='low'||mobile?512:value==='high'?1024:768;for(const m of mirrors)m.getRenderTarget().setSize(n,n)}};
}
