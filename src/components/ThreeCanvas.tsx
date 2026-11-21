"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRM } from "@pixiv/three-vrm";
import { CHARACTERS, ANIMATIONS, ANIM_FALLBACK } from "@/lib/types";
import { loadMixamoClip } from "@/lib/mixamoRetarget";
import { normalizeCharacter } from "@/lib/retarget";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { ColorBoostShader } from "@/lib/colorBoostShader";
import { SharpenShader } from "@/lib/sharpenShader";
import { createStylizedWorld, getWorldHeight, StylizedWorld } from "@/lib/stylizedWorld";
import {
  ThirdPersonController,
  LocomotionState,
  PlayerTelemetry,
  JumpProfile,
} from "@/lib/characterController";

export type LightingMood = "cyber" | "tactical" | "studio";
export type CameraPreset =
  | "full"
  | "upper"
  | "face"
  | "side"
  | "drone"
  | "lake"
  | "town"
  | "map3k"
  | "mountains"
  | "school"
  | "park"
  | "supermarket"
  | "apartment";
export type GraphicsQuality = "low" | "medium" | "high";

function getPixelRatioCap(quality: GraphicsQuality): number {
  const dpr = window.devicePixelRatio || 1;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const constrained = (navigator.hardwareConcurrency || 8) <= 4 ||
    (memory !== undefined && memory <= 4) || window.matchMedia("(max-width: 768px)").matches;
  const cap = quality === "low" ? (constrained ? 0.85 : 1) :
    quality === "medium" ? (constrained ? 1 : 1.35) : (constrained ? 1.25 : 1.75);
  return Math.min(dpr, cap);
}

const FOLLOW_CAMERA_PRESETS: ReadonlySet<CameraPreset> = new Set([
  "full",
  "upper",
  "face",
  "side",
]);

interface ThreeCanvasProps {
  selectedCharacterId: string;
  currentAnimationId: string;
  playbackSpeed: number;
  isPlaying: boolean;
  inPlace: boolean;
  showWireframe: boolean;
  showSkeleton: boolean;
  lightingMood: LightingMood;
  cameraPreset: CameraPreset;
  graphicsQuality?: GraphicsQuality;
  onLoaded?: () => void;
  onLocomotionChange?: (animId: LocomotionState) => void;
  onReturnToPlayerCamera?: () => void;
  onTelemetry?: (telemetry: PlayerTelemetry) => void;
  onDance?: () => void;
  onNearbyDoorChange?: (door: { houseId: string; open: boolean } | null) => void;
}

interface LoadedCharacter {
  id: string;
  name: string;
  group: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  skeletonHelper?: THREE.SkeletonHelper;
  vrm?: VRM;
}

