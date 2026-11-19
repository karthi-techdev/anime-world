import * as THREE from "three";
import { HouseBatch, type HouseMaterials, type HousePalette } from "./houseDetails";
import type { HouseRecord } from "./islandHouses";
import { rng } from "./worldShared";

/** Independent art seed; no calls into the structural builder or its contact lists. */
export function createPeakHouseDetails(record: HouseRecord, palette: HousePalette, materials: HouseMaterials): THREE.Group {
  const root = new THREE.Group(), batch = new HouseBatch(materials);
  root.name = "peak-facade";
  const random = rng(record.spot.seed ^ 0x71f28b), { width: w, depth: d, storeys, family } = record;
  const front = d / 2 + 0.135, foundation = 0.18, height = foundation + storeys * 3.2;
  const paint = new THREE.Color(palette.accent).offsetHSL((random() - 0.5) * 0.15, 0.08, 0.04).getHex();
  const style = Math.floor(random() * 5), number = Math.abs(Math.floor(record.spot.seed)) % 9999;
  root.userData.detailId = `facade-${record.id}-${style}-${number}`;
  root.userData.style = style;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, finish: Parameters<HouseBatch["box"]>[6], tint: number) => batch.box(w, h, d, x, y, z, finish, tint);
  // Quoins stay on the existing corners, clear of all windows and walk paths.
  for (const side of [-1, 1]) for (let course = 0; course < storeys * 10; course++) {
    const y = foundation + 0.18 + course * 0.31;
    box(course % 2 ? 0.28 : 0.46, 0.22, 0.08, side * (w / 2 - 0.2), y, front, "stone", palette.stone);
  }
  for (let floor = 0; floor < storeys; floor++) {
    const base = foundation + floor * 3.2;
    for (const x of [-w * 0.31, w * 0.31]) {
      // Sills, drip edges, lintel joins: nothing spans the glass/open doorway.
      box(2.15, 0.085, 0.2, x, base + 0.85, front + 0.1, "stone", palette.trim);
      box(2.2, 0.1, 0.17, x, base + 2.53, front + 0.04, "stone", palette.trim);
      for (const side of [-1, 1]) box(0.07, 1.54, 0.09, x + side * 0.89, base + 1.66, front + 0.08, "metal", palette.timber);
      if (style === 1 || style === 3) {
        for (const side of [-1, 1]) for (let slat = 0; slat < 9; slat++) {
          box(0.24, 0.075, 0.075, x + side * 1.14, base + 1 + slat * 0.16, front + 0.035, "wood", paint);
        }
      }
    }
    if (floor > 0) {
      box(w - 0.25, 0.065, 0.13, 0, base - 0.1, front, "stone", palette.stone);
      for (const side of [-1, 1]) box(0.16, 0.3, 0.18, side * (w * 0.46), base + 2.78, front, "wood", paint);
    }
  }
  // Weathering occupies the solid plinth below windows, never the entry gap.
  for (let patch = 0; patch < 24; patch++) {
    const side = patch % 2 ? 1 : -1, x = side * (1.45 + random() * (w / 2 - 1.9));
    box(0.12 + random() * 0.4, 0.02 + random() * 0.075, 0.015, x, foundation + 0.12 + random() * 0.4, front + 0.01, "stone", patch % 3 ? palette.stone : 0x66816c);
  }
  // Wiring and a meter are flush to an outside wall, not freestanding fake cover.
  const meterX = style % 2 ? -w / 2 + 0.65 : w / 2 - 0.65;
  box(0.025, height - 0.6, 0.04, meterX, height / 2, front, "metal", 0x686f69);
  box(0.22, 0.34, 0.09, meterX, foundation + 1.25, front + 0.045, "metal", 0xc1bcb0);
  for (let i = 0; i < 4; i++) box(0.14, 0.012, 0.012, meterX, foundation + 1.18 + i * 0.045, front + 0.1, "metal", 0x526068);
  // Slim roof antennas and ridge finials vary the skyline without changing roof support.
  const mastX = (style - 2) * w * 0.09, mastZ = -d * 0.21;
  box(0.045, 1.5, 0.045, mastX, height + 2.5, mastZ, "metal", 0x687476);
  for (let i = 0; i < 5; i++) box(0.4 + i * 0.15, 0.025, 0.025, mastX, height + 2.5 + i * 0.11, mastZ, "metal", 0x879598);
  if (family === "apartment" || family === "shop") {
    box(w * 0.78, 0.16, 0.2, 0, height + 0.09, front - 0.08, "stone", paint);
    for (let i = 0; i < 12; i++) box(0.045, 0.08, 0.18, -w * 0.38 + i * w * 0.068, height + 0.19, front - 0.08, "metal", palette.trim);
  }
  // A shared glyph sheet is not needed: raised digits are real, small batched strokes.
  const digits = String(number).padStart(4, "0"), mask = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
  const segments = [[0, 0.11, 0.07, 0.018], [0.04, 0.055, 0.018, 0.07], [0.04, -0.055, 0.018, 0.07], [0, -0.11, 0.07, 0.018], [-0.04, -0.055, 0.018, 0.07], [-0.04, 0.055, 0.018, 0.07], [0, 0, 0.07, 0.018]];
  const signX = -1.48, signY = foundation + 1.88;
  box(0.63, 0.38, 0.045, signX, signY, front + 0.08, "metal", paint);
  for (let i = 0; i < digits.length; i++) segments.forEach(([x, y, width, height], segment) => {
    if (mask[Number(digits[i])] & (1 << segment)) box(width, height, 0.016, signX - 0.2 + i * 0.135 + x, signY + y, front + 0.111, "paper", 0xf5e4bf);
  });
  batch.finish(root);
  root.userData.decorativeOnly = true;
  return root;
}
