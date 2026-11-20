export interface CharacterInfo {
  id: string;
  name: string;
  subtitle: string;
  path: string;
  heightOffset?: number;
  scale?: number;
  rotationY?: number;
  credit: {
    author: string;
    title: string;
    license: string;
    url: string;
  };
}

export type AnimationCategory = "locomotion" | "special";

export interface AnimationInfo {
  id: string;
  name: string;
  category: AnimationCategory;
  jsonPath: string;
  fbxPath?: string;
  loop: boolean;
  hotkey?: string;
  iconName?: string;
}

export const CHARACTERS: CharacterInfo[] = [
  {
    id: "character-2",
    name: "Explorer",
    subtitle: "VRoid Character",
    path: "/assets/3d/characters/character-2/male-1.gltf",
    scale: 1.0,
    rotationY: 0,
    credit: {
      author: "User Import",
      title: "VRoid Character",
      license: "Custom",
      url: "",
    },
  },
];

// Used when a clip file is missing: first existing entry in the chain wins.
export const ANIM_FALLBACK: Record<string, string> = {
  Walking_Jump: "Jumping",
  Running_Jump: "Walking_Jump",
  Sitting: "Idle",
  Sitting_Ground: "Sitting",
  Sleeping: "Idle",
};

export const ANIMATIONS: AnimationInfo[] = [
  // Locomotion
  {
    id: "Idle",
    name: "Idle Stance",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Idle.json",
    loop: true,
    hotkey: "I",
  },
  {
    id: "Walking",
    name: "Walking",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Walking.json",
    loop: true,
    hotkey: "W",
  },
  {
    id: "Running",
    name: "Run / Jog",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Running.json",
    loop: true,
    hotkey: "Shift+W",
  },
  {
    id: "Jumping",
    name: "Idle Jump",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Jumping.json",
    loop: false,
    hotkey: "Space",
  },
  {
    id: "Walking_Jump",
    name: "Walk Jump",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Walking_Jump.json",
    loop: false,
    hotkey: "W+Space",
  },
  {
    id: "Running_Jump",
    name: "Running Jump",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Running_Jump.json",
    loop: false,
    hotkey: "Shift+Space",
  },
  {
    id: "Sitting",
    name: "Sit (Chair)",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Sitting.json",
    loop: true,
    hotkey: "K",
  },
  {
    id: "Sitting_Ground",
    name: "Sit (Ground)",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Sitting_Ground.json",
    loop: true,
    hotkey: "J",
  },
  {
    id: "Sleeping",
    name: "Sleep / Rest",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/vrm-json/Sleeping.json",
    loop: true,
    hotkey: "L",
  },
  // Special
  {
    id: "Hip_Hop_Dancing",
    name: "Victory Dance",
    category: "special",
    jsonPath: "/assets/3d/animations/vrm-json/Hip_Hop_Dancing.json",
    loop: true,
    hotkey: "E",
  },
];