export function ThreeCanvas({
  selectedCharacterId,
  currentAnimationId,
  playbackSpeed,
  isPlaying,
  inPlace,
  showWireframe,
  showSkeleton,
  lightingMood,
  cameraPreset,
  graphicsQuality = "medium",
  onLoaded,
  onLocomotionChange,
  onReturnToPlayerCamera,
  onTelemetry,
  onDance,
  onNearbyDoorChange,
}: ThreeCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const colorBoostRef = useRef<ShaderPass | null>(null);
  const fxaaRef = useRef<ShaderPass | null>(null);
  const sharpenRef = useRef<ShaderPass | null>(null);
  const maxPixelRatioRef = useRef(1);
  const adaptiveScaleRef = useRef(1);

  const charactersMapRef = useRef<Map<string, LoadedCharacter>>(new Map());
  const characterRef = useRef<LoadedCharacter | null>(null);
  const activeActionRef = useRef<THREE.AnimationAction | null>(null);
  const jumpProfilesRef = useRef<Record<string, JumpProfile>>({}); // measured from the Mixamo jump clips
  const controllerRef = useRef<ThirdPersonController | null>(null);

  const lightsGroupRef = useRef<THREE.Group | null>(null);
  const worldRef = useRef<StylizedWorld | null>(null);
  const lightingMoodRef = useRef(lightingMood);
  useEffect(() => {
    lightingMoodRef.current = lightingMood;
  }, [lightingMood]);
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [loadingText, setLoadingText] = useState<string>("Initializing Stylized World...");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Mutable refs for state accessed inside animation frame loop & async callbacks
  const isPlayingRef = useRef(isPlaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  const onLoadedRef = useRef(onLoaded);
  const onLocomotionChangeRef = useRef(onLocomotionChange);
  const onReturnToPlayerCameraRef = useRef(onReturnToPlayerCamera);
  const onTelemetryRef = useRef(onTelemetry);
  const onDanceRef = useRef(onDance);
  const onNearbyDoorChangeRef = useRef(onNearbyDoorChange);
  const automaticAnimationRef = useRef<string | null>(null);
  const nearbyDoorRef = useRef<{ houseId: string; open: boolean } | null>(null);
  const pendingDoorToggleRef = useRef(false);
  const currentAnimationIdRef = useRef(currentAnimationId);
  const selectedCharacterIdRef = useRef(selectedCharacterId);
  const showSkeletonRef = useRef(showSkeleton);
  const showWireframeRef = useRef(showWireframe);
  const cameraPresetRef = useRef(cameraPreset);
  const graphicsQualityRef = useRef(graphicsQuality);
  const inPlaceRef = useRef(inPlace);

  useEffect(() => {
    inPlaceRef.current = inPlace;
  }, [inPlace]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    onLocomotionChangeRef.current = onLocomotionChange;
  }, [onLocomotionChange]);

  useEffect(() => {
    onReturnToPlayerCameraRef.current = onReturnToPlayerCamera;
  }, [onReturnToPlayerCamera]);

  useEffect(() => {
    onTelemetryRef.current = onTelemetry;
  }, [onTelemetry]);

  useEffect(() => {
    onDanceRef.current = onDance;
  }, [onDance]);

  useEffect(() => {
    onNearbyDoorChangeRef.current = onNearbyDoorChange;
  }, [onNearbyDoorChange]);

  useEffect(() => {
    currentAnimationIdRef.current = currentAnimationId;
  }, [currentAnimationId]);

  useEffect(() => {
    selectedCharacterIdRef.current = selectedCharacterId;
  }, [selectedCharacterId]);

  useEffect(() => {
    showSkeletonRef.current = showSkeleton;
  }, [showSkeleton]);

  useEffect(() => {
    showWireframeRef.current = showWireframe;
  }, [showWireframe]);

  useEffect(() => {
    cameraPresetRef.current = cameraPreset;
  }, [cameraPreset]);

  useEffect(() => {
    graphicsQualityRef.current = graphicsQuality;
  }, [graphicsQuality]);

  // Atmospheric Lighting updater optimized for smooth FPS
  const updateLights = useCallback((mood: LightingMood, quality: GraphicsQuality) => {
    const lg = lightsGroupRef.current;
    const scene = sceneRef.current;
    if (!lg) return;

    lg.clear();
    worldRef.current?.setMood(mood);

    const shadowsEnabled = quality !== "low";

    if (mood === "cyber") {
      // Midnight Cyber Metropolis & Dark Forest with Neon Accents
      if (scene) {
        scene.background = new THREE.Color(0x0a0f1d);
        scene.fog = new THREE.FogExp2(0x0a0f1d, 0.0004);
      }

      const ambient = new THREE.AmbientLight(0x1e293b, 1.8);
      lg.add(ambient);

      // Distant Moonlight illuminating the 3km map (no shadow pass)
      const moon = new THREE.DirectionalLight(0xcfd8dc, 2.2);
      moon.position.set(100, 300, 150);
      moon.castShadow = false;
      lg.add(moon);

      // Hero contact shadow light tightly bounded around player
      const heroLight = new THREE.DirectionalLight(0xdbeafe, 2.8);
      heroLight.position.set(4, 9, 5);
      heroLight.castShadow = shadowsEnabled;
      heroLight.shadow.mapSize.width = 1024;
      heroLight.shadow.mapSize.height = 1024;
      heroLight.shadow.bias = -0.0005;
      heroLight.shadow.camera.near = 0.5;
      heroLight.shadow.camera.far = 22;
      heroLight.shadow.camera.left = -6;
      heroLight.shadow.camera.right = 6;
      heroLight.shadow.camera.top = 6;
      heroLight.shadow.camera.bottom = -6;
      lg.add(heroLight);

      // Storefront neon cyan
      const cyanRim = new THREE.DirectionalLight(0x38bdf8, 1.8);
      cyanRim.position.set(-5, 4, -4);
      lg.add(cyanRim);

      // Vending machine accent glow
      const neonVending = new THREE.PointLight(0xf43f5e, 2.5, 8);
      neonVending.position.set(3, 1.5, -3.8);
      lg.add(neonVending);
    } else if (mood === "tactical") {
      // Warm Anime Ghibli/Genshin Daytime across Island & Sea
      if (scene) {
        scene.background = new THREE.Color(0x64b5f6);
        scene.fog = new THREE.FogExp2(0xcce8ff, 0.00014);
      }
      // Sun, sky bounce and soft shadows come from the stylized world light rig.
    } else {
      // Clean Studio Void
      if (scene) {
        scene.background = new THREE.Color(0x18181b);
        scene.fog = new THREE.FogExp2(0x18181b, 0.0005);
      }

      const ambient = new THREE.AmbientLight(0xffffff, 1.4);
      lg.add(ambient);

      const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
      keyLight.position.set(3, 13.5, 13.5);
      keyLight.target.position.set(0, 5.50, 8.5);
      lg.add(keyLight.target);
      keyLight.castShadow = shadowsEnabled;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.camera.near = 0.5;
      keyLight.shadow.camera.far = 20;
      keyLight.shadow.camera.left = -5;
      keyLight.shadow.camera.right = 5;
      keyLight.shadow.camera.top = 5;
      keyLight.shadow.camera.bottom = -5;
      lg.add(keyLight);

      const fill = new THREE.DirectionalLight(0x94a3b8, 1.5);
      fill.position.set(-4, 8.5, 10.5);
      lg.add(fill);
    }
  }, []);

  // Dynamic renderer quality tuning for low-end / mobile GPU support
  useEffect(() => {
    const renderer = rendererRef.current;
    const composer = composerRef.current;
    if (!renderer) return;

    const pixelRatio = getPixelRatioCap(graphicsQuality);
    maxPixelRatioRef.current = pixelRatio;
    renderer.setPixelRatio(pixelRatio);
    composer?.setPixelRatio(pixelRatio);

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const bloom = bloomRef.current;
    if (bloom) {
      bloom.enabled = graphicsQuality !== "low";
      bloom.strength = graphicsQuality === "high" ? 0.045 : 0.03;
      bloom.threshold = 0.92;
      bloom.radius = 0.50;
    }

    const colorBoost = colorBoostRef.current;
    if (colorBoost) {
      colorBoost.enabled = graphicsQuality !== "low";
      colorBoost.uniforms["saturation"].value = 1.45;
    }

    const fxaa = fxaaRef.current;
    if (fxaa) {
      fxaa.enabled = graphicsQuality !== "low";
      fxaa.uniforms["resolution"].value.set(1 / (window.innerWidth * pixelRatio), 1 / (window.innerHeight * pixelRatio));
    }

    const sharpen = sharpenRef.current;
    if (sharpen) {
      sharpen.enabled = true;
      sharpen.uniforms["sharpness"].value = 0.20;
      sharpen.uniforms["resolution"].value.set(1 / (window.innerWidth * pixelRatio), 1 / (window.innerHeight * pixelRatio));
    }

    const container = containerRef.current;
    if (container) {
      const width = Math.max(container.clientWidth || window.innerWidth || 800, 1);
      const height = Math.max(container.clientHeight || window.innerHeight || 600, 1);
      renderer.setSize(width, height);
      composer?.setSize(width, height);
    }
    updateLights(lightingMoodRef.current, graphicsQuality);
  }, [graphicsQuality, updateLights]);

  // Camera preset handler
  const setCameraView = useCallback((preset: CameraPreset) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const scene = sceneRef.current;
    if (!camera || !controls) return;

    const ctrl = controllerRef.current;
    const world = worldRef.current;
    const px = ctrl ? ctrl.position.x : 0;
    const py = ctrl ? ctrl.position.y : getWorldHeight(0, 8.5);
    const pz = ctrl ? ctrl.position.z : 8.5;
    const yaw = ctrl ? ctrl.yaw : Math.PI;
    const backX = -Math.sin(yaw);
    const backZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    const isFollow = FOLLOW_CAMERA_PRESETS.has(preset);
    controls.minDistance = isFollow ? 0.35 : 0.6;
    controls.maxDistance = isFollow ? 18 : 12000;
    camera.fov = 45;
    camera.near = preset === "map3k" ? 50 : isFollow ? 0.12 : 1.5;
    camera.updateProjectionMatrix();
    if (!isFollow && world) {
      if (preset === "map3k") {
        const half = world.bounds.halfExtent;
        const fit = half / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        const distance = fit * Math.max(1, 1 / camera.aspect) * 1.13;
        controls.target.set(0, 0, 170);
        camera.position.set(0, distance, 170 + distance * 0.13);
      } else {
        const key = preset === "drone" ? "harbour" : preset;
        const landmark = world.landmarks[key] ?? world.landmarks.town;
        controls.target.copy(landmark.position);
        const offset = preset === "drone" ? new THREE.Vector3(100, 160, 180)
          : preset === "mountains" ? new THREE.Vector3(-170, 65, 180)
          : preset === "lake" ? new THREE.Vector3(80, 26, 100)
          : preset === "school" ? new THREE.Vector3(45, 30, 75)
          : preset === "supermarket" ? new THREE.Vector3(48, 20, 20)
          : preset === "apartment" ? new THREE.Vector3(30, 20, -48)
          : preset === "park" ? new THREE.Vector3(35, 22, 38)
          : new THREE.Vector3(28, 22, 36);
        camera.position.copy(landmark.position).add(offset);
      }
      if (scene?.fog && "density" in scene.fog) {
        (scene.fog as THREE.FogExp2).density = preset === "map3k" ? 0.000025 : 0.00014;
      }
      controls.update();
      return;
    }

    switch (preset) {
      case "full":
        if (ctrl) {
          ctrl.snapCameraBehindPlayer(camera, controls, 4.2, 1.65);
        } else {
          camera.position.set(px + backX * 4.2, py + 1.65, pz + backZ * 4.2);
          controls.target.set(px, py + 1.38, pz);
        }
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.00014;
        }
        break;
      case "upper":
        camera.position.set(px + backX * 2.1, py + 1.55, pz + backZ * 2.1);
        controls.target.set(px, py + 1.4, pz);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.00014;
        }
        break;
      case "face":
        camera.position.set(px + backX * 1.3, py + 1.78, pz + backZ * 1.3);
        controls.target.set(px, py + 1.72, pz);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.00014;
        }
        break;
      case "side":
        camera.position.set(
          px + rightX * 3.4 + backX * 0.4,
          py + 1.4,
          pz + rightZ * 3.4 + backZ * 0.4
        );
        controls.target.set(px, py + 1.15, pz);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.00014;
        }
        break;
      case "drone":
        camera.position.set(90, 130, 150);
        controls.target.set(30, 15, -40);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.0006;
        }
        break;
      case "lake":
        // Meadow Pond view
        camera.position.set(-7, 7.6, -1);
        controls.target.set(-24, 5.0, -16);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.00014;
        }
        break;
      case "town":
        // Modular Japanese Town Street view
        camera.position.set(12, 9.5, -28);
        controls.target.set(0, 8.0, -72);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.00014;
        }
        break;
      case "mountains":
        // Surrounding hills & cliffs view
        camera.position.set(-60, 16.0, 70);
        controls.target.set(140, 32.0, -110);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.0006;
        }
        break;
      case "map3k":
        camera.position.set(0, 260, 180);
        controls.target.set(0, 5.5, -20);
        if (scene?.fog && "density" in scene.fog) {
          (scene.fog as THREE.FogExp2).density = 0.0002;
        }
        break;
    }
    controls.update();
  }, []);

  // Synchronize animation playback on current active character
  const playAnimation = useCallback((animId: string, fadeDuration = 0.16) => {
    const char = characterRef.current;
    if (!char) return;

    let targetAction = char.actions.get(animId);
    let chainId = animId;
    for (let i = 0; !targetAction && i < 4 && ANIM_FALLBACK[chainId]; i++) {
      chainId = ANIM_FALLBACK[chainId];
      targetAction = char.actions.get(chainId);
    }
    if (!targetAction) {
      targetAction = char.actions.get("Idle") || char.actions.values().next().value;
    }

    const currentActive = activeActionRef.current;
    if (targetAction && targetAction !== currentActive) {
      if (currentActive) {
        currentActive.fadeOut(fadeDuration);
      }
      const loops = (a: THREE.AnimationAction) => a.loop === THREE.LoopRepeat;
      const phase =
        currentActive && loops(currentActive) && loops(targetAction)
          ? (currentActive.time % currentActive.getClip().duration) /
            currentActive.getClip().duration
          : 0;
      targetAction
        .reset()
        .setEffectiveTimeScale(1)
        .setEffectiveWeight(1)
        .fadeIn(fadeDuration)
        .play();
      // keep foot phase when switching walk <-> run so feet do not pop
      if (phase > 0) targetAction.time = phase * targetAction.getClip().duration;

      activeActionRef.current = targetAction;
    }
  }, []);

  // Main Three.js Scene Setup
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setLoadError(null);
    setLoadingProgress(10);

    const width = Math.max(container.clientWidth || window.innerWidth || 800, 1);
    const height = Math.max(container.clientHeight || window.innerHeight || 600, 1);

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    (window as unknown as { __threeScene: THREE.Scene }).__threeScene = scene;
    scene.background = new THREE.Color(0x64b5f6);
    scene.fog = new THREE.FogExp2(0xcce8ff, 0.00014);

    // 2. Camera: Up to 8km far plane
    const camera = new THREE.PerspectiveCamera(
      45,
      width / height,
      0.2,
      16000
    );
    camera.position.set(0, 6.75, 12.5);
    cameraRef.current = camera;
    (window as unknown as { __threeCamera: THREE.PerspectiveCamera }).__threeCamera = camera;

    // 3. Renderer with high performance & smooth anime graphics
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    maxPixelRatioRef.current = getPixelRatioCap(graphicsQualityRef.current);
    renderer.setPixelRatio(maxPixelRatioRef.current);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.96;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Keep the post-processing pipeline available across quality switches.
    let composer: EffectComposer | null = null;
    let bloom: UnrealBloomPass | undefined;
    let output: OutputPass | undefined;
    let colorBoost: ShaderPass | undefined;
    let fxaa: ShaderPass | undefined;
    let sharpen: ShaderPass | undefined;

    try {
      const renderTarget = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        samples: graphicsQualityRef.current === "high" ? 4 : graphicsQualityRef.current === "medium" ? 2 : 0,
      });
      composer = new EffectComposer(renderer, renderTarget);
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        graphicsQualityRef.current === "high" ? 0.045 : 0.03,
        0.50,
        0.92
      );
      bloom.enabled = graphicsQualityRef.current !== "low";
      composer.addPass(bloom);
      output = new OutputPass();
      composer.addPass(output);

      colorBoost = new ShaderPass(ColorBoostShader);
      colorBoost.enabled = graphicsQualityRef.current !== "low";
      composer.addPass(colorBoost);

      fxaa = new ShaderPass(FXAAShader);
      const pr = maxPixelRatioRef.current;
      fxaa.uniforms["resolution"].value.set(1 / (width * pr), 1 / (height * pr));
      fxaa.enabled = graphicsQualityRef.current !== "low";
      composer.addPass(fxaa);

      sharpen = new ShaderPass(SharpenShader);
      sharpen.uniforms["sharpness"].value = 0.20;
      sharpen.uniforms["resolution"].value.set(1 / (width * pr), 1 / (height * pr));
      sharpen.enabled = true;
      composer.addPass(sharpen);

      composer.setPixelRatio(maxPixelRatioRef.current);
      composer.setSize(width, height);
      composerRef.current = composer;
      bloomRef.current = bloom;
      colorBoostRef.current = colorBoost;
      fxaaRef.current = fxaa;
      sharpenRef.current = sharpen;
    } catch (e) {
      console.warn("EffectComposer initialization skipped, falling back to direct render:", e);
      composer = null;
    }

    // 4. OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.minDistance = 0.6;
    controls.maxDistance = 12000;
    controls.target.set(0, 6.45, 8.5);
    controlsRef.current = controls;
    (window as unknown as { __threeControls: OrbitControls }).__threeControls = controls;

    // 5. Lighting group
    const lightsGroup = new THREE.Group();
    scene.add(lightsGroup);
    lightsGroupRef.current = lightsGroup;
    updateLights(lightingMoodRef.current, graphicsQuality);

    // 6. Third-Person Character Movement & Camera Controller
    let lastTelemetryAt = 0;
    const spawnX = 0;
    const spawnZ = 8.5;
    const controller = new ThirdPersonController({
      spawnX,
      spawnZ,
      initialYaw: Math.PI,
      worldHalfExtent: 2500,
      onLocomotionChange: (locomotion, timeScale = 1, jump) => {
        const isJump = locomotion === "Jumping" || locomotion === "Walking_Jump" || locomotion === "Running_Jump";
        playAnimation(locomotion, isJump ? 0.06 : 0.14);
        const act = activeActionRef.current;
        const jp = jumpProfilesRef.current[locomotion];
        if (act && isJump && jump && jp) {
          // physics drives the clip frame by frame: wind-up -> takeoff..touchdown
          // (by vertical velocity) -> the clip's own landing recovery
          const t =
            jump.stage === "windup"
              ? jp.takeoff - jump.windup + jump.t
              : jump.stage === "air"
                ? jp.takeoff + jump.t * (jp.land - jp.takeoff)
                : jp.land + jump.t;
          act.setEffectiveTimeScale(0);
          act.time = Math.min(Math.max(t, 0), act.getClip().duration);
        } else {
          act?.setEffectiveTimeScale(timeScale);
        }
        if (currentAnimationIdRef.current !== locomotion) {
          currentAnimationIdRef.current = locomotion;
          automaticAnimationRef.current = locomotion;
          onLocomotionChangeRef.current?.(locomotion);
        }
      },
      onMovementStart: () => {
        if (!FOLLOW_CAMERA_PRESETS.has(cameraPresetRef.current)) {
          onReturnToPlayerCameraRef.current?.();
        }
      },
      onTelemetry: (telemetry) => {
        const now = performance.now();
        if (now - lastTelemetryAt >= 200) {
          lastTelemetryAt = now;
          onTelemetryRef.current?.(telemetry);
        }
      },
      onInteract: () => {
        const world = worldRef.current;
        if (world?.toggleNearestDoor(controller.position)) {
          pendingDoorToggleRef.current = true;
          return true;
        }
        onDanceRef.current?.();
        return false;
      },
    });
    controllerRef.current = controller;

    // 7. Build the Stylized World & Load Character
    let isCancelled = false;
    const abortController = new AbortController();
    let loadedWorld: StylizedWorld | null = null;
    let ownedCharacter: LoadedCharacter | null = null;
    const debugWindow = window as unknown as { __islandDebug?: {
      world: StylizedWorld; controller: ThirdPersonController; renderer: THREE.WebGLRenderer;
      scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
      frameMs: number[];
    } };
    characterRef.current = null;
    charactersMapRef.current.clear();
    activeActionRef.current = null;
    setLoadingText("Initializing 3D World & Terrain…");

    async function loadAssets() {
      try {
        setLoadingProgress(20);
        setLoadingText("Synthesizing Island Heightmap & Textures...");

        const world = await createStylizedWorld(scene, renderer, graphicsQualityRef.current, (t) => {
          if (!isCancelled) {
            setLoadingText(t);
            setLoadingProgress((prev) => Math.min(prev + 10, 68));
          }
        }, abortController.signal);

        if (isCancelled) {
          world.dispose();
          return;
        }
        loadedWorld = world;
        worldRef.current = world;
        controller.setWorld(world.spatial, world.bounds.halfExtent, world.spawn);
        world.setMood(lightingMoodRef.current);
        setLoadingProgress(70);
        setLoadingText("Loading Character & Rig...");

        // Load Character 2 (VRM 1.0)
        const vrmLoader = new GLTFLoader();
        vrmLoader.register((parser) => new VRMLoaderPlugin(parser));

        const charInfo = CHARACTERS.find((c) => c.id === "character-2") || CHARACTERS[0];
        const gltf = await vrmLoader.loadAsync(charInfo.path);
        if (isCancelled) return;

        const vrm = gltf.userData.vrm as VRM;
        const model = vrm ? vrm.scene : gltf.scene;

        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = false;
            if (mesh.material) {
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mats.forEach((m) => {
                if (m.name.includes("(Outline)")) {
                  m.visible = false;
                }
                if (
                  "uniforms" in m &&
                  (m as unknown as { uniforms?: { outlineWidthFactor?: { value: number } } }).uniforms?.outlineWidthFactor
                ) {
                  (m as unknown as { uniforms: { outlineWidthFactor: { value: number } } }).uniforms.outlineWidthFactor.value = 0;
                }
              });
            }
          }
        });

        if (vrm && vrm.materials) {
          vrm.materials.forEach((mat) => {
            if (mat && "shadingShiftFactor" in mat) {
              (mat as unknown as { shadingShiftFactor: number }).shadingShiftFactor = Math.min(
                (mat as unknown as { shadingShiftFactor: number }).shadingShiftFactor,
                0.0
              );
            }
          });
        }

        normalizeCharacter(model, 2.0);

        const group = new THREE.Group();
        group.name = charInfo.id;
        group.position.copy(controller.position);
        group.rotation.y = Math.PI; // Face north toward fountain & town square
        group.add(model);
        scene.add(group);

        const mixer = new THREE.AnimationMixer(model);
        const skeletonHelper = new THREE.SkeletonHelper(model);
        skeletonHelper.visible = false;
        scene.add(skeletonHelper);

        const actions = new Map<string, THREE.AnimationAction>();
        ownedCharacter = { id: charInfo.id, name: charInfo.name, group, model, mixer, actions, skeletonHelper, vrm };

        setLoadingProgress(88);
        setLoadingText("Retargeting Movement & Emote Animations...");

        const strides: Record<string, number> = {};
        const unitScale = model.scale.x || 1;
        let baked: Record<string, number> = {};
        let jumps: Record<string, JumpProfile> = {};

        // Parallel metadata load for strides & jumps
        const [rStrides, rJumps] = await Promise.all([
          fetch("/assets/3d/animations/mixamo/strides.json").catch(() => null),
          fetch("/assets/3d/animations/mixamo/jumps.json").catch(() => null),
        ]);
        if (rStrides && rStrides.ok) baked = await rStrides.json().catch(() => ({}));
        if (rJumps && rJumps.ok) jumps = await rJumps.json().catch(() => ({}));
        jumpProfilesRef.current = jumps;

        const loadClip = async (anim: (typeof ANIMATIONS)[number]) => {
          if (isCancelled) return;
          try {
            let clip: THREE.AnimationClip | null = null;
            // 1. Check pre-baked VRM animation JSON first (fast JSON parse in ~1ms vs 300ms heavy FBX retargeting)
            const res = await fetch(`/assets/3d/animations/vrm-json/${anim.id}.json`).catch(() => null);
            if (res && res.ok) {
              try {
                clip = THREE.AnimationClip.parse(await res.json());
                const plant = baked[anim.id];
                if (typeof plant === "number" && plant > 0) strides[anim.id] = plant;
              } catch {}
            }
            // 2. Fall back to Mixamo FBX retargeting if VRM JSON is not available
            if (!clip && anim.id !== "Hip_Hop_Dancing") {
              try {
                const jp = jumps[anim.id];
                const r = await loadMixamoClip(
                  `/assets/3d/animations/mixamo/${anim.id}.fbx`,
                  model,
                  {
                    loop: anim.loop,
                    jumpArc: jp ? { takeoff: jp.takeoff, land: jp.land, v: jp.v, g: jp.g } : undefined,
                    unitScale,
                    vrmMetaVersion: (vrm as unknown as { meta?: { metaVersion?: string } } | null)?.meta?.metaVersion,
                  }
                );
                clip = r.clip;
                const plant = baked[anim.id];
                if (typeof plant === "number" && plant > 0) strides[anim.id] = plant;
                else if (r.strideSpeed > 0) strides[anim.id] = r.strideSpeed;
              } catch {}
            }
            if (isCancelled || !clip) return;
            clip.name = anim.id;
            const action = mixer.clipAction(clip);
            if (!anim.loop) {
              action.setLoop(THREE.LoopOnce, 1);
              action.clampWhenFinished = true;
            }
            actions.set(anim.id, action);
          } catch {
            // ignore individual clip error
          }
        };

        // Parallel load essential locomotion clips first so the world becomes ready immediately
        const primaryAnims = ANIMATIONS.filter(a =>
          a.id === "Idle" || a.id === "Walking" || a.id === "Running" ||
          a.id === "Jumping" || a.id === "Walking_Jump" || a.id === "Running_Jump" ||
          a.id === "Sitting" || a.id === "Sitting_Ground" || a.id === "Sleeping"
        );
        const secondaryAnims = ANIMATIONS.filter(a => !primaryAnims.includes(a));

        await Promise.all(primaryAnims.map(loadClip));
        if (isCancelled) return;
        controller.setStrideSpeeds(strides);
        controller.setJumpProfiles(jumps, unitScale);


        const loadedChar = ownedCharacter;
        if (!loadedChar || isCancelled) return;

        const loadedChars = new Map<string, LoadedCharacter>();
        loadedChars.set(charInfo.id, loadedChar);
        charactersMapRef.current = loadedChars;
        characterRef.current = loadedChar;
        if (process.env.NODE_ENV === "development") {
          debugWindow.__islandDebug = { world, controller, renderer, scene, camera, controls, frameMs: [] };
          renderer.info.autoReset = false;
        }

        setLoadingProgress(100);
        setLoadingText("Ready!");

        setCameraView(cameraPresetRef.current);
        controller.setManualAnimationOverride(currentAnimationIdRef.current);
        playAnimation(currentAnimationIdRef.current);

        if (onLoadedRef.current) onLoadedRef.current();

        // Stream in emotes (dance, prone) in background without delaying entrance to the island
        if (secondaryAnims.length > 0) {
          Promise.all(secondaryAnims.map(loadClip)).then(() => {
            if (!isCancelled) {
              controller.setStrideSpeeds(strides);
            }
          });
        }
      } catch (err) {
        if (!isCancelled) {
          console.error("Failed loading assets:", err);
          setLoadingText("Failed loading island: " + (err instanceof Error ? err.message : String(err)));
        }
      }
    }

    loadAssets();

    // 8. Animation & Render Loop
    let lastTime = performance.now();
    let animationFrameId: number;
    let doorCheckTimer = 0, maintenanceTimer = 0;

    const handleVisibility = () => {
      lastTime = performance.now();
      if (document.hidden) cancelAnimationFrame(animationFrameId);
      else animationFrameId = requestAnimationFrame(animate);
    };

    const animate = () => {
      if (document.hidden) return;
      animationFrameId = requestAnimationFrame(animate);

      const now = performance.now();
      const frameMs = Math.min(now - lastTime, 100);
      const delta = frameMs / 1000;
      lastTime = now;

      const char = characterRef.current;
      if (char) {
        controller.update(
          delta,
          char.group,
          camera,
          controls,
          FOLLOW_CAMERA_PRESETS.has(cameraPresetRef.current),
          inPlaceRef.current
        );
        if (isPlayingRef.current) {
          char.mixer.update(delta * playbackSpeedRef.current);
          if (char.vrm) {
            char.vrm.update(delta * playbackSpeedRef.current);
          }
        }
      }

      controls.update();
      if (FOLLOW_CAMERA_PRESETS.has(cameraPresetRef.current)) controller.constrainCamera(camera, controls);
      maintenanceTimer += delta;
      if (maintenanceTimer >= 0.033) {
        worldRef.current?.update(maintenanceTimer, camera, controls.target, controller.position);
        maintenanceTimer = 0;
      }

      doorCheckTimer += delta;
      if (doorCheckTimer >= 0.1 || pendingDoorToggleRef.current) {
        doorCheckTimer = 0;
        const nearbyDoor = worldRef.current?.nearestDoor(controller.position) ?? null;
        const priorDoor = nearbyDoorRef.current;
        const doorChanged = pendingDoorToggleRef.current ||
          priorDoor?.houseId !== nearbyDoor?.houseId || priorDoor?.open !== nearbyDoor?.open;
        if (doorChanged) {
          pendingDoorToggleRef.current = false;
          nearbyDoorRef.current = nearbyDoor ? { houseId: nearbyDoor.houseId, open: nearbyDoor.open } : null;
          onNearbyDoorChangeRef.current?.(nearbyDoor ? { houseId: nearbyDoor.houseId, open: nearbyDoor.open } : null);
        }
      }

      renderer.info.reset();
      if (composer) {
        composer.render(delta);
      } else {
        renderer.render(scene, camera);
      }
      const debug = debugWindow.__islandDebug;
      if (debug?.renderer === renderer) {
        debug.frameMs.push(delta * 1000);
        if (debug.frameMs.length > 120) debug.frameMs.shift();
      }
    };

    animate();

    // 9. Resize Listener
    const handleResize = () => {
      if (!container || !camera || !renderer) return;
      const width = Math.max(container.clientWidth || window.innerWidth || 800, 1);
      const height = Math.max(container.clientHeight || window.innerHeight || 600, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer?.setSize(width, height);
      if (fxaaRef.current) {
        const pr = maxPixelRatioRef.current;
        fxaaRef.current.uniforms["resolution"].value.set(1 / (width * pr), 1 / (height * pr));
      }
      if (sharpenRef.current) {
        const pr = maxPixelRatioRef.current;
        sharpenRef.current.uniforms["resolution"].value.set(1 / (width * pr), 1 / (height * pr));
      }
    };

    window.addEventListener("resize", handleResize);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      isCancelled = true;
      abortController.abort();
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibility);
      controller.dispose();
      controllerRef.current = null;
      loadedWorld?.dispose();
      if (debugWindow.__islandDebug?.renderer === renderer) delete debugWindow.__islandDebug;
      worldRef.current = null;
      if (ownedCharacter) {
        ownedCharacter.mixer.stopAllAction();
        ownedCharacter.mixer.uncacheRoot(ownedCharacter.model);
        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        const textures = new Set<THREE.Texture>();
        ownedCharacter.model.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(material);
            for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          }
        });
        geometries.forEach(geometry => geometry.dispose());
        materials.forEach(material => material.dispose());
        textures.forEach(texture => texture.dispose());
        ownedCharacter.skeletonHelper?.dispose();
        ownedCharacter.group.removeFromParent();
      }
      charactersMapRef.current.clear();
      characterRef.current = null;
      activeActionRef.current = null;
      controls.dispose();
      bloom?.dispose();
      output?.dispose();
      colorBoost?.dispose();
      colorBoostRef.current = null;
      fxaa?.dispose();
      fxaaRef.current = null;
      sharpen?.dispose();
      sharpenRef.current = null;
      composer?.dispose();
      if (composerRef.current === composer) composerRef.current = null;
      renderer.dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      rendererRef.current = null;
      lightsGroupRef.current = null;
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Handle active character switching
  useEffect(() => {
    const chars = charactersMapRef.current;
    if (!chars || chars.size === 0) return;

    if (activeActionRef.current) {
      activeActionRef.current.fadeOut(0.2);
    }

    chars.forEach((char, id) => {
      const isSelected = id === selectedCharacterId;
      char.group.visible = isSelected;
      if (char.skeletonHelper) {
        char.skeletonHelper.visible = isSelected && showSkeleton;
      }
    });

    const newChar = chars.get(selectedCharacterId);
    if (newChar) {
      characterRef.current = newChar;
      activeActionRef.current = null;
      playAnimation(currentAnimationId);
    }
  }, [selectedCharacterId, showSkeleton, currentAnimationId, playAnimation]);

  // Update lighting when mood or quality changes
  useEffect(() => {
    updateLights(lightingMood, graphicsQuality);
  }, [lightingMood, graphicsQuality, updateLights]);

  // Update camera preset when prop changes
  useEffect(() => {
    setCameraView(cameraPreset);
  }, [cameraPreset, setCameraView]);

  // Wireframe toggle across all loaded characters
  useEffect(() => {
    charactersMapRef.current.forEach((char) => {
      char.model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          materials.forEach((m) => {
            if (m && "wireframe" in m) {
              (m as { wireframe: boolean }).wireframe = showWireframe;
            }
          });
        }
      });
    });
  }, [showWireframe]);

  // Skeleton helper toggle
  useEffect(() => {
    const char = characterRef.current;
    if (char && char.skeletonHelper) {
      char.skeletonHelper.visible = showSkeleton;
    }
  }, [showSkeleton]);

  // Trigger animation transition when currentAnimationId changes
  useEffect(() => {
    if (automaticAnimationRef.current === currentAnimationId) {
      automaticAnimationRef.current = null;
      return;
    }
    controllerRef.current?.setManualAnimationOverride(currentAnimationId);
    playAnimation(currentAnimationId);
  }, [currentAnimationId, playAnimation]);

  return (
    <div className="relative w-full h-full select-none overflow-hidden">
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Loading Overlay */}
      {loadingProgress < 100 && (
        <div className="absolute inset-0 bg-zinc-950/90 backdrop-blur-md flex flex-col items-center justify-center gap-4 z-50 text-white">
          <div className="relative flex items-center justify-center">
            <div className="w-16 h-16 rounded-full border-2 border-zinc-700 border-t-blue-500 animate-spin" />
            <span className="absolute font-mono text-xs font-bold">{loadingProgress}%</span>
          </div>
          <div className="text-center space-y-1">
            <p className="font-bold text-base tracking-tight">{loadingText}</p>
            <p className="text-xs text-zinc-400">Stylized Island World • Third-Person Controls</p>
          </div>
        </div>
      )}
    </div>
  );
}
