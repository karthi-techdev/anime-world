export interface JumpArc { takeoff: number; land: number; v: number; g: number }
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

// Mixamo bone (without "mixamorig" prefix, lowercase) -> VRM normalized node.
const BONES: Record<string, string> = {
  hips: "Hips",
  spine: "Spine",
  spine1: "Chest",
  spine2: "UpperChest",
  neck: "Neck",
  head: "Head",
  leftshoulder: "L_Shoulder",
  leftarm: "L_UpperArm",
  leftforearm: "L_LowerArm",
  lefthand: "L_Hand",
  rightshoulder: "R_Shoulder",
  rightarm: "R_UpperArm",
  rightforearm: "R_LowerArm",
  righthand: "R_Hand",
  leftupleg: "L_UpperLeg",
  leftleg: "L_LowerLeg",
  leftfoot: "L_Foot",
  lefttoebase: "L_ToeBase",
  rightupleg: "R_UpperLeg",
  rightleg: "R_LowerLeg",
  rightfoot: "R_Foot",
  righttoebase: "R_ToeBase",
};
for (const side of ["Left", "Right"]) {
  const s = side[0];
  const fingers: [string, string][] = [
    ["Thumb", "Thumb"],
    ["Index", "Index"],
    ["Middle", "Middle"],
    ["Ring", "Ring"],
    ["Pinky", "Little"],
  ];
  for (const [mx, vrm] of fingers)
    for (const n of [1, 2, 3])
      BONES[`${side}Hand${mx}${n}`.toLowerCase()] = `${s}_${vrm}${n}`;
}

const bare = (name: string) =>
  name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().replace(/^mixamorig\d*/, "");

const loader = new FBXLoader();
const q = new THREE.Quaternion();
const restInv = new THREE.Quaternion();
const parentRest = new THREE.Quaternion();

export interface MixamoClipResult {
  clip: THREE.AnimationClip;
  /** Root-motion speed in world m/s (0 if the clip is already in place). */
  strideSpeed: number;
}

/**
 * Load a Mixamo FBX and retarget it onto a VRM-normalized skeleton using
 * rest-pose compensation (the step raw quaternion copying skips, which is
 * what makes poses look twisted or wrong).
 * @param model     VRM scene (already normalized/scaled)
 * @param loop      loop clips are detrended in XZ, one-shots start at origin
 */
export async function loadMixamoClip(
  url: string,
  model: THREE.Object3D,
  opts: { loop: boolean; vrmMetaVersion?: string; unitScale: number; jumpArc?: JumpArc }
): Promise<MixamoClipResult> {
  const asset = await loader.loadAsync(url);
  return retargetMixamoAsset(asset, model, opts, url);
}

export function retargetMixamoAsset(
  asset: THREE.Group,
  model: THREE.Object3D,
  opts: { loop: boolean; vrmMetaVersion?: string; unitScale: number; jumpArc?: JumpArc },
  url = "asset"
): MixamoClipResult {
  const src = asset.animations[0];
  if (!src) throw new Error(`no animation in ${url}`);
  asset.updateMatrixWorld(true);

  const nodeByBare = new Map<string, THREE.Object3D>();
  asset.traverse((o) => {
    if ((o as THREE.Bone).isBone) nodeByBare.set(bare(o.name), o);
  });
  const srcHips = nodeByBare.get("hips");
  if (!srcHips) throw new Error(`no hips in ${url}`);
  const motionHipsHeight = Math.abs(srcHips.position.y) || 100;

  const vrmHips = model.getObjectByName("Normalized_J_Bip_C_Hips");
  const vrmHipsHeight = vrmHips ? Math.abs(vrmHips.position.y) || 1 : 1;
  const posScale = vrmHipsHeight / motionHipsHeight;
  const flip = opts.vrmMetaVersion === "0";

  const tracks: THREE.KeyframeTrack[] = [];
  let strideSpeed = 0;

  // Mixamo loops repeat frame 0 as the last frame, which plays the same pose
  // twice and causes a hitch every cycle. Detect and drop that last key.
  let seamDeg = 0;
  for (const t of src.tracks) {
    if (!t.name.endsWith(".quaternion")) continue;
    const n = t.times.length;
    const a = new THREE.Quaternion().fromArray(t.values, 0);
    const z = new THREE.Quaternion().fromArray(t.values, (n - 1) * 4);
    seamDeg = Math.max(seamDeg, (a.angleTo(z) * 180) / Math.PI);
  }
  const dropLast = opts.loop && seamDeg < 3 && src.tracks[0].times.length > 4;

  for (const track of src.tracks) {
    const dot = track.name.lastIndexOf(".");
    const srcName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const node = nodeByBare.get(bare(srcName));
    const key = BONES[bare(srcName)];
    if (!node || !key) continue;
    const target = `Normalized_J_Bip_${key.startsWith("L_") || key.startsWith("R_") ? key : `C_${key}`}`;
    if (!model.getObjectByName(target)) continue;

    if (prop === "quaternion") {
      node.getWorldQuaternion(restInv).invert();
      if (node.parent) node.parent.getWorldQuaternion(parentRest);
      else parentRest.identity();
      const v = track.values.slice();
      for (let i = 0; i < v.length; i += 4) {
        q.fromArray(v, i).premultiply(parentRest).multiply(restInv);
        q.toArray(v, i);
        if (flip) {
          v[i] = -v[i];
          v[i + 2] = -v[i + 2];
        }
      }
      const keep = dropLast && track.times.length > 2 ? track.times.length - 1 : track.times.length;
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${target}.quaternion`,
          track.times.slice(0, keep),
          v.slice(0, keep * 4)
        )
      );
    } else if (prop === "position" && bare(srcName) === "hips") {
      const v = track.values.slice();
      const n = track.times.length;
      const t0 = track.times[0];
      const span = track.times[n - 1] - t0 || 1;
      const x0 = v[0], z0 = v[2];
      const x1 = v[(n - 1) * 3], z1 = v[(n - 1) * 3 + 2];
      strideSpeed =
        (Math.hypot(x1 - x0, z1 - z0) * posScale * opts.unitScale) / span;
      for (let i = 0; i < n; i++) {
        const f = (track.times[i] - t0) / span;
        if (opts.loop || opts.jumpArc) {
          // remove travel, keep the sway (jumps too: controller supplies motion)
          v[i * 3] -= x0 + (x1 - x0) * f;
          v[i * 3 + 2] -= z0 + (z1 - z0) * f;
        } else {
          v[i * 3] -= x0;
          v[i * 3 + 2] -= z0;
        }
        v[i * 3] *= posScale * (flip ? -1 : 1);
        v[i * 3 + 1] *= posScale;
        v[i * 3 + 2] *= posScale * (flip ? -1 : 1);
      }
      // jump: controller physics supplies the parabolic rise (measured from this
      // clip), so subtract exactly that and keep only what the animator added
      // (crouch, leg tuck, landing absorb).
      if (opts.jumpArc) {
        const { takeoff, land, v: v0, g } = opts.jumpArc;
        for (let i = 0; i < n; i++) {
          const t = track.times[i] - takeoff;
          if (t > 0 && track.times[i] < land) v[i * 3 + 1] -= v0 * t - 0.5 * g * t * t;
        }
      }
      const keep = dropLast && n > 2 ? n - 1 : n;
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${target}.position`,
          track.times.slice(0, keep),
          v.slice(0, keep * 3)
        )
      );
    }
  }

  return {
    clip: new THREE.AnimationClip(src.name, src.duration, tracks),
    strideSpeed: strideSpeed > 0.3 ? strideSpeed : 0,
  };
}
