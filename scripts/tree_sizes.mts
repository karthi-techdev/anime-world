import fs from "node:fs";
const d = "public/assets/3d/environment/trees_grass_rocks/glTF";
const names = [...[1,2,3,4,5].map(i => `${d}/BirchTree_${i}.gltf`), ...[1,2,3,4,5].map(i => `${d}/MapleTree_${i}.gltf`)];
for (const f of names) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let out: string[] = [];
  for (const m of j.meshes) for (const p of m.primitives) {
    const a = j.accessors[p.attributes.POSITION];
    const mat = j.materials[p.material]?.name;
    out.push(`${mat}: x ${a.min[0].toFixed(1)}..${a.max[0].toFixed(1)} y ${a.min[1].toFixed(1)}..${a.max[1].toFixed(1)} z ${a.min[2].toFixed(1)}..${a.max[2].toFixed(1)}`);
  }
  console.log(f.split("/").pop(), "|", out.join(" | "), "| nodes", j.nodes.map((n: any) => n.scale ? "s" + n.scale.join(",") : "").filter(Boolean).join(" "));
}
const h = fs.readFileSync("public/assets/3d/environment/stylized_tree.glb");
const hj = JSON.parse(h.slice(20, 20 + h.readUInt32LE(12)).toString("utf8"));
console.log("hero", hj.meshes.map((m: any) => m.primitives.map((p: any) => { const a = hj.accessors[p.attributes.POSITION]; return `x ${a.min[0].toFixed(1)}..${a.max[0].toFixed(1)} y ${a.min[1].toFixed(1)}..${a.max[1].toFixed(1)} z ${a.min[2].toFixed(1)}..${a.max[2].toFixed(1)}`; }).join(" | ")).join(" || "), "nodes", hj.nodes.map((n: any) => (n.scale ? "s" + n.scale.join(",") : "") + (n.translation ? "t" + n.translation.join(",") : "")).filter(Boolean).join(" "));
