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
  Running_Jump: "Jumping",
  Prone_Idle: "Crouch_Idle",
  Prone_Crawl: "Crouched_Walking",
};

export const ANIMATIONS: AnimationInfo[] = [
  // Locomotion
  {
    id: "Idle",
    name: "Idle Stance",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Idle.json",
    loop: true,
    hotkey: "I",
  },
  {
    id: "Walking",
    name: "Walking",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Walking.json",
    loop: true,
    hotkey: "W",
  },
  {
    id: "Running",
    name: "Sprint / Run",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Running.json",
    loop: true,
    hotkey: "Shift+W",
  },
  {
    id: "Jumping",
    name: "Jump",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Jumping.json",
    loop: false,
    hotkey: "Space",
  },
  {
    id: "Running_Jump",
    name: "Running Jump",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Jumping.json",
    loop: false,
  },
  {
    id: "Crouch_Idle",
    name: "Crouch Idle",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Crouch_Idle.json",
    loop: true,
    hotkey: "C",
  },
  {
    id: "Crouched_Walking",
    name: "Crouch Walk",
    category: "locomotion",
    jsonPath: "/assets/3d/animations/json/Crouched_Walking.json",
    loop: true,
    hotkey: "C+WASD",
  },

  { id: "Prone_Idle", name: "Prone Idle", category: "locomotion", jsonPath: "/assets/3d/animations/vrm-json/Prone_Idle.json", loop: true, hotkey: "X" },
  { id: "Prone_Crawl", name: "Prone Crawl", category: "locomotion", jsonPath: "/assets/3d/animations/vrm-json/Prone_Crawl.json", loop: true },
  // Special
  {
    id: "Hip_Hop_Dancing",
    name: "Victory Dance",
    category: "special",
    jsonPath: "/assets/3d/animations/json/Hip_Hop_Dancing.json",
    loop: true,
    hotkey: "E",
  },
];
