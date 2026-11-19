import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getWorldHeight, WATER_Y } from "./worldShared";
import type { WorldContact } from "./worldTypes";

export type LocomotionState =
  | "Idle"
  | "Walking"
  | "Running"
  | "Jumping"
  | "Running_Jump"
  | "Crouch_Idle"
  | "Crouched_Walking"
  | "Prone_Idle"
  | "Prone_Crawl";

// Speed the animation was authored for (m/s at 2.0 m height). Used to scale
// playback so feet do not slide.
const ANIM_STRIDE: Partial<Record<LocomotionState, number>> = {
  Walking: 1.9,
  Running: 4.9,
  Crouched_Walking: 1.4,
  Prone_Crawl: 0.7,
};

export interface PlayerTelemetry {
  x: number;
  y: number;
  z: number;
  speed: number;
  isGrounded: boolean;
  isSprinting: boolean;
  isCrouching: boolean;
  locomotion: LocomotionState;
}

export interface JumpAnim {
  stage: "windup" | "air" | "land";
  /** windup/land: seconds elapsed. air: phase 0 takeoff .. 0.5 apex .. 1 touchdown. */
  t: number;
  /** Length of the windup (s); the clip starts at takeoff - windup. */
  windup: number;
}

/** Measured from the Mixamo clip itself by scripts/verify_anims.mts (jumps.json). */
export interface JumpProfile {
  takeoff: number; // clip time feet leave the ground
  land: number; // clip time feet touch down
  flight: number;
  dur: number;
  g: number; // gravity that reproduces the clip's hip arc (m/s^2)
  v: number; // takeoff speed = g * flight / 2
  rise: number;
}

export interface ThirdPersonControllerOptions {
  spawnX?: number;
  spawnZ?: number;
  initialYaw?: number;
  worldHalfExtent?: number;
  world?: WorldContact;
  onLocomotionChange?: (state: LocomotionState, timeScale?: number, jump?: JumpAnim) => void;
  onMovementStart?: () => void;
  onTelemetry?: (telemetry: PlayerTelemetry) => void;
  onInteract?: () => boolean;
}

const UP = new THREE.Vector3(0, 1, 0);

