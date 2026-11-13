import * as THREE from 'three';
import { HDRLoader } from './webgpu-vendor/addons/loaders/HDRLoader.js';

export class ArchitecturalLighting {
  constructor(renderer, scene, catalog) {
    this.renderer = renderer; this.scene = scene; this.catalog = catalog;
    this.pmrem = new THREE.PMREMGenerator(renderer); this.cache = new Map();
    this.sun = new THREE.DirectionalLight(0xffffff, 1); this.sun.castShadow = true;
    this.sun.shadow.bias = -.00008; this.sun.shadow.normalBias = .018;
    // Keep the PCF footprint small: a radius of three samples neighbouring
    // depths far enough away to self-shadow grazing planar floors and walls.
    this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.radius = 1;
    scene.add(this.sun, this.sun.target);
    this.rotation = new THREE.Euler(0, -Math.PI / 2, 0);
    scene.environmentRotation.copy(this.rotation); scene.backgroundRotation.copy(this.rotation);
    this.brightness = 1; this.interior = false; this.preset = 'daylight'; this.request = 0;
    this.diagnostics = {};
  }
  fitShadowCamera() {
    if (!this.bounds) return;
    const shadow = this.sun.shadow, camera = shadow.camera;
    camera.position.copy(this.sun.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.sun.target.position);
    camera.updateMatrixWorld(true);
    const lightBounds = new THREE.Box3();
    for (const x of [this.bounds.min.x, this.bounds.max.x])
      for (const y of [this.bounds.min.y, this.bounds.max.y])
        for (const z of [this.bounds.min.z, this.bounds.max.z])
          lightBounds.expandByPoint(new THREE.Vector3(x,y,z).applyMatrix4(camera.matrixWorldInverse));
    const pad = Math.max(.15, this.radius * .015);
    Object.assign(camera, {
      left: lightBounds.min.x-pad, right: lightBounds.max.x+pad,
      bottom: lightBounds.min.y-pad, top: lightBounds.max.y+pad,
      near: Math.max(.1,-lightBounds.max.z-pad), far: -lightBounds.min.z+pad
    });
    camera.updateProjectionMatrix();
    // World-unit limits prevent solving acne with visibly detached shadows.
    const texel = Math.max((camera.right-camera.left)/shadow.mapSize.x,
      (camera.top-camera.bottom)/shadow.mapSize.y);
    const depthOffset = THREE.MathUtils.clamp(texel*.5,.001,.01);
    shadow.bias = -depthOffset/(camera.far-camera.near);
    shadow.normalBias = THREE.MathUtils.clamp(texel,.004,.018);
    this.diagnostics.shadow = {texelWorld:texel, depthOffsetWorld:depthOffset,
      normalBiasWorld:shadow.normalBias, filterRadius:shadow.radius,
      near:camera.near, far:camera.far};
  }
  fit(bounds) {
    this.bounds = bounds.clone(); this.center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3()); this.radius = Math.max(size.length() / 2, 8);
    // A sphere encloses the complete AABB at every sun orientation.
    const half = this.radius * 1.05;
    Object.assign(this.sun.shadow.camera, {left:-half, right:half, top:half, bottom:-half, near:.5, far:this.radius*7});
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.target.position.copy(this.center);
  }
  async read(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const task = (async () => {
      const asset = this.catalog.environments.find(e => e.id === id);
      if (!asset) throw new Error('照明情境資料不存在');
      const hdr = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(`./materials/${asset.variants['1k'].path}`);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const {data, width, height} = hdr.image;
      const filtered = new Float32Array(data);
      let brightest = -1, maxL = -1;
      for (let i = 0; i < width * height; i++) {
        const j = i * 4, l = data[j] * .2126 + data[j + 1] * .7152 + data[j + 2] * .0722;
        if (l > maxL) { maxL = l; brightest = i; }
      }
      const dir = (x, y) => {
        const theta = ((x + .5) / width - .5) * 2 * Math.PI;
        const latitude = (.5 - (y + .5) / height) * Math.PI;
        return new THREE.Vector3(Math.cos(latitude) * Math.cos(theta), Math.sin(latitude), Math.cos(latitude) * Math.sin(theta));
      };
      const sourceSun = dir(brightest % width, Math.floor(brightest / width));
      const annulus = [], inner = Math.cos(2 * Math.PI / 180), outer = Math.cos(5 * Math.PI / 180);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dot = dir(x, y).dot(sourceSun);
        if (dot < inner && dot > outer) {
          const i = (y * width + x) * 4;
          annulus.push(data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722);
        }
      }
      annulus.sort((a,b) => a-b);
      const cap = annulus[Math.floor(annulus.length * .95)] || 20;
      const irradiance = new THREE.Vector3(); let replacedPixels = 0;
      // Only the measured sun disk is split from the environment. Sky/cloud
      // radiance and color remain linear HDR. Its removed energy becomes the
      // matching shadow-casting directional source, avoiding a second unshadowed sun.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const direction = dir(x,y), dot = direction.dot(sourceSun);
        if (dot < inner) continue;
        const i = (y * width + x) * 4;
        const l = data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722;
        if (l <= cap) continue;
        const fraction = cap / l, solidAngle = 2 * Math.PI * Math.PI * Math.sin((y + .5) / height * Math.PI) / (width * height);
        for (let c = 0; c < 3; c++) filtered[i + c] = data[i + c] * fraction;
        irradiance.x += (data[i] - filtered[i]) * solidAngle * dot;
        irradiance.y += (data[i + 1] - filtered[i + 1]) * solidAngle * dot;
        irradiance.z += (data[i + 2] - filtered[i + 2]) * solidAngle * dot;
        replacedPixels++;
      }
      const sky = new THREE.DataTexture(filtered, width, height, THREE.RGBAFormat, THREE.FloatType);
      sky.colorSpace = THREE.LinearSRGBColorSpace; sky.mapping = THREE.EquirectangularReflectionMapping; sky.flipY = true; sky.needsUpdate = true;
      const environment = this.pmrem.fromEquirectangular(sky); sky.dispose();
      this.diagnostics[id] = {source:asset.source_asset_id, inputMaxLuminance:maxL, sunCap:cap, replacedPixels, sunIrradianceRGB:irradiance.toArray(), originalSunDirection:sourceSun.toArray()};
      return {hdr, environment, irradiance, sourceSun};
    })();
    this.cache.set(id, task);
    try { return await task; } catch(e) { this.cache.delete(id); throw e; }
  }
  async select(id) {
    const request = ++this.request, env = await this.read(id);
    if (request !== this.request) return false;
    this.preset = id;
    this.scene.environment = env.environment.texture;
    this.scene.environmentIntensity = 1;
    this.scene.background = env.hdr; this.scene.backgroundBlurriness = .035;
    this.scene.backgroundIntensity = id === 'warm' ? .75 : 1;
    const intensity = Math.max(env.irradiance.x, env.irradiance.y, env.irradiance.z, .01);
    this.sun.color.setRGB(env.irradiance.x / intensity, env.irradiance.y / intensity, env.irradiance.z / intensity);
    this.sun.intensity = intensity;
    const direction = env.sourceSun.clone().applyEuler(this.rotation);
    this.sun.position.copy(this.center).addScaledVector(direction, this.radius * 3);
    this.sun.target.updateMatrixWorld(); this.sun.updateMatrixWorld();
    this.fitShadowCamera();
    this.expose(); return true;
  }
  expose() {
    this.renderer.toneMappingExposure = (this.preset === 'warm' ? .7 : 1.05) * (this.interior ? 1.15 : 1) * this.brightness;
  }
  setInterior(value) { this.interior = value; this.expose(); }
  setBrightness(value) { this.brightness = value; this.expose(); }
  setQuality(value, mobile) {
    const size = value === 'high' && !mobile ? 4096 : value === 'low' ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.setScalar(size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.fitShadowCamera();
  }
}
