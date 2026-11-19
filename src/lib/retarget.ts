import * as THREE from "three";

export interface RetargetOptions {
  inPlace?: boolean;
  clipName?: string;
}

// Exact Pixiv / VRM 1.0 humanoid bone map for male-1.gltf
const vrmBoneMap: Record<string, string> = {
  hips: "Normalized_J_Bip_C_Hips",
  spine: "Normalized_J_Bip_C_Spine",
  chest: "Normalized_J_Bip_C_Chest",
  upperchest: "Normalized_J_Bip_C_UpperChest",
  neck: "Normalized_J_Bip_C_Neck",
  head: "Normalized_J_Bip_C_Head",
  leftshoulder: "Normalized_J_Bip_L_Shoulder",
  leftupperarm: "Normalized_J_Bip_L_UpperArm",
  leftlowerarm: "Normalized_J_Bip_L_LowerArm",
  lefthand: "Normalized_J_Bip_L_Hand",
  rightshoulder: "Normalized_J_Bip_R_Shoulder",
  rightupperarm: "Normalized_J_Bip_R_UpperArm",
  rightlowerarm: "Normalized_J_Bip_R_LowerArm",
  righthand: "Normalized_J_Bip_R_Hand",
  leftupperleg: "Normalized_J_Bip_L_UpperLeg",
  leftlowerleg: "Normalized_J_Bip_L_LowerLeg",
  leftfoot: "Normalized_J_Bip_L_Foot",
  lefttoebase: "Normalized_J_Bip_L_ToeBase",
  rightupperleg: "Normalized_J_Bip_R_UpperLeg",
  rightlowerleg: "Normalized_J_Bip_R_LowerLeg",
  rightfoot: "Normalized_J_Bip_R_Foot",
  righttoebase: "Normalized_J_Bip_R_ToeBase",
};

// Add fingers
["L", "R"].forEach((side) => {
  const prefix = side === "L" ? "left" : "right";
  ["Thumb", "Index", "Middle", "Ring"].forEach((f) => {
    [1, 2, 3].forEach((n) => {
      vrmBoneMap[(prefix + "hand" + f + n).toLowerCase()] =
        `Normalized_J_Bip_${side}_${f}${n}`;
    });
  });
  [1, 2, 3].forEach((n) => {
    vrmBoneMap[(prefix + "handpinky" + n).toLowerCase()] =
      `Normalized_J_Bip_${side}_Little${n}`;
  });
});

export function retargetClip(
  sourceClip: THREE.AnimationClip,
  targetModel: THREE.Object3D,
  options: RetargetOptions = {}
): THREE.AnimationClip {
  const { clipName } = options;
  const newTracks: THREE.KeyframeTrack[] = [];

  for (const track of sourceClip.tracks) {
    const dotIndex = track.name.indexOf(".");
    if (dotIndex === -1) continue;

    const sourceBoneName = track.name.slice(0, dotIndex);
    const property = track.name.slice(dotIndex); // .quaternion or .position

    const clean = sourceBoneName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const bare = clean.replace(/^mixamorig/, "");

    const targetBoneName = vrmBoneMap[bare];
    if (!targetBoneName) continue;

    const isPosition = property.includes("position");
    const isHips = bare.includes("hip");

    if (isPosition) {
      // Only retain horizontal movement (XZ) on Hips for root motion walking/running, or skip for in-place
      if (isHips && !options.inPlace) {
        const times = track.times;
        const values = track.values.slice();
        // Scale down Mixamo's centimeter translation to meter world units cleanly
        for (let i = 0; i < values.length; i += 3) {
          values[i] *= 0.01;     // X
          values[i + 1] *= 0.01; // Y
          values[i + 2] *= 0.01; // Z
        }
        const posTrack = new THREE.VectorKeyframeTrack(
          `${targetBoneName}.position`,
          times,
          values
        );
        newTracks.push(posTrack);
      }
      continue;
    }

    if (property.includes("quaternion")) {
      const clonedTrack = track.clone();
      clonedTrack.name = `${targetBoneName}.quaternion`;
      newTracks.push(clonedTrack);
    }
  }

  return new THREE.AnimationClip(
    clipName || sourceClip.name,
    sourceClip.duration,
    newTracks
  );
}

export function normalizeCharacter(
  object: THREE.Object3D,
  targetHeight: number = 2.0
): { scale: number; box: THREE.Box3 } {
  object.position.set(0, 0, 0);
  object.scale.set(1, 1, 1);
  object.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());

  const currentHeight = size.y > 0 ? size.y : 1.0;
  const scale = targetHeight / currentHeight;

  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(object);
  const scaledCenter = scaledBox.getCenter(new THREE.Vector3());

  object.position.x = -scaledCenter.x;
  object.position.y = -scaledBox.min.y;
  object.position.z = -scaledCenter.z;
  object.updateMatrixWorld(true);

  return { scale, box: scaledBox };
}