// Tuned movement constants for smooth feel
const WALK_SPEED = 2.8;
const SPRINT_SPEED = 5.8;
const CROUCH_SPEED = 1.5;
const SPEED_MULT = 1.15;
const PRONE_SPEED = 0.7;
const ACCELERATION = 28.0;
const DECELERATION = 24.0;
const AIR_CONTROL = 0.5;
const TURN_SPEED = 14.0;
// Jump physics come from the Mixamo clips themselves (jumps.json: gravity and
// takeoff speed that reproduce each clip's own hip arc and air time).
const FALLBACK_JUMP: JumpProfile = { takeoff: 0, land: 0.4, flight: 0.4, dur: 0.4, g: 13.8, v: 2.7, rise: 0.27 };
const MAX_WINDUP = 0.2; // max crouch wind-up before the push-off (s)
const RUN_JUMP_SPEED = 0.6; // moving faster than this = running jump clip (walk too)
const HARD_LAND_SPEED = 8.0; // fall speed (m/s) that makes a stumbling landing
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12; // Space pressed just before landing still jumps
const AIR_DRAG = 0.4; // no input in air: keep momentum (ground decel is 24)
const MIN_LAND_AIR = 0.15; // shorter hops down slopes skip the landing anim
const LAND_MOVING = 0.14; // landing recovery (s) when moving
const LAND_STILL = 0.5; // landing recovery (s) when standing (capped by the clip)
const CAMERA_PIVOT_HEIGHT = 1.38;
const CAMERA_PIVOT_CROUCH_HEIGHT = 1.02;

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export class ThirdPersonController {
  public readonly position: THREE.Vector3;
  public readonly velocity: THREE.Vector3 = new THREE.Vector3();
  public yaw: number;

  private isGrounded = true;
  private isCrouching = false;
  private isProne = false;
  private strides: Partial<Record<string, number>> = {};
  private coyoteTimer = 0;
  private jumpBuffer = 0;
  private landTimer = 0;
  private landDuration = 0;
  private jumpProfiles: Record<string, JumpProfile> = {};
  private jumpKind: "Jumping" | "Running_Jump" = "Jumping";
  private windupTimer = 0;
  private windupTotal = 0;
  private gravity = FALLBACK_JUMP.g;
  private unitScale = 1;
  private airTime = 0;
  private takeV = 0; // rise speed at takeoff (0 = walked off a ledge)
  private apexY = 0; // highest y reached in this airtime
  private camBaseY = 0; // smoothed camera follow height
  private manualOverrideActive = false;
  private currentLocomotion: LocomotionState = "Idle";

  private keys = new Set<string>();
  private worldHalfExtent: number;
  private world?: WorldContact;
  private motionDelta = new THREE.Vector3();
  private prevPivot = new THREE.Vector3();
  private currentPivotHeight = CAMERA_PIVOT_HEIGHT;
  private hasInitializedCamera = false;
  private telemetryTimer = 0;

  private forwardVec = new THREE.Vector3();
  private rightVec = new THREE.Vector3();
  private wishDir = new THREE.Vector3();
  private targetPivot = new THREE.Vector3();
  private pivotDelta = new THREE.Vector3();

  private onLocomotionChange?: (state: LocomotionState, timeScale?: number, jump?: JumpAnim) => void;
  private onMovementStart?: () => void;
  private onTelemetry?: (telemetry: PlayerTelemetry) => void;
  private onInteract?: () => boolean;

  private handleKeyDownBound: (e: KeyboardEvent) => void;
  private handleKeyUpBound: (e: KeyboardEvent) => void;
  private handleBlurBound: () => void;

  constructor(options: ThirdPersonControllerOptions = {}) {
    const spawnX = options.spawnX ?? 0;
    const spawnZ = options.spawnZ ?? 8.5;
    this.world = options.world;
    const groundY = this.terrainHeight(spawnX, spawnZ);

    this.position = new THREE.Vector3(spawnX, groundY, spawnZ);
    this.yaw = options.initialYaw ?? Math.PI;
    this.worldHalfExtent = options.worldHalfExtent ?? 305;
    this.onLocomotionChange = options.onLocomotionChange;
    this.onMovementStart = options.onMovementStart;
    this.onTelemetry = options.onTelemetry;
    this.onInteract = options.onInteract;

    this.prevPivot.set(spawnX, groundY + CAMERA_PIVOT_HEIGHT, spawnZ);
    this.camBaseY = groundY;

    this.handleKeyDownBound = this.handleKeyDown.bind(this);
    this.handleKeyUpBound = this.handleKeyUp.bind(this);
    this.handleBlurBound = this.handleBlur.bind(this);

    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.handleKeyDownBound);
      window.addEventListener("keyup", this.handleKeyUpBound);
      window.addEventListener("blur", this.handleBlurBound);
    }
  }

  private terrainHeight(x: number, z: number): number {
    return this.world?.sampleTerrain(x, z) ?? getWorldHeight(x, z);
  }

  public setWorld(world: WorldContact, halfExtent: number, spawn?: THREE.Vector3): void {
    this.world = world;
    this.worldHalfExtent = halfExtent;
    if (spawn) {
      this.position.copy(spawn);
      this.velocity.set(0, 0, 0);
      this.isGrounded = true;
      this.camBaseY = spawn.y;
      this.hasInitializedCamera = false;
    }
  }

  public constrainCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
    if (!this.world) return;
    const resolved = this.world.resolveCamera(controls.target, camera.position, 0.2);
    camera.position.copy(resolved);
    camera.lookAt(controls.target);
  }

  public dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.handleKeyDownBound);
      window.removeEventListener("keyup", this.handleKeyUpBound);
      window.removeEventListener("blur", this.handleBlurBound);
    }
    this.keys.clear();
  }

  private isInputFocused(): boolean {
    const tag = document.activeElement?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isInputFocused()) return;

    const code = e.code;

    if (
      code === "Space" ||
      code === "ArrowUp" ||
      code === "ArrowDown" ||
      code === "ArrowLeft" ||
      code === "ArrowRight"
    ) {
      e.preventDefault();
    }

    if (code === "Space" && !e.repeat) {
      this.jumpBuffer = JUMP_BUFFER;
    }

    if (code === "KeyC" && !e.repeat) {
      this.isCrouching = !this.isCrouching;
      this.isProne = false;
      this.manualOverrideActive = false;
    }

    if (code === "KeyX" && !e.repeat) {
      this.isProne = !this.isProne;
      this.isCrouching = false;
      this.manualOverrideActive = false;
    }

    if (code === "KeyE" && !e.repeat && this.onInteract?.()) {
      e.preventDefault();
      return;
    }

    this.keys.add(code);
  }

  /** Real root-motion speeds measured from the clips (m/s). */
  public setStrideSpeeds(strides: Record<string, number>): void {
    this.strides = strides;
  }

  // Move at the clip's authored speed (x SPEED_MULT) so feet plant on the ground.
  private speedFor(state: LocomotionState, fallback: number): number {
    const s = this.strides[state];
    return s ? THREE.MathUtils.clamp(s * SPEED_MULT, 0.4, 9) : fallback;
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }

  private handleBlur(): void {
    this.keys.clear();
    this.jumpBuffer = 0;
  }

  /** Per-clip jump physics measured from the Mixamo clips (jumps.json). */
  public setJumpProfiles(profiles: Record<string, JumpProfile>, unitScale = 1): void {
    this.jumpProfiles = profiles;
    this.unitScale = unitScale;
    this.gravity = this.jumpProfile("Jumping").g * unitScale;
  }

  private jumpProfile(kind: string): JumpProfile {
    return this.jumpProfiles[kind] ?? FALLBACK_JUMP;
  }

  /** Start a jump: crouch wind-up first (grounded), or push off at once. */
  private beginJump(allowWindup: boolean): void {
    const horiz = Math.hypot(this.velocity.x, this.velocity.z);
    this.jumpKind = horiz > RUN_JUMP_SPEED ? "Running_Jump" : "Jumping";
    this.isCrouching = false;
    this.isProne = false;
    this.landTimer = 0;
    const p = this.jumpProfile(this.jumpKind);
    this.windupTotal = allowWindup ? Math.min(p.takeoff, MAX_WINDUP) : 0;
    if (this.windupTotal > 0) {
      this.windupTimer = this.windupTotal;
    } else {
      this.launch();
    }
  }

  private launch(): void {
    const p = this.jumpProfile(this.jumpKind);
    this.isCrouching = false;
    this.isProne = false;
    this.isGrounded = false;
    this.coyoteTimer = 0;
    this.landTimer = 0;
    this.windupTimer = 0;
    this.airTime = 0;
    // clip numbers are in raw rig meters; the model is scaled by unitScale
    this.gravity = p.g * this.unitScale;
    this.takeV = p.v * this.unitScale;
    this.apexY = this.position.y;
    this.velocity.y = this.takeV;
  }

  public setManualAnimationOverride(animId: string): void {
    if (animId === "Crouch_Idle" || animId === "Crouched_Walking") {
      this.isCrouching = true;
      this.manualOverrideActive = false;
      return;
    }
    if (
      animId === "Idle" ||
      animId === "Walking" ||
      animId === "Running" ||
      animId === "Jumping"
    ) {
      this.isCrouching = false;
      this.manualOverrideActive = false;
      return;
    }
    this.manualOverrideActive = true;
  }

  public getIsSprinting(): boolean {
    return (
      (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) &&
      this.hasDirectionalInput()
    );
  }

  public getIsCrouching(): boolean {
    return this.isCrouching;
  }

  public getCurrentLocomotion(): LocomotionState {
    return this.currentLocomotion;
  }

  private hasDirectionalInput(): boolean {
    return (
      this.keys.has("KeyW") ||
      this.keys.has("KeyS") ||
      this.keys.has("KeyA") ||
      this.keys.has("KeyD") ||
      this.keys.has("ArrowUp") ||
      this.keys.has("ArrowDown") ||
      this.keys.has("ArrowLeft") ||
      this.keys.has("ArrowRight")
    );
  }

  public snapCameraBehindPlayer(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    distance = 4.2,
    heightOffset = 1.65
  ): void {
    const pivotY =
      this.position.y +
      (this.isCrouching ? CAMERA_PIVOT_CROUCH_HEIGHT : CAMERA_PIVOT_HEIGHT);
    this.prevPivot.set(this.position.x, pivotY, this.position.z);
    this.camBaseY = this.position.y;
    this.currentPivotHeight =
      this.isCrouching ? CAMERA_PIVOT_CROUCH_HEIGHT : CAMERA_PIVOT_HEIGHT;

    const backX = -Math.sin(this.yaw) * distance;
    const backZ = -Math.cos(this.yaw) * distance;

    controls.target.copy(this.prevPivot);
    camera.position.set(
      this.position.x + backX,
      Math.max(
        this.position.y + heightOffset,
        this.terrainHeight(this.position.x + backX, this.position.z + backZ) + 0.5
      ),
      this.position.z + backZ
    );
    controls.update();
    this.constrainCamera(camera, controls);
    this.hasInitializedCamera = true;
  }

  /**
   * 0 takeoff -> 0.5 apex -> 1 touchdown, linear in time on flat ground.
   * Rise: by vertical speed. Fall: by speed vs the speed we will hit the
   * ground at (works for hops, slopes and ledge drops).
   */
  private airPhase(groundY: number): number {
    if (this.velocity.y > 0 && this.takeV > 0) {
      return THREE.MathUtils.clamp(0.5 * (1 - this.velocity.y / this.takeV), 0, 0.5);
    }
    const drop = Math.max(this.apexY - groundY, 0.01);
    const vLand = Math.sqrt(2 * this.gravity * drop);
    return THREE.MathUtils.clamp(0.5 + 0.5 * (-this.velocity.y / vLand), 0.5, 1);
  }

  public update(
    dt: number,
    characterGroup: THREE.Object3D,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    isFollowCameraActive: boolean,
    lockPosition = false
  ): void {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.05);

    let moveForward = 0;
    let moveRight = 0;

    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) moveForward += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) moveForward -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) moveRight += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) moveRight -= 1;

    const hasInput = moveForward !== 0 || moveRight !== 0;
    const shiftHeld = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const isSprinting = hasInput && shiftHeld;

    if (isSprinting && (this.isCrouching || this.isProne)) {
      this.isCrouching = false;
      this.isProne = false;
    }

    if (this.landTimer > 0) this.landTimer = Math.max(0, this.landTimer - safeDt);

    if (hasInput || this.jumpBuffer > 0) {
      this.manualOverrideActive = false;
      if (!isFollowCameraActive && this.onMovementStart) {
        this.onMovementStart();
      }
    }

    this.forwardVec.subVectors(controls.target, camera.position);
    this.forwardVec.y = 0;
    if (this.forwardVec.lengthSq() < 1e-6) {
      this.forwardVec.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    } else {
      this.forwardVec.normalize();
    }

    this.rightVec.crossVectors(this.forwardVec, UP).normalize();

    this.wishDir
      .set(0, 0, 0)
      .addScaledVector(this.forwardVec, moveForward)
      .addScaledVector(this.rightVec, moveRight);

    if (this.wishDir.lengthSq() > 0) {
      this.wishDir.normalize();
    }

    let targetSpeed: number;
    if (!hasInput) targetSpeed = 0;
    else if (this.isProne) targetSpeed = this.speedFor("Prone_Crawl", PRONE_SPEED);
    else if (this.isCrouching) targetSpeed = this.speedFor("Crouched_Walking", CROUCH_SPEED);
    else if (isSprinting) targetSpeed = this.speedFor("Running", SPRINT_SPEED);
    else targetSpeed = this.speedFor("Walking", WALK_SPEED);

    const targetVx = this.wishDir.x * targetSpeed;
    const targetVz = this.wishDir.z * targetSpeed;

    const baseAccel = hasInput ? ACCELERATION : DECELERATION;
    const effectiveAccel = this.isGrounded
      ? baseAccel
      : hasInput
        ? baseAccel * AIR_CONTROL
        : AIR_DRAG;
    const blend = 1 - Math.exp(-effectiveAccel * safeDt);

    this.velocity.x += (targetVx - this.velocity.x) * blend;
    this.velocity.z += (targetVz - this.velocity.z) * blend;

    if (Math.hypot(this.velocity.x, this.velocity.z) < 0.01 && !hasInput) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    if (!lockPosition) {
      if (this.world) {
        this.motionDelta.set(this.velocity.x * safeDt, 0, this.velocity.z * safeDt);
        const next = this.world.move(
          this.position,
          this.motionDelta,
          0.3,
          this.isProne ? 0.65 : this.isCrouching ? 1.25 : 1.95
        );
        this.velocity.x = (next.x - this.position.x) / safeDt;
        this.velocity.z = (next.z - this.position.z) / safeDt;
        this.position.copy(next);
      } else {
        const nextX = THREE.MathUtils.clamp(
          this.position.x + this.velocity.x * safeDt,
          -this.worldHalfExtent,
          this.worldHalfExtent
        );
        const nextZ = THREE.MathUtils.clamp(
          this.position.z + this.velocity.z * safeDt,
          -this.worldHalfExtent,
          this.worldHalfExtent
        );
        const candidateGroundY = getWorldHeight(nextX, nextZ);
        if (candidateGroundY >= WATER_Y - 0.55) {
          this.position.x = nextX;
          this.position.z = nextZ;
        } else {
          const groundXOnly = getWorldHeight(nextX, this.position.z);
          const groundZOnly = getWorldHeight(this.position.x, nextZ);
          if (groundXOnly >= WATER_Y - 0.55) {
            this.position.x = nextX;
            this.velocity.z = 0;
          } else if (groundZOnly >= WATER_Y - 0.55) {
            this.position.z = nextZ;
            this.velocity.x = 0;
          } else {
            this.velocity.x = 0;
            this.velocity.z = 0;
          }
        }
      }
    }

    const groundY = this.world
      ? this.world.supportAt(this.position.x, this.position.z, this.position.y, this.isGrounded ? 0.32 : 0)
      : getWorldHeight(this.position.x, this.position.z);

    if (this.isGrounded) {
      this.coyoteTimer = COYOTE_TIME;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - safeDt);
    }

    if (this.windupTimer > 0) {
      this.windupTimer -= safeDt;
      if (this.windupTimer <= 0) this.launch();
    }

    if (this.jumpBuffer > 0) {
      if (
        this.windupTimer === 0 &&
        (this.isGrounded || this.coyoteTimer > 0)
      ) {
        this.jumpBuffer = 0;
        this.beginJump(this.isGrounded);
      } else {
        this.jumpBuffer = Math.max(0, this.jumpBuffer - safeDt);
      }
    }

    if (!this.isGrounded) {
      // exact constant-gravity step (frame-rate independent). g and takeoff
      // speed come from the Mixamo clip, so the body arc matches the animation.
      const g = this.gravity;
      const v = this.velocity.y;
      const verticalDelta = v * safeDt - 0.5 * g * safeDt * safeDt;
      if (this.world && verticalDelta > 0) {
        this.motionDelta.set(0, verticalDelta, 0);
        const next = this.world.move(this.position, this.motionDelta, 0.3, 1.95);
        if (next.y - this.position.y < verticalDelta - 0.001) this.velocity.y = 0;
        this.position.copy(next);
      } else {
        this.position.y += verticalDelta;
      }
      this.velocity.y -= g * safeDt;
      this.apexY = Math.max(this.apexY, this.position.y);
      this.airTime += safeDt;

      if (this.position.y <= groundY && this.velocity.y <= 0) {
        const impact = -this.velocity.y;
        this.position.y = groundY;
        this.velocity.y = 0;
        this.isGrounded = true;
        if (impact > HARD_LAND_SPEED) {
          // hard landing: lose most forward momentum
          this.velocity.x *= 0.4;
          this.velocity.z *= 0.4;
        }
        if (this.airTime > MIN_LAND_AIR) {
          const fast = Math.hypot(this.velocity.x, this.velocity.z) > 1.0;
          const lp = this.jumpProfile(this.jumpKind);
          this.landDuration = Math.min(
            fast && impact <= HARD_LAND_SPEED ? LAND_MOVING : LAND_STILL,
            Math.max(0, lp.dur - lp.land)
          );
          this.landTimer = this.landDuration;
        }
        this.airTime = 0;
      }
    } else {
      const heightDiff = groundY - this.position.y;
      if (heightDiff < -0.45) {
        // walked off a ledge: fall with the standing-jump gravity, pose starts at apex
        this.isGrounded = false;
        this.velocity.y = 0;
        this.airTime = 0;
        this.takeV = 0;
        this.jumpKind = "Jumping";
        this.gravity = this.jumpProfile("Jumping").g * this.unitScale;
        this.apexY = this.position.y;
      } else {
        this.position.y = groundY;
        this.velocity.y = 0;
      }
    }

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hasInput && horizontalSpeed > 0.12) {
      const targetYaw = Math.atan2(this.wishDir.x, this.wishDir.z);
      const diff = normalizeAngle(targetYaw - this.yaw);
      const rotBlend = 1 - Math.exp(-TURN_SPEED * safeDt);
      this.yaw = normalizeAngle(this.yaw + diff * rotBlend);
    }

    characterGroup.position.copy(this.position);
    characterGroup.rotation.y = this.yaw;

    const moving = horizontalSpeed > 0.25;
    let nextLocomotion: LocomotionState;
    if (!this.isGrounded || this.windupTimer > 0) {
      nextLocomotion = this.jumpKind;
    } else if (this.landTimer > 0 && !this.isProne) {
      nextLocomotion = this.jumpKind; // landing recovery
    } else if (this.isProne) {
      nextLocomotion = moving ? "Prone_Crawl" : "Prone_Idle";
    } else if (this.isCrouching) {
      nextLocomotion = moving ? "Crouched_Walking" : "Crouch_Idle";
    } else if (moving) {
      nextLocomotion = isSprinting ? "Running" : "Walking";
    } else {
      nextLocomotion = "Idle";
    }

    // Scale loop playback to real speed so feet do not slide.
    const stride = this.strides[nextLocomotion] ?? ANIM_STRIDE[nextLocomotion];
    const timeScale = stride
      ? THREE.MathUtils.clamp(horizontalSpeed / stride, 0.5, 1.6)
      : 1;

    if (nextLocomotion !== this.currentLocomotion) {
      this.currentLocomotion = nextLocomotion;
    }
    let jump: JumpAnim | undefined;
    if (nextLocomotion === "Jumping" || nextLocomotion === "Running_Jump") {
      if (!this.isGrounded) {
        jump = { stage: "air", t: this.airPhase(groundY), windup: 0 };
      } else if (this.windupTimer > 0) {
        jump = {
          stage: "windup",
          t: this.windupTotal - this.windupTimer,
          windup: this.windupTotal,
        };
      } else {
        jump = { stage: "land", t: this.landDuration - this.landTimer, windup: 0 };
      }
    }
    if (!this.manualOverrideActive && this.onLocomotionChange) {
      this.onLocomotionChange(nextLocomotion, timeScale, jump);
    }

    const desiredPivotHeight = this.isProne
      ? 0.55
      : this.isCrouching
        ? CAMERA_PIVOT_CROUCH_HEIGHT
        : CAMERA_PIVOT_HEIGHT;
    this.currentPivotHeight +=
      (desiredPivotHeight - this.currentPivotHeight) *
      (1 - Math.exp(-10 * safeDt));

    // Camera follows height softly: ground slopes smooth, and a jump shows
    // as real rise on screen (camera takes only ~30% of the hop).
    const airLift = this.isGrounded
      ? 0
      : Math.min(Math.max(this.position.y - groundY, 0), 1.6);
    const desiredBaseY = this.position.y - airLift * 0.7;
    this.camBaseY +=
      (desiredBaseY - this.camBaseY) *
      (1 - Math.exp(-(this.isGrounded ? 12 : 9) * safeDt));

    this.targetPivot.set(
      this.position.x,
      this.camBaseY + this.currentPivotHeight,
      this.position.z
    );

    if (!this.hasInitializedCamera) {
      this.prevPivot.copy(this.targetPivot);
      this.hasInitializedCamera = true;
    }

    if (isFollowCameraActive) {
      this.pivotDelta.subVectors(this.targetPivot, this.prevPivot);
      controls.target.add(this.pivotDelta);
      camera.position.add(this.pivotDelta);

      const minCamY =
        this.terrainHeight(camera.position.x, camera.position.z) + 0.45;
      if (camera.position.y < minCamY) {
        camera.position.y = minCamY;
      }
    }

    this.prevPivot.copy(this.targetPivot);

    this.telemetryTimer += safeDt;
    if (this.telemetryTimer >= 0.066 && this.onTelemetry) {
      this.telemetryTimer = 0;
      this.onTelemetry({
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
        speed: horizontalSpeed,
        isGrounded: this.isGrounded,
        isSprinting,
        isCrouching: this.isCrouching,
        locomotion: this.currentLocomotion,
      });
    }
  }
}
