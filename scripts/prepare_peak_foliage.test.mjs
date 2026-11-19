// Targeted offline checks; no browser/GPU appearance assertion.
// node --experimental-vm-modules scripts/prepare_peak_foliage.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import * as THREE from "three";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(root,"src/lib"), publicRoot = path.join(root,"public");
const flora = await fs.readFile(path.join(lib,"islandFlora.ts"),"utf8");
const original = flora
  .replace('import { createPeakFlora } from "./peakFlora";','')
  .replace(/  const peak = quality === "high"[\s\S]*?  if \(peak\) root.add\(peak.group\);/, '')
  .replace(/  if \(peak\) \{\n    \/\/ Original assets[\s\S]*?\n  \}\n  assets.own\(root\);/, `  treeLists.forEach((points, i) => addBatches(treeParts[i], points, true, detailDistance, quality !== "low", true));
  const crown = new THREE.IcosahedronGeometry(1, 1).scale(0.31, 0.36, 0.31).translate(0, 0.67, 0);
  const trunk = new THREE.CylinderGeometry(0.025, 0.045, 0.7, 5).translate(0, 0.35, 0);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x639545, roughness: 1 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x705337, roughness: 1 });
  addBatches([{ geo: crown, mat: crownMat }, { geo: trunk, mat: trunkMat }], allTrees, false, farDistance, false);
  assets.own(root);`)
  .replace('    const highPoints: Placement[] = [];','')
  .replace(/      if \(peak\) highPoints.push[^\n]*\n      else addBatches\(parts, points, true, distance, false\);/, '      addBatches(parts, points, true, distance, false);')
  .replace('    if (peak) peak.addGround(highPoints, minHeight < 0.5 ? "flowers" : "bush");','')
  .replace('      peak?.update(camera, player);','')
  .replace('    dispose() { peak?.dispose(); root.removeFromParent(); },','    dispose() { root.removeFromParent(); },');
