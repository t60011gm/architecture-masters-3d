import * as THREE from 'three';

// Each surface is selected by its retained material name. The mesh and historical
// color distinctions stay separate from the reusable appearance references.
const textureCache = new Map();
async function readTexture(path, color, renderer) {
  const key = `${path}:${color}`;
  if (!textureCache.has(key)) textureCache.set(key, new THREE.TextureLoader().loadAsync(path).then(t => {
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }));
  return textureCache.get(key);
}

// Planar projections use world metres and split only vertices whose adjacent
// faces need different projections. This replaces degenerate legacy UVs without
// moving a vertex or making tangent normals depend on a quantized node scale.
function projectWorldUV(source, matrix, tile, rotation = 0, preserveColorUV = false) {
  const pos = source.attributes.position;
  const count = pos.count, input = source.index?.array;
  const n = input ? input.length : count;
  const world = new Float32Array(count * 3), point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    point.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    world.set([point.x, point.y, point.z], i * 3);
  }
  const lookup = new Int32Array(count * 6); lookup.fill(-1);
  const remap = [], uv = [], indices = new Uint32Array(n);
  let next = 0, degenerate = 0;
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  for (let i = 0; i < n; i += 3) {
    const ids = [input ? input[i] : i, input ? input[i + 1] : i + 1, input ? input[i + 2] : i + 2];
    const [a, b, c] = ids.map(j => j * 3);
    const ax = world[b] - world[a], ay = world[b + 1] - world[a + 1], az = world[b + 2] - world[a + 2];
    const bx = world[c] - world[a], by = world[c + 1] - world[a + 1], bz = world[c + 2] - world[a + 2];
    const normal = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const abs = normal.map(Math.abs);
    const axis = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
    const sign = normal[axis] < 0 ? -1 : 1;
    const projection = axis * 2 + (sign < 0 ? 1 : 0);
    if (abs[axis] < 1e-12) degenerate++;
    for (let k = 0; k < 3; k++) {
      const old = ids[k], key = old * 6 + projection;
      if (lookup[key] < 0) {
        const w = old * 3, x = world[w], y = world[w + 1], z = world[w + 2];
        let u, v;
        if (axis === 0) { u = -z * sign; v = y; }
        else if (axis === 1) { u = x; v = -z * sign; }
        else { u = x * sign; v = y; }
        uv.push((u * cosine - v * sine) / tile[0], (u * sine + v * cosine) / tile[1]);
        remap.push(old); lookup[key] = next++;
      }
      indices[i + k] = lookup[key];
    }
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) {
    if (name === 'uv' || name === 'tangent') continue;
    const data = new Float32Array(next * attr.itemSize);
    for (let i = 0; i < next; i++) for (let j = 0; j < attr.itemSize; j++) data[i * attr.itemSize + j] = attr.getComponent(remap[i], j);
    geometry.setAttribute(name, new THREE.BufferAttribute(data, attr.itemSize));
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (preserveColorUV && source.attributes.uv) {
    const oldUV = source.attributes.uv, preserved = new Float32Array(next * 2);
    for (let i = 0; i < next; i++) { preserved[i * 2] = oldUV.getX(remap[i]); preserved[i * 2 + 1] = oldUV.getY(remap[i]); }
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(preserved, 2));
  }
  geometry.setIndex(new THREE.BufferAttribute(next > 65535 ? indices : new Uint16Array(indices), 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.mapping = {units: 'world metres', inputVertices: count, outputVertices: next, geometricDegenerates: degenerate};
  return geometry;
}

export async function readMaterialPacks(renderer, profiles, catalog) {
  const assets = new Map(catalog.materials.map(x => [x.id, x]));
  const used = [...new Set(Object.values(profiles).map(x => x.texture).filter(Boolean))];
  const packs = new Map();
  await Promise.all(used.map(async id => {
    const asset = assets.get(id);
    if (!asset) throw new Error(`材質資料缺少 ${id}`);
    const paths = asset.variants.web_compact || asset.variants['1k'];
    const [map, roughnessMap, normalMap] = await Promise.all([
      paths.basecolor ? readTexture(`./materials/${paths.basecolor.path}`, true, renderer) : null,
      paths.roughness ? readTexture(`./materials/${paths.roughness.path}`, false, renderer) : null,
      paths.normal ? readTexture(`./materials/${paths.normal.path}`, false, renderer) : null
    ]);
    packs.set(id, {map, roughnessMap, normalMap, asset});
  }));
  return packs;
}

export async function prepareMaterials(model, renderer, profiles, catalog, preloadedPacks = null) {
  const packs = preloadedPacks || await readMaterialPacks(renderer, profiles, catalog);
  model.updateMatrixWorld(true);
  const diagnostics = [];
  model.traverse(o => {
    if (o.isLight || o.isCamera) { o.visible = false; return; }
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) throw new Error('需要逐面材質的模型尚未完成分組');
    const old = o.material, p = profiles[old.name] || {kind: 'preserve'};
    const m = new THREE.MeshPhysicalMaterial();
    if (old.isMeshPhysicalMaterial) m.copy(old);
    else {
      THREE.MeshStandardMaterial.prototype.copy.call(m, old);
      m.defines = { STANDARD: '', PHYSICAL: '' };
    }
    m.name = old.name; m.side = old.side; m.envMapIntensity = 1;
    m.metalness = p.metalness ?? old.metalness;
    m.roughness = p.roughness ?? old.roughness;
    if (p.color) m.color.set(p.color);
    if (p.kind === 'glass') {
      m.map = null; m.color.copy(p.preserveTint ? old.color : new THREE.Color('#f9fffc'));
      m.metalness = 0; m.roughness = p.roughness ?? .045;
      m.transmission = p.transmission ?? .98; m.ior = p.ior ?? 1.52;
      // glTF quantization stores many buildings beneath a uniform scaled node.
      // Three multiplies volume thickness by that scale during transmission.
      const worldScale = o.getWorldScale(new THREE.Vector3());
      const scalar = Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z));
      m.thickness = (p.thickness ?? .006) / Math.max(scalar, 1e-8);
      m.attenuationColor.set('#d9eee3'); m.attenuationDistance = 12;
      m.opacity = 1; m.transparent = false; m.depthWrite = true;
      o.castShadow = false; o.userData.skipAO = true;
    } else {
      // Preserve intentional colored/translucent material slots and emissive art.
      if (old.isMeshPhysicalMaterial) {
        m.transmission = old.transmission; m.ior = old.ior; m.thickness = old.thickness;
        m.attenuationColor.copy(old.attenuationColor); m.attenuationDistance = old.attenuationDistance;
      }
      o.castShadow = !(m.transmission > .1 || m.opacity < .5);
      o.userData.skipAO = m.transmission > .1 || m.opacity < .5;
    }
    if (p.ior) m.ior = p.ior;
    if (p.texture) {
      const pack = packs.get(p.texture);
      if (p.useColor !== false && pack.map) { m.map = pack.map; m.color.set(p.tint || '#ffffff'); }
      else if (p.clearLegacyMap) m.map = null;
      m.roughnessMap = pack.roughnessMap; m.normalMap = pack.normalMap;
      m.normalScale.setScalar(p.normalScale ?? .25);
      m.metalness = p.metalness ?? 0;
      const preserveColorUV = !!m.map && m.map !== pack.map;
      if (preserveColorUV) { m.map = m.map.clone(); m.map.channel = 1; }
      o.geometry = projectWorldUV(o.geometry, o.matrixWorld, p.tileSize || pack.asset.tile_size_m, (p.rotation || 0) * Math.PI / 180, preserveColorUV);
    }
    if (p.kind === 'paint') { m.metalness = 0; m.clearcoat = .12; m.clearcoatRoughness = .3; }
    if (p.kind === 'wood') { m.clearcoat = .16; m.clearcoatRoughness = .45; }
    if (p.kind === 'fabric') { m.sheen = .3; m.sheenColor.copy(m.color); m.sheenRoughness = .85; }
    if (p.kind === 'leather') { m.clearcoat = .12; m.clearcoatRoughness = .55; }
    o.material = m; o.receiveShadow = true;
    diagnostics.push({material: m.name, kind: p.kind, texture: p.texture || null, metalness: m.metalness, roughness: m.roughness, ...o.geometry.userData.mapping});
  });
  return diagnostics;
}
