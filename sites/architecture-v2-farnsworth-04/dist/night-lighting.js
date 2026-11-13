import * as THREE from 'three';
import { ArchitecturalLighting } from './lighting.js';

// Source-informed educational interpretation, not a measured restoration.
// World coordinates use the existing GLB axes/metres. All values below are estimates.
export const HISTORIC_LIGHTING = {
  floorBase:[19.2,1.6002,-1.25], floorHeight:1.98,
  kitchenCenter:[15.97,3.0752,-7.15], tubeLength:1.2,
  approximateCCT:{floor:3000,kitchen:4000},
  sources:['https://www.moma.org/collection/works/129142',
    'https://tile.loc.gov/storage-services/master/pnp/habshaer/il/il0300/il0323/data/il0323data.pdf',
    'https://savingplaces.org/stories/fertile-ground-farnsworth-house']
};
export class NightLighting extends ArchitecturalLighting {
  constructor(renderer,scene,catalog) {
    super(renderer,scene,catalog);
    this.lampsOn=true; this.quality='high'; this.fixtures=new THREE.Group();
    this.fixtures.name='Source-informed floor lamp and kitchen fluorescent — estimated teaching model';
    this.lamps=[];this.diffusers=[];
    const metal=new THREE.MeshStandardMaterial({color:'#aa9979',roughness:.3,metalness:.75});
    const black=new THREE.MeshStandardMaterial({color:'#292724',roughness:.42,metalness:.35,side:THREE.DoubleSide});
    const ivory=new THREE.MeshStandardMaterial({color:'#dedbd0',roughness:.5,metalness:.05,side:THREE.DoubleSide});
    const addMesh=(geometry,material,position,name)=>{
      const mesh=new THREE.Mesh(geometry,material);mesh.position.copy(position);mesh.name=name;
      mesh.receiveShadow=true;mesh.castShadow=false;this.fixtures.add(mesh);return mesh;
    };
    const rod=(a,b,r,material,name)=>{
      const delta=b.clone().sub(a),m=addMesh(new THREE.CylinderGeometry(r,r,delta.length(),12),material,a.clone().add(b).multiplyScalar(.5),name);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return m;
    };
    const addSpot=(position,direction,color,intensity,range,angle,shadow,name)=>{
      const light=new THREE.SpotLight(color,intensity,range,angle,.65,2);
      light.name=name;light.position.copy(position);light.target.position.copy(position).add(direction);
      light.userData.baseIntensity=intensity;light.userData.shadowCandidate=shadow;
      light.shadow.mapSize.set(1024,1024);light.shadow.camera.near=.025;light.shadow.camera.far=range;
      light.shadow.bias=-.0002;light.shadow.normalBias=.006;light.shadow.radius=1;
      this.fixtures.add(light,light.target);this.lamps.push(light);return light;
    };
    const base=new THREE.Vector3(...HISTORIC_LIGHTING.floorBase);
    // The original had a tripod base (National Trust); no later stone/quad base.
    for(let i=0;i<3;i++){
      const angle=i*Math.PI*2/3;
      rod(base.clone().add(new THREE.Vector3(0,.09,0)),base.clone().add(new THREE.Vector3(Math.cos(angle)*.31,.025,Math.sin(angle)*.31)),.016,black,'Tripod foot');
    }
    rod(base.clone().add(new THREE.Vector3(0,.08,0)),base.clone().add(new THREE.Vector3(0,1.25,0)),.018,black,'Floor lamp stem');
    // Three unequal adjustable arms and conical shades, with differing directions.
    // Shape, finish, dimensions and aiming are visual approximations, not a catalogue replica.
    const heads=[
      {offset:[.28,1.73,.04],direction:[.04,1,.12],material:ivory,cd:55,shadow:false},
      {offset:[-.23,1.47,.08],direction:[-.28,.94,.14],material:black,cd:40,shadow:false},
      {offset:[-.14,1.32,-.43],direction:[-.6,-.67,-.44],material:black,cd:65,shadow:true}
    ];
    for(const [i,h] of heads.entries()){
      const neck=base.clone().add(new THREE.Vector3(...h.offset)),direction=new THREE.Vector3(...h.direction).normalize();
      const pivot=base.clone().add(new THREE.Vector3(0,1.05+i*.07,0));
      rod(pivot,neck,.012,metal,'Adjustable lamp arm '+(i+1));
      rod(pivot,pivot.clone().sub(neck.clone().sub(pivot).multiplyScalar(.25)),.02,black,'Arm counterweight '+(i+1));
      const shade=addMesh(new THREE.CylinderGeometry(.12,.035,.23,24,1,true),h.material,neck.clone().addScaledVector(direction,.115),'Conical shade '+(i+1));
      shade.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction);
      const aperture=neck.clone().addScaledVector(direction,.226);
      const diffuser=addMesh(new THREE.CircleGeometry(.108,24),new THREE.MeshStandardMaterial({color:'#fff2da',emissive:'#ffdab0',emissiveIntensity:2.3,side:THREE.DoubleSide}),aperture,'Lamp aperture '+(i+1));
      diffuser.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),direction);
      this.diffusers.push(diffuser);
      addSpot(aperture.clone().addScaledVector(direction,.012),direction,'#ffdab0',h.cd,7,1.02,h.shadow,'Floor lamp head '+(i+1));
    }
    // Under the existing kitchen upper cabinet, above the sink. Not above the core.
    const center=new THREE.Vector3(...HISTORIC_LIGHTING.kitchenCenter);
    addMesh(new THREE.BoxGeometry(1.27,.035,.11),new THREE.MeshStandardMaterial({color:'#c7c5bf',roughness:.38,metalness:.65}),center.clone().add(new THREE.Vector3(0,.029,0)),'Kitchen fluorescent housing');
    const tube=addMesh(new THREE.CylinderGeometry(.018,.018,HISTORIC_LIGHTING.tubeLength,16),new THREE.MeshStandardMaterial({color:'#fff9eb',emissive:'#fff0d4',emissiveIntensity:2.3,roughness:.35}),center,'Kitchen fluorescent tube');
    tube.rotation.z=Math.PI/2;this.diffusers.push(tube);
    for(const dx of [-.62,.62])addMesh(new THREE.BoxGeometry(.04,.055,.07),ivory,center.clone().add(new THREE.Vector3(dx,0,0)),'Tube socket');
    // Three local samples approximate a continuous fluorescent emitter; not three fixtures.
    for(const [i,dx] of [-.42,0,.42].entries())addSpot(center.clone().add(new THREE.Vector3(dx,-.025,0)),new THREE.Vector3(0,-1,0),'#fff0d4',12,2.2,1.18,i===1,'Kitchen tube sample '+(i+1));
    scene.add(this.fixtures);
    this.diagnostics.indoor={type:'three-arm floor lamp + one under-cabinet fluorescent tube',
      estimates:HISTORIC_LIGHTING,configuration:'Source-informed teaching model; dimensions, coordinates, output and CCT estimated',
      sourceIntensitiesCandela:this.lamps.map(l=>l.userData.baseIntensity),decay:2,
      highShadowMaps:2,lowShadowMaps:0,indirectBounce:false,hardwareRayTracing:false,
      kitchenEmitterApproximation:'three local SpotLight samples for one linear tube',ceilingSpotFixtures:0,coreTopLighting:false};
  }
  makeNightSky() {
    if(this.nightSky)return this.nightSky;
    const width=128,height=64,data=new Float32Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const v=y/(height-1), horizon=Math.exp(-Math.pow((v-.5)/.13,2));
      const j=(y*width+x)*4;
      // Low-radiance blue sky with a restrained horizon, never a dim daytime HDR.
      data[j]=.004+.025*horizon;data[j+1]=.009+.04*horizon;data[j+2]=.025+.065*horizon;data[j+3]=1;
    }
    const hdr=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
    hdr.colorSpace=THREE.LinearSRGBColorSpace;hdr.mapping=THREE.EquirectangularReflectionMapping;hdr.needsUpdate=true;
    this.nightSky={hdr,environment:this.pmrem.fromEquirectangular(hdr)};
    return this.nightSky;
  }
  async select(id) {
    if(id!=='night'){const ok=await super.select(id);this.updateLamps();return ok;}
    ++this.request;this.preset='night';const env=this.makeNightSky();
    this.scene.background=env.hdr;this.scene.backgroundIntensity=1;this.scene.backgroundBlurriness=0;
    this.scene.environment=env.environment.texture;this.scene.environmentIntensity=1;
    this.sun.color.set('#a8c6ff');this.sun.intensity=.2;
    this.sun.position.copy(this.center).add(new THREE.Vector3(-1,1.6,.9).normalize().multiplyScalar(this.radius*3));
    this.sun.target.updateMatrixWorld();this.sun.updateMatrixWorld();this.fitShadowCamera();
    this.expose();this.updateLamps();return true;
  }
  expose(){if(this.preset==='night')this.renderer.toneMappingExposure=this.brightness;else super.expose();}
  setLamps(on){this.lampsOn=on;this.updateLamps();}
  updateLamps(){
    for(const light of this.lamps){light.intensity=this.lampsOn?light.userData.baseIntensity:0;light.castShadow=this.lampsOn&&this.quality==='high'&&light.userData.shadowCandidate;}
    for(const mesh of this.diffusers)mesh.material.emissiveIntensity=this.lampsOn?2.3:0;
    Object.assign(this.diagnostics.indoor,{enabled:this.lampsOn,shadowMaps:this.lamps.filter(l=>l.castShadow).length,preset:this.preset});
  }
  setQuality(value,mobile){super.setQuality(value,mobile);this.quality=value;this.updateLamps();}
}