assert.ok(!original.includes("peak"),"reconstruct unchanged baseline rendering/generation");
const terrain = {
  HALF:2500,
  getIslandHeight:(x,z)=>12+Math.sin(x*.0003)*2+Math.cos(z*.0004)*2,
  grassMask:()=>1, sampleIslandWater:()=>false, sourceToWorld:(x,z)=>({x:x*3.125,z:z*3.125}),
};
const layout = { isReserved:(x,z,m)=>Math.abs(x)<85+m&&Math.abs(z)<85+m };
async function readGltf(url) {
  const filename=path.join(publicRoot,url.replace(/^\//,''));
  let json,bin;
  const bytes=await fs.readFile(filename);
  if (filename.endsWith('.glb')) {
    const length=bytes.readUInt32LE(12); json=JSON.parse(bytes.subarray(20,20+length).toString());
    const start=20+length; bin=bytes.subarray(start+8,start+8+bytes.readUInt32LE(start));
  } else { json=JSON.parse(bytes); bin=await fs.readFile(path.join(path.dirname(filename),json.buffers[0].uri)); }
  const types={5126:Float32Array,5125:Uint32Array,5123:Uint16Array,5121:Uint8Array};
  const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
  const attr=(id)=>{
    const a=json.accessors[id],v=json.bufferViews[a.bufferView],C=types[a.componentType],size=sizes[a.type];
    const offset=(v.byteOffset||0)+(a.byteOffset||0), count=a.count*size;
    assert.ok(!v.byteStride || v.byteStride===size*C.BYTES_PER_ELEMENT,'packed geometry fixture');
    const data=bin.subarray(offset,offset+count*C.BYTES_PER_ELEMENT); const copy=new Uint8Array(data).buffer;
    return new THREE.BufferAttribute(new C(copy),size,a.normalized||false);
  };
  const textureCache=new Map();
  const texture=(id)=>{
    if (id===undefined) return null;
    if (!textureCache.has(id)) { const t=new THREE.DataTexture(new Uint8Array([80,130,40,255]),1,1); t.colorSpace=THREE.SRGBColorSpace; textureCache.set(id,t); }
    return textureCache.get(id);
  };
  return json.meshes.flatMap(mesh=>mesh.primitives.map(p=>{
    const g=new THREE.BufferGeometry();
    for(const [semantic,id] of Object.entries(p.attributes)) {
      const name={POSITION:'position',NORMAL:'normal',TEXCOORD_0:'uv',COLOR_0:'color'}[semantic]; if(name)g.setAttribute(name,attr(id));
    }
    if(p.indices!==undefined)g.setIndex(attr(p.indices));
    const source=json.materials[p.material]||{},pbr=source.pbrMetallicRoughness||{};
    const m=new THREE.MeshStandardMaterial({name:source.name||'',alphaTest:source.alphaMode==='MASK'?(source.alphaCutoff||.5):0,
      map:texture(pbr.baseColorTexture?.index),vertexColors:g.hasAttribute('color')});
    return {geo:g,mat:m};
  }));
}
const sourceCache=new Map();
const makeAssets=()=>({
  async load(url) {
    if(!sourceCache.has(url))sourceCache.set(url,await readGltf(url));
    return sourceCache.get(url).map(p=>({geo:p.geo.clone(),mat:p.mat.clone()}));
  }, own(){}, dispose(){},
});
async function moduleFor(text,peakImplementation) {
  const calls=[],capture={trees:[],ground:[],loaded:0};
  const context=createContext({console,DOMException,AbortController,Math});
  const sharedText=await fs.readFile(path.join(lib,'worldShared.ts'),'utf8');
  const shared=new SourceTextModule(ts.transpileModule(sharedText,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,{context});
  const three=new SyntheticModule(Object.keys(THREE),function(){for(const k of Object.keys(THREE))this.setExport(k,THREE[k]);},{context});
  await shared.link(()=>three);await shared.evaluate();
  const sharedValues={...shared.namespace,rng:(seed)=>{const rand=shared.namespace.rng(seed);return()=>{const v=rand();calls.push(v);return v;};}};
  const synthetic=values=>new SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});
  const peak=peakImplementation||{async createPeakFlora(){capture.loaded++;return {group:new THREE.Group(),addTrees:p=>capture.trees.push(...p),addGround:(p,k)=>capture.ground.push({points:p,kind:k}),update(){},dispose(){}};}};
  const m=new SourceTextModule(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,{context});
  await m.link(spec=>spec==='three'?three:spec==='./worldShared'?synthetic(sharedValues):spec==='./islandTerrain'?synthetic(terrain):spec==='./peakFlora'?synthetic(peak):synthetic({GLTFLoader:class{}}));
  await m.evaluate();return {module:m.namespace,calls,capture};
}
const serialize=n=>JSON.stringify(n.colliders.map(c=>({id:c.id,center:c.center.toArray(),size:c.size.toArray(),yaw:c.yaw,kind:c.kind})));
const render=n=>{const a=[];n.group.traverse(o=>{if(o instanceof THREE.InstancedMesh)a.push({count:o.count,matrix:Array.from(o.instanceMatrix.array),cast:o.castShadow});});return JSON.stringify(a);};
for(const quality of ['low','medium','high']) {
  const a=await moduleFor(original),b=await moduleFor(flora);
  const before=await a.module.buildIslandNature(makeAssets(),layout,quality);
  const after=await b.module.buildIslandNature(makeAssets(),layout,quality);
  assert.deepEqual(b.calls,a.calls,`${quality}: every original RNG draw unchanged`);
  assert.deepEqual(serialize(after),serialize(before),`${quality}: all colliders, ids, sizes, yaws unchanged`);
  assert.equal(after.treeCount,before.treeCount);assert.equal(after.rockCount,before.rockCount);
  if(quality==='high'){assert.equal(b.capture.trees.length,before.treeCount);assert.equal(b.capture.ground.reduce((a,g)=>a+g.points.length,0),8250);}
  else {assert.equal(b.capture.loaded,0);assert.deepEqual(render(after),render(before));}
  console.log(`PASS ${quality} original RNG transcript (${a.calls.length} draws), exact colliders (${after.colliders.length}), counts (${after.treeCount}/${after.rockCount})${quality!=='high'?', exact rendering matrices':''}`);
}
const fail=await moduleFor(flora,{async createPeakFlora(){throw new Error('fixture 404');}}),base=await moduleFor(original);
const fn=await fail.module.buildIslandNature(makeAssets(),layout,'high'),bn=await base.module.buildIslandNature(makeAssets(),layout,'high');
assert.deepEqual(fail.calls,base.calls);assert.deepEqual(serialize(fn),serialize(bn));assert.deepEqual(render(fn),render(bn));
console.log('PASS High asset failure preserves original rendering/RNG/colliders');

// Real PeakFlora renderer, actual generated geometry (dummy decoded GPU textures).
for (const name of ['oak-hero','birch-hero','pine-hero','oak-mid','birch-mid','pine-mid','bush','flowers']) {
  const actual=await readGltf(`/assets/3d/environment/peak/foliage/${name}.gltf`);
  for(const {geo} of actual) {
    const positions=geo.getAttribute('position'),normals=geo.getAttribute('normal'),indices=geo.getIndex();
    const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3();
    for(let i=0;i<indices.count;i+=3){const ia=indices.getX(i),ib=indices.getX(i+1),ic=indices.getX(i+2);a.fromBufferAttribute(positions,ia);b.fromBufferAttribute(positions,ib);c.fromBufferAttribute(positions,ic);normal.fromBufferAttribute(normals,ia);assert.ok(b.sub(a).cross(c.sub(a)).dot(normal)>0,`${name}: outward triangle winding`);}
    geo.computeBoundingBox();assert.ok(geo.boundingBox.min.y>=-1e-7);assert.ok(geo.boundingBox.max.y<=1+1e-7);
  }
}
console.log('PASS all generated geometry outward winding and anchored unit-height bounds');
const peakSource=await fs.readFile(path.join(lib,'peakFlora.ts'),'utf8');
const peakModule=await moduleFor(peakSource);
const assets=makeAssets(); const peak=await peakModule.module.createPeakFlora(assets);
const points=Array.from({length:6800},(_,i)=>({x:(i%100-50)*8,y:10,z:(Math.floor(i/100)-34)*8,scale:12,yaw:i*.7}));
peak.addTrees(points);peak.addGround(points.slice(0,2750).map(p=>({...p,scale:1.1})),'bush');peak.addGround(points.slice(0,5500).map(p=>({...p,scale:.3})),'flowers');
const camera=new THREE.PerspectiveCamera();camera.position.set(0,20,0);
// moduleFor uses another shared clock; extract uniform on compiled shader to advance.
let clock;
peak.group.traverse(o=>{if(o instanceof THREE.InstancedMesh&&!clock){const sh={uniforms:{},vertexShader:'#include <common>\n#include <project_vertex>\n#include <worldpos_vertex>',fragmentShader:'#include <common>\n#include <map_fragment>\n#include <alphatest_fragment>'};o.material.onBeforeCompile(sh);clock=sh.uniforms.peakTime;}});
for(let frame=0;frame<100;frame++){clock.value=frame/60;peak.update(camera,new THREE.Vector3());}
let treeDraws=0, groundDraws=0, heroCount=0, midCount=0, farCount=0;
const intervals=points.map(()=>[]), lookup=new Map(points.map((p,i)=>[`${p.x},${p.z}`,i]));
const visible=[];
peak.group.traverse(o=>{if(o instanceof THREE.InstancedMesh&&o.visible&&o.count){visible.push(o);if(o.geometry.hasAttribute('peakKind'))farCount=o.count;}});
for(const o of visible) {
  const matrix=new THREE.Matrix4();o.getMatrixAt(0,matrix);const size=new THREE.Vector3().setFromMatrixScale(matrix).y;
  if(size<2){groundDraws++;assert.ok(o.count<=(size<.5?256:96));continue;}
  treeDraws++;
  const range=o.geometry.getAttribute('peakRange');
  if(o.geometry.hasAttribute('peakKind')) assert.equal(o.castShadow,false);
  else if(o.castShadow) {heroCount+=o.count/2;assert.ok(o.customDepthMaterial&&o.customDistanceMaterial);}
  else midCount+=o.count/2;
  for(let i=0;i<o.count;i++) {
    o.getMatrixAt(i,matrix);const a=matrix.elements;const index=lookup.get(`${a[12]},${a[14]}`);assert.ok(index!==undefined);
    // Skip second tree primitive, keeping one representation per instance.
    if(o.material.name.includes('leaf'))continue;
    intervals[index].push([range.getX(i),range.getY(i)]);
  }
  assert.ok(o.boundingSphere && o.boundingSphere.radius>0,'expanded sway/card bounds');
  for(const material of [o.material,o.customDepthMaterial,o.customDistanceMaterial].filter(Boolean)) {
    const sh={uniforms:{},vertexShader:'#include <common>\n#include <project_vertex>\n#include <worldpos_vertex>',fragmentShader:'#include <common>\n#include <map_fragment>\n#include <alphatest_fragment>'};
    material.onBeforeCompile(sh);assert.ok(sh.vertexShader.includes('peakDeform'));assert.ok(sh.vertexShader.includes('vec4 worldPosition = peakWorld'));
    assert.ok(sh.fragmentShader.includes('vPeakRange.x'));assert.equal(sh.uniforms.peakTime,clock);
  }
}
for(const ranges of intervals){ranges.sort((a,b)=>a[0]-b[0]);assert.ok(ranges.length);assert.equal(ranges[0][0],0);assert.equal(ranges.at(-1)[1],1);for(let i=1;i<ranges.length;i++)assert.ok(Math.abs(ranges[i][0]-ranges[i-1][1])<1e-6,'complementary non-overlap LOD ranges');}
const snapshot=()=>{const result=new Map();peak.group.traverse(o=>{if(!(o instanceof THREE.InstancedMesh)||o.material.name.includes('leaf'))return;const range=o.geometry.getAttribute('peakRange'),matrix=new THREE.Matrix4();for(let i=0;i<o.count;i++){o.getMatrixAt(i,matrix);const e=matrix.elements;if(e[5]<2)continue;const key=`${e[12]},${e[14]}`;const values=result.get(key)||[];values.push([range.getX(i),range.getY(i)]);result.set(key,values);}});return result;};
const previous=snapshot();camera.position.set(900,150,-300);clock.value+=1/60;peak.update(camera,new THREE.Vector3());
const shifted=snapshot();for(const [key,before]of previous){const after=shifted.get(key);assert.ok(after);before.sort((a,b)=>a[0]-b[0]);after.sort((a,b)=>a[0]-b[0]);assert.equal(after[0][0],0);assert.equal(after.at(-1)[1],1);for(let i=1;i<after.length;i++)assert.ok(Math.abs(after[i][0]-after[i-1][1])<1e-6);assert.ok(Math.abs((1-before.at(-1)[0])-(1-after.at(-1)[0]))<.12,'camera teleport fades slots rather than popping LODs');}
console.log('PASS camera teleport keeps complementary coverage and smoothly fades occupied LOD slots');
assert.ok(heroCount<=96&&midCount<=512);assert.ok(treeDraws<=13&&groundDraws<=4);
console.log(`PASS 6800-tree renderer: ${heroCount} hero, ${midCount} middle, ${farCount} far, ${treeDraws}+${groundDraws} draws; complementary ranges, matching shadow shaders, caps and bounds`);
peak.dispose();peak.dispose();
const manifest=JSON.parse(await fs.readFile(path.join(publicRoot,'assets/3d/environment/peak/foliage/manifest.json'),'utf8'));
console.log('ASSET BUDGET',JSON.stringify(manifest.assets));
console.log('PASS targeted foliage tests (offline only; no rendered appearance validation)');
