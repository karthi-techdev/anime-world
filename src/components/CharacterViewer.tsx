"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Play,
  Pause,
  Sun,
  Activity,
  Layers,
  Sparkles,
  Info,
  Compass,
  MapPin,
} from "lucide-react";
import { CHARACTERS, ANIMATIONS, AnimationCategory } from "@/lib/types";
import { LocomotionState, PlayerTelemetry } from "@/lib/characterController";
import { formatIST } from "@/lib/celestial";
import { ThreeCanvas, LightingMood, CameraPreset, GraphicsQuality } from "./ThreeCanvas";

export function CharacterViewer() {
  const [selectedCharacterId] = useState<string>("character-2");
  const [currentAnimationId, setCurrentAnimationId] = useState<string>("Idle");
  const [activeCategory, setActiveCategory] = useState<AnimationCategory>("locomotion");
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [inPlace, setInPlace] = useState<boolean>(false);
  const [showWireframe, setShowWireframe] = useState<boolean>(false);
  const [showSkeleton, setShowSkeleton] = useState<boolean>(false);
  const [lightingMood, setLightingMood] = useState<LightingMood>("tactical");
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>("full");
  const [graphicsQuality, setGraphicsQuality] = useState<GraphicsQuality>("low");
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [showPlaces, setShowPlaces] = useState<boolean>(false);
  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({
    x: 0,
    y: 5.5,
    z: 8.5,
    speed: 0,
    isGrounded: true,
    isSprinting: false,
    isCrouching: false,
    locomotion: "Idle",
  });
  const [nearbyDoor, setNearbyDoor] = useState<{ houseId: string; open: boolean } | null>(null);
  const [istClock, setIstClock] = useState(() => formatIST(new Date()));

  useEffect(() => {
    const tick = () => setIstClock(formatIST(new Date()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const character =
    CHARACTERS.find((c) => c.id === selectedCharacterId) || CHARACTERS[0];
  const activeAnim = ANIMATIONS.find((a) => a.id === currentAnimationId);

  const handleLocomotionChange = useCallback((animId: LocomotionState) => {
    setCurrentAnimationId(animId);
  }, []);

  const handleReturnToPlayerCamera = useCallback(() => {
    setCameraPreset("full");
  }, []);

  const handleDance = useCallback(() => {
    setCurrentAnimationId("Hip_Hop_Dancing");
  }, []);

  // P toggles playback; movement keys are handled by ThirdPersonController.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      if (key === "p") {
        setIsPlaying((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredAnimations = ANIMATIONS.filter(
    (a) => a.category === activeCategory
  );

  return (
    <div className="relative w-screen h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans overflow-hidden select-none">
      {/* 3D WebGL Canvas Layer */}
      <div className="absolute inset-0">
        <ThreeCanvas
          selectedCharacterId={selectedCharacterId}
          currentAnimationId={currentAnimationId}
          playbackSpeed={playbackSpeed}
          isPlaying={isPlaying}
          inPlace={inPlace}
          showWireframe={showWireframe}
          showSkeleton={showSkeleton}
          lightingMood={lightingMood}
          cameraPreset={cameraPreset}
          graphicsQuality={graphicsQuality}
          onLocomotionChange={handleLocomotionChange}
          onReturnToPlayerCamera={handleReturnToPlayerCamera}
          onTelemetry={setTelemetry}
          onDance={handleDance}
          onNearbyDoorChange={setNearbyDoor}
        />
      </div>

      {/* Top Header & Live Player Telemetry */}
      <header className="relative z-10 p-4 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pointer-events-none">
        {/* Brand / Title & Live Position Telemetry */}
        <div className="flex flex-wrap items-center gap-3 pointer-events-auto">
          {/* Character Card */}
          <div className="flex items-center gap-2.5 bg-zinc-900/90 backdrop-blur-md px-3.5 py-2 rounded-2xl border border-zinc-800/80 shadow-2xl">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-xs font-bold text-white">{character.name}</span>
            <span className="text-zinc-600">•</span>
            <span className="text-[11px] text-zinc-400 font-medium">Island Explorer · 5 × 5 km</span>
            <span className="text-zinc-600">•</span>
            <time className="text-[11px] text-amber-200 font-mono tabular-nums" aria-label="Current India Standard Time">IST {istClock}</time>
          </div>

          {/* Live Player Coordinates & Speed Badge */}
          <div className="hidden lg:flex items-center gap-2.5 bg-zinc-900/85 backdrop-blur-md px-3.5 py-2 rounded-xl border border-zinc-800/60 text-xs">
            <span
              className={`font-mono text-[10px] px-1.5 py-0.5 rounded font-bold border ${
                !telemetry.isGrounded
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                  : telemetry.isSprinting
                    ? "bg-purple-500/20 text-purple-300 border-purple-500/30"
                    : telemetry.isCrouching
                      ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                      : "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              }`}
            >
              {!telemetry.isGrounded
                ? "AIRBORNE"
                : telemetry.isSprinting
                  ? "SPRINT"
                  : telemetry.isCrouching
                    ? "CROUCH"
                    : "GROUNDED"}
            </span>
            <span className="text-zinc-300 font-mono text-[11px]">
              [{telemetry.x.toFixed(1)}, {telemetry.y.toFixed(2)}, {telemetry.z.toFixed(1)}]
            </span>
            <span className="text-zinc-600">•</span>
            <span className="text-[11px] text-blue-400 font-mono">
              {telemetry.speed.toFixed(1)} m/s
            </span>
          </div>
        </div>

        {/* Right Header: Active Action, Graphics Quality & Map Overview Toggle */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Graphics Quality for Low-End Device Support */}
          <div className="hidden sm:flex items-center gap-1 bg-zinc-900/90 backdrop-blur-md p-1 rounded-xl border border-zinc-800 text-[11px] font-semibold">
            <button
              onClick={() => setGraphicsQuality("low")}
              className={`px-2.5 py-1 rounded-lg transition-all ${
                graphicsQuality === "low"
                  ? "bg-emerald-600 text-white shadow-sm font-bold"
                  : "text-zinc-400 hover:text-white"
              }`}
              title="Eco / Low-End Device Mode (Max FPS, No Dynamic Shadows)"
            >
              ⚡ Eco
            </button>
            <button
              onClick={() => setGraphicsQuality("medium")}
              className={`px-2.5 py-1 rounded-lg transition-all ${
                graphicsQuality === "medium"
                  ? "bg-blue-600 text-white shadow-sm font-bold"
                  : "text-zinc-400 hover:text-white"
              }`}
              title="Balanced Mode (Nearby detail with distant world LOD)"
            >
              ⚖ Balanced
            </button>
            <button
              onClick={() => setGraphicsQuality("high")}
              className={`px-2.5 py-1 rounded-lg transition-all ${
                graphicsQuality === "high"
                  ? "bg-purple-600 text-white shadow-sm font-bold"
                  : "text-zinc-400 hover:text-white"
              }`}
              title="High Quality Mode"
            >
              ✨ High
            </button>
          </div>

          {/* Active Animation Badge */}
          <div className="inline-flex items-center gap-2.5 bg-zinc-900/80 backdrop-blur-md px-3.5 py-1.5 rounded-xl border border-zinc-800/80 shadow-xl">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <div className="text-xs">
              <span className="text-zinc-400 font-medium">Action: </span>
              <span className="font-bold text-white">{activeAnim?.name || currentAnimationId}</span>
            </div>
          </div>

          <div className="relative">
            <button
              onClick={() => setShowPlaces((visible) => !visible)}
              aria-expanded={showPlaces}
              aria-label="Find places on the island"
              className="px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 border bg-zinc-900/90 text-zinc-300 hover:text-white border-zinc-800 hover:bg-zinc-800/80"
            >
              <MapPin className="h-3.5 w-3.5" />
              <span>Places</span>
            </button>
            {showPlaces && (
              <div className="absolute right-0 top-full mt-2 w-44 rounded-xl border border-zinc-700 bg-zinc-950/95 p-1.5 shadow-2xl backdrop-blur-md">
                {[
                  { id: "school", label: "School" },
                  { id: "park", label: "Central Park" },
                  { id: "supermarket", label: "Supermarket" },
                  { id: "apartment", label: "Apartments" },
                ].map((place) => (
                  <button
                    key={place.id}
                    onClick={() => {
                      setCameraPreset(place.id as CameraPreset);
                      setShowPlaces(false);
                    }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-xs font-semibold text-zinc-200 hover:bg-blue-600 hover:text-white"
                  >
                    {place.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quick Overview Map button */}
          <button
            onClick={() => setCameraPreset(cameraPreset === "map3k" ? "full" : "map3k")}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 border ${
              cameraPreset === "map3k"
                ? "bg-blue-600 text-white border-blue-400 shadow-lg shadow-blue-500/30"
                : "bg-zinc-900/90 text-zinc-300 hover:text-white border-zinc-800 hover:bg-zinc-800/80"
            }`}
          >
            <Compass className="h-3.5 w-3.5" />
            <span>{cameraPreset === "map3k" ? "Follow Player" : "Overview Map"}</span>
          </button>
        </div>
      </header>

      {nearbyDoor && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none rounded-xl border border-white/15 bg-zinc-950/85 px-4 py-2 text-center shadow-xl backdrop-blur-md">
          <div className="text-xs font-bold text-white">{nearbyDoor.open ? "Door open" : "Door closed"}</div>
          <div className="mt-0.5 text-[11px] text-zinc-300"><kbd className="rounded border border-zinc-600 px-1 font-mono">E</kbd> {nearbyDoor.open ? "Close" : "Open"}</div>
        </div>
      )}

      {/* Spacer to push controls to bottom */}
      <div className="flex-1" />

      {/* Right Side Quick Camera & Visual Controls */}
      <div className="absolute right-4 sm:right-6 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-2 pointer-events-none">
        <div className="bg-zinc-900/85 backdrop-blur-md p-2 rounded-2xl border border-zinc-800/80 shadow-2xl flex flex-col gap-1.5 pointer-events-auto">
          <div className="text-[10px] font-bold text-zinc-400 px-2 py-1 uppercase tracking-wider text-center">
            Camera
          </div>

          {[
            { id: "full", label: "Follow" },
            { id: "town", label: "Town" },
            { id: "mountains", label: "Hills" },
            { id: "lake", label: "Lake" },
            { id: "drone", label: "Drone" },
            { id: "map3k", label: "Overview" },
          ].map((cam) => (
            <button
              key={cam.id}
              onClick={() => setCameraPreset(cam.id as CameraPreset)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                cameraPreset === cam.id
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-white hover:bg-zinc-800/60"
              }`}
            >
              {cam.label}
            </button>
          ))}

          <div className="border-t border-zinc-800 my-1" />

          {/* Follow / Free-move indicator toggle */}
          <button
            onClick={() => {
              setInPlace(!inPlace);
              setCameraPreset("full");
            }}
            title="Snap Follow Camera Behind Player"
            className={`p-2 rounded-lg text-xs flex items-center justify-center transition-colors ${
              cameraPreset === "full"
                ? "bg-blue-500/20 text-blue-400"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <Compass className="h-4 w-4" />
          </button>

          {/* Wireframe toggle */}
          <button
            onClick={() => setShowWireframe(!showWireframe)}
            title="Toggle Wireframe"
            className={`p-2 rounded-lg text-xs flex items-center justify-center transition-colors ${
              showWireframe ? "bg-amber-500/20 text-amber-400" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <Layers className="h-4 w-4" />
          </button>

          {/* Skeleton helper toggle */}
          <button
            onClick={() => setShowSkeleton(!showSkeleton)}
            title="Toggle Bones/Skeleton"
            className={`p-2 rounded-lg text-xs flex items-center justify-center transition-colors ${
              showSkeleton ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <Activity className="h-4 w-4" />
          </button>

          {/* Lighting mood toggle */}
          <button
            onClick={() => {
              const moods: LightingMood[] = ["cyber", "tactical", "studio"];
              const nextIndex = (moods.indexOf(lightingMood) + 1) % moods.length;
              setLightingMood(moods[nextIndex]);
            }}
            title={`Lighting: ${lightingMood}`}
            className="p-2 rounded-lg text-xs flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <Sun className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Bottom Main Controls & Animation Selector HUD */}
      <footer className="relative z-10 p-4 sm:p-6 flex flex-col gap-3 pointer-events-none">
        {/* Animation HUD Container */}
        <div className="max-w-4xl mx-auto w-full bg-zinc-900/90 backdrop-blur-xl rounded-3xl border border-zinc-800/80 shadow-2xl p-4 space-y-3 pointer-events-auto">
          {/* Top category tabs & Playback bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
            {/* Category tabs */}
            <div className="flex items-center gap-1 bg-zinc-950/60 p-1 rounded-xl border border-zinc-800/50">
              {[
                { id: "locomotion", label: "Locomotion", icon: Activity },
                { id: "special", label: "Emotes", icon: Sparkles },
              ].map((cat) => {
                const Icon = cat.icon;
                const isActive = activeCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setActiveCategory(cat.id as AnimationCategory)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      isActive
                        ? "bg-zinc-800 text-white shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{cat.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Live Control Pill + Play / Speed Controls */}
            <div className="flex items-center gap-2">
              <span className="hidden md:inline-block font-mono text-[10px] text-zinc-400 bg-zinc-950/70 px-2.5 py-1 rounded-lg border border-zinc-800/70">
                WASD Move • Shift Sprint • Space Jump • C Crouch
              </span>

              <button
                onClick={() => setIsPlaying(!isPlaying)}
                className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white transition-colors"
                title={isPlaying ? "Pause (P)" : "Play (P)"}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-white" />}
              </button>

              {/* Speed Buttons */}
              <div className="flex items-center gap-1 bg-zinc-950/60 p-1 rounded-xl border border-zinc-800/50 text-[11px] font-mono font-semibold">
                {[0.5, 1.0, 1.5, 2.0].map((s) => (
                  <button
                    key={s}
                    onClick={() => setPlaybackSpeed(s)}
                    className={`px-2 py-0.5 rounded-md transition-colors ${
                      playbackSpeed === s
                        ? "bg-blue-600 text-white"
                        : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              <button
                onClick={() => setShowHelp(!showHelp)}
                className={`p-2 rounded-xl border transition-colors ${
                  showHelp
                    ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                    : "bg-zinc-800/80 border-zinc-700/80 text-zinc-400 hover:text-white"
                }`}
                title="Controls & Keyboard Shortcuts"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Animation Buttons Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {filteredAnimations.map((anim) => {
              const isSelected = currentAnimationId === anim.id;
              return (
                <button
                  key={anim.id}
                  onClick={() => setCurrentAnimationId(anim.id)}
                  className={`flex items-center justify-between px-3 py-2 rounded-xl text-left border text-xs font-semibold transition-all ${
                    isSelected
                      ? "bg-gradient-to-r from-blue-600/90 to-indigo-600/90 border-blue-500 text-white shadow-lg shadow-blue-500/20 scale-[1.02]"
                      : "bg-zinc-950/40 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/60 hover:border-zinc-700"
                  }`}
                >
                  <span className="truncate">{anim.name}</span>
                  {anim.hotkey && (
                    <kbd className="ml-2 font-mono text-[10px] bg-zinc-800/80 px-1.5 py-0.5 rounded text-zinc-400 border border-zinc-700/60 shrink-0">
                      {anim.hotkey}
                    </kbd>
                  )}
                </button>
              );
            })}
          </div>

          {/* Keyboard Shortcuts Hint Panel */}
          {showHelp && (
            <div className="p-3 bg-zinc-950/80 rounded-2xl border border-zinc-800 text-[11px] text-zinc-400 space-y-1.5 animate-in fade-in duration-200">
              <div className="font-bold text-zinc-200 flex items-center justify-between">
                <span>Third-Person Controls & Shortcuts</span>
                <span className="text-[10px] text-zinc-500">Drag mouse to orbit camera • Scroll to zoom</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] pt-1">
                <div><span className="text-blue-400 font-bold">WASD / Arrows:</span> Move</div>
                <div><span className="text-blue-400 font-bold">Shift + Move:</span> Sprint</div>
                <div><span className="text-blue-400 font-bold">Space:</span> Jump</div>
                <div><span className="text-blue-400 font-bold">C:</span> Toggle Crouch</div>
                <div><span className="text-white font-bold">E:</span> Door nearby: open/close · else: dance</div>
                <div><span className="text-white font-bold">I:</span> Idle Stance</div>
                <div><span className="text-white font-bold">P:</span> Play/Pause</div>
              </div>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
