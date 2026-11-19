import os
import json
from PIL import Image, ImageFilter
import numpy as np

OUTPUT_DIR = "public/assets/3d/environment/island"
os.makedirs(OUTPUT_DIR, exist_ok=True)

REF_IMG_PATH = os.path.join(OUTPUT_DIR, "island_rpg_reference.jpg")
if not os.path.exists(REF_IMG_PATH):
    raise FileNotFoundError(f"Missing {REF_IMG_PATH}")

img = Image.open(REF_IMG_PATH)
orig_w, orig_h = img.size
arr = np.array(img, dtype=np.float32)
r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]

# Fountain position in reference image
fx, fy = 376.2, 434.7

# 1. Precise Water vs Land Detection
diff = b - r
water = diff > 8
# Remove compass rose (y > 740, x > 560)
for y in range(740, orig_h):
    for x in range(560, orig_w):
        if np.sqrt((y - 820)**2 + (x - 670)**2) < 95:
            water[y, x] = True

# Fountain inside town is land
for y in range(415, 455):
    for x in range(355, 395):
        if (y - 435)**2 + (x - 376)**2 < 20**2:
            water[y, x] = False

land = ~water

# Median filter to clean hand-drawn line noise
land_pil = Image.fromarray((land * 255).astype(np.uint8))
land_pil = land_pil.filter(ImageFilter.MedianFilter(size=5))
land_pil = land_pil.filter(ImageFilter.MedianFilter(size=5))
land_clean = np.array(land_pil) > 128

# 2. Accurate Material Classification (Green vegetation, Sand fields/roads, Rock cliffs)
# True sand/dirt/fields/roads: warm golden tones where r > g and r > b + 20
is_sand = land_clean & (r > g) & (r > b + 20) & (r > 135)
# True rock: slate grey / cliff edges
is_rock = land_clean & (((r < 95) & (g < 95) & (b < 95)) | ((abs(r - g) < 18) & (abs(g - b) < 18) & (r < 160)))
# True green vegetation: lush forest, meadows, hills (default on land)
is_green = land_clean & ~is_sand & ~is_rock

# Clean material masks
def clean_mask(m, size=5):
    p = Image.fromarray((m * 255).astype(np.uint8))
    p = p.filter(ImageFilter.MedianFilter(size=size))
    return np.array(p) > 128

is_sand = clean_mask(is_sand, 5)
is_rock = clean_mask(is_rock, 5)
is_green = land_clean & ~is_sand & ~is_rock

# 3. Fast Two-Pass Chamfer Distance Transform
def distance_transform(mask):
    h, w = mask.shape
    inf = 1e6
    d = np.full((h, w), inf, dtype=np.float32)
    d[mask] = 0.0
    sqrt2 = 1.41421356

    # Forward pass
    for y in range(h):
        for x in range(w):
            v = d[y, x]
            if y > 0:
                v = min(v, d[y-1, x] + 1.0)
                if x > 0:
                    v = min(v, d[y-1, x-1] + sqrt2)
                if x < w - 1:
                    v = min(v, d[y-1, x+1] + sqrt2)
            if x > 0:
                v = min(v, d[y, x-1] + 1.0)
            d[y, x] = v

    # Backward pass
    for y in range(h - 1, -1, -1):
        for x in range(w - 1, -1, -1):
            v = d[y, x]
            if y < h - 1:
                v = min(v, d[y+1, x] + 1.0)
                if x < w - 1:
                    v = min(v, d[y+1, x+1] + sqrt2)
                if x > 0:
                    v = min(v, d[y+1, x-1] + sqrt2)
            if x < w - 1:
                v = min(v, d[y, x+1] + 1.0)
            d[y, x] = v

    return d

print("Computing distance transforms...")
dist_to_water = distance_transform(~land_clean) # Distance inwards into land
dist_to_land = distance_transform(land_clean)   # Distance outwards into ocean

# 4. Generate 512x512 World Grid (covering 3000m x 3000m)
# 1 pixel in reference image = 2.5 meters in world
GRID_SIZE = 512
MAP_SIZE = 3000.0 # meters
METERS_PER_PIXEL = 2.5

# Coordinates of (r, c) on 512 grid:
# c in [0, 511] corresponds to X in [-1500, +1500]
# r in [0, 511] corresponds to Z in [-1500, +1500]
xs = np.linspace(-MAP_SIZE / 2.0, MAP_SIZE / 2.0, GRID_SIZE)
zs = np.linspace(-MAP_SIZE / 2.0, MAP_SIZE / 2.0, GRID_SIZE)
grid_x, grid_z = np.meshgrid(xs, zs)

# Map world (grid_x, grid_z) back to reference image coordinates:
# Fountain is at world (0, 0)
ref_img_x = fx + (grid_x / METERS_PER_PIXEL)
ref_img_y = fy + (grid_z / METERS_PER_PIXEL)

# Nearest / bilinear sample masks
in_bounds = (ref_img_x >= 0) & (ref_img_x < orig_w - 1) & (ref_img_y >= 0) & (ref_img_y < orig_h - 1)
samp_x = np.clip(np.round(ref_img_x).astype(int), 0, orig_w - 1)
samp_y = np.clip(np.round(ref_img_y).astype(int), 0, orig_h - 1)

grid_land = np.zeros((GRID_SIZE, GRID_SIZE), dtype=bool)
grid_land[in_bounds] = land_clean[samp_y[in_bounds], samp_x[in_bounds]]

grid_sand = np.zeros((GRID_SIZE, GRID_SIZE), dtype=bool)
grid_sand[in_bounds] = is_sand[samp_y[in_bounds], samp_x[in_bounds]]

grid_rock = np.zeros((GRID_SIZE, GRID_SIZE), dtype=bool)
grid_rock[in_bounds] = is_rock[samp_y[in_bounds], samp_x[in_bounds]]

grid_green = np.zeros((GRID_SIZE, GRID_SIZE), dtype=bool)
grid_green[in_bounds] = is_green[samp_y[in_bounds], samp_x[in_bounds]]

# Sample distances
grid_dist_in = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
grid_dist_in[in_bounds] = dist_to_water[samp_y[in_bounds], samp_x[in_bounds]] * METERS_PER_PIXEL

grid_dist_out = np.full((GRID_SIZE, GRID_SIZE), 1000.0, dtype=np.float32)
grid_dist_out[in_bounds] = dist_to_land[samp_y[in_bounds], samp_x[in_bounds]] * METERS_PER_PIXEL

# 5. Build Realistic 3D Island Elevation with Dramatic Mountains & Cliffs
elev = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)

# Harbor area (northwest) & southeast cove: gentle slope
dist_harbor = np.sqrt((grid_x - (-265.0))**2 + (grid_z - (-140.0))**2)
is_harbor_cove = dist_harbor < 180.0

dist_se_cove = np.sqrt((grid_x - 380.0)**2 + (grid_z - 820.0)**2)
is_se_cove = dist_se_cove < 150.0

is_beach_cove = is_harbor_cove | is_se_cove

# Mountain peaks definition (gx, gz, height, radius)
mountain_peaks = [
    # East / Northeast Mountain Massif (behind and within forest)
    {"x": 420.0, "z": -350.0, "h": 115.0, "r": 260.0}, # Mount Rusticus (Main Northeast Peak)
    {"x": 520.0, "z": 50.0,   "h": 95.0,  "r": 240.0}, # East Summit
    {"x": 580.0, "z": -180.0, "h": 85.0,  "r": 200.0}, # Eastern Sea Ridge
    {"x": 300.0, "z": -180.0, "h": 65.0,  "r": 180.0}, # Northeast Foothill Peak
    {"x": 460.0, "z": 320.0,  "h": 58.0,  "r": 190.0}, # Southeast Highland
    
    # North Peninsula Mountain Spine
    {"x": -120.0, "z": -640.0, "h": 75.0, "r": 190.0}, # North Peninsula Peak
    {"x": -80.0,  "z": -480.0, "h": 50.0, "r": 160.0}, # North Peninsula Saddle
    
    # West Coast Bluffs & Overlook (sheltering the harbor)
    {"x": -440.0, "z": 60.0,   "h": 58.0, "r": 180.0}, # West Coast Peak
    {"x": -360.0, "z": 220.0,  "h": 46.0, "r": 160.0}, # Southwest Coastal Ridge
    
    # South / Farmland Flanking Hills
    {"x": -260.0, "z": 650.0,  "h": 42.0, "r": 170.0}, # Southwest Hill
    {"x": 360.0,  "z": 680.0,  "h": 46.0, "r": 180.0}, # Southeast Hill
]

# Generate procedural craggy mountain ridges
noise_crag = (
    8.0 * np.sin(grid_x * 0.022 + grid_z * 0.014) * np.cos(grid_x * 0.016 - grid_z * 0.020)
    + 4.0 * np.sin(grid_x * 0.045 - grid_z * 0.038)
    + 2.0 * np.cos(grid_x * 0.090 + grid_z * 0.080)
)

for r_idx in range(GRID_SIZE):
    for c_idx in range(GRID_SIZE):
        gx = grid_x[r_idx, c_idx]
        gz = grid_z[r_idx, c_idx]
        is_l = grid_land[r_idx, c_idx]

        if not is_l:
            # Ocean seabed: smoothly drops from 0m at coast to -10m in open sea
            d = grid_dist_out[r_idx, c_idx]
            if d < 30.0:
                h = -np.clip(d / 30.0 * 5.0, 0.0, 5.0)
            else:
                h = -5.0 - np.clip((d - 30.0) / 100.0 * 5.0, 0.0, 5.0)
            elev[r_idx, c_idx] = h
        else:
            # Land elevation
            d_in = grid_dist_in[r_idx, c_idx]

            # Base plateau height (town base is 5.5m)
            base_h = 5.5

            # Mountain contributions
            mountain_h = 0.0
            for peak in mountain_peaks:
                p_dist = np.sqrt((gx - peak["x"])**2 + (gz - peak["z"])**2)
                if p_dist < peak["r"]:
                    # Cosine smooth bell-curve for mountain shape
                    norm_d = p_dist / peak["r"]
                    peak_contrib = (peak["h"] - base_h) * 0.5 * (1.0 + np.cos(norm_d * np.pi))
                    mountain_h = max(mountain_h, peak_contrib)

            # Mountain factor for crags
            m_factor = np.clip(mountain_h / 30.0, 0.0, 1.0)
            craggy_add = noise_crag[r_idx, c_idx] * m_factor

            target_h = base_h + mountain_h + craggy_add

            # Farmland fields remain gentle rolling (+6m to +10m)
            if gz > 250.0 and gx < 350.0 and gx > -180.0:
                target_h = min(target_h, 8.5)

            # Near-coast transition:
            if is_beach_cove[r_idx, c_idx]:
                # Gentle beach transition: 0.8m -> 2.5m -> target_h
                h = np.clip(d_in / 45.0, 0.0, 1.0) * target_h
                h = max(h, 1.0)
            else:
                # Steep dramatic rocky perimeter cliffs (+18m to +32m)!
                cliff_h = np.clip(d_in / 30.0, 0.0, 1.0) * target_h
                edge_cliff = np.clip(d_in / 15.0, 0.0, 1.0) * 22.0
                h = max(cliff_h, edge_cliff)
                h = min(h, target_h)

            # Town center plateau is flat around (0, 0) for plaza and fountain
            dist_center = np.sqrt(gx**2 + gz**2)
            if dist_center < 70.0:
                h = 5.50
            elif dist_center < 110.0:
                # Gentle transition from 5.5m to surrounding terrain
                t = (dist_center - 70.0) / 40.0
                h = 5.50 * (1.0 - t) + h * t

            elev[r_idx, c_idx] = h

# 6. Smooth elevation slightly with separable 2D convolution
def blur2d(arr, iterations=2):
    res = arr.copy()
    for _ in range(iterations):
        res[:, 1:-1] = 0.25 * res[:, :-2] + 0.5 * res[:, 1:-1] + 0.25 * res[:, 2:]
        res[1:-1, :] = 0.25 * res[:-2, :] + 0.5 * res[1:-1, :] + 0.25 * res[2:, :]
    return res

elev_smooth = blur2d(elev, 2)

# Preserve exact town square height 5.5m at center:
dist_from_origin = np.sqrt(grid_x**2 + grid_z**2)
center_mask = dist_from_origin < 60.0
elev_smooth[center_mask] = 5.50

# Ensure seabed stays <= -0.6m outside land
ocean_mask = ~grid_land
elev_smooth[ocean_mask] = np.minimum(elev_smooth[ocean_mask], -0.6)

# Save 16-bit binary elevation grid
# Encoded as uint16: (h + 10.0) * 100.0 (resolution: 1cm, range -10.0m to +645.0m)
u16_elev = np.clip((elev_smooth + 10.0) * 100.0, 0, 65535).astype(np.uint16)
bin_path = os.path.join(OUTPUT_DIR, "island_rpg_elev_512.bin")
u16_elev.tofile(bin_path)
print(f"Saved {bin_path}. Min h: {elev_smooth.min():.2f}m, Max h: {elev_smooth.max():.2f}m")
print(f"Elevation at player spawn (0, 0): {elev_smooth[256, 256]:.2f}m")

# 7. Generate 1024x1024 Texture Splat Map
# Red = Sand, Green = Green Foliage, Blue = Rock, Alpha = Land Mask
SPLAT_SIZE = 1024
splat_xs = np.linspace(-MAP_SIZE / 2.0, MAP_SIZE / 2.0, SPLAT_SIZE)
splat_zs = np.linspace(-MAP_SIZE / 2.0, MAP_SIZE / 2.0, SPLAT_SIZE)
sg_x, sg_z = np.meshgrid(splat_xs, splat_zs)

sref_x = np.clip(np.round(fx + sg_x / METERS_PER_PIXEL).astype(int), 0, orig_w - 1)
sref_y = np.clip(np.round(fy + sg_z / METERS_PER_PIXEL).astype(int), 0, orig_h - 1)
sin_bounds = (fx + sg_x / METERS_PER_PIXEL >= 0) & (fx + sg_x / METERS_PER_PIXEL < orig_w - 1) & (fy + sg_z / METERS_PER_PIXEL >= 0) & (fy + sg_z / METERS_PER_PIXEL < orig_h - 1)

splat_rgba = np.zeros((SPLAT_SIZE, SPLAT_SIZE, 4), dtype=np.uint8)

splat_l = np.zeros((SPLAT_SIZE, SPLAT_SIZE), dtype=bool)
splat_l[sin_bounds] = land_clean[sref_y[sin_bounds], sref_x[sin_bounds]]

splat_s = np.zeros((SPLAT_SIZE, SPLAT_SIZE), dtype=bool)
splat_s[sin_bounds] = is_sand[sref_y[sin_bounds], sref_x[sin_bounds]]

splat_r = np.zeros((SPLAT_SIZE, SPLAT_SIZE), dtype=bool)
splat_r[sin_bounds] = is_rock[sref_y[sin_bounds], sref_x[sin_bounds]]

splat_g = np.zeros((SPLAT_SIZE, SPLAT_SIZE), dtype=bool)
splat_g[sin_bounds] = is_green[sref_y[sin_bounds], sref_x[sin_bounds]]

# Resample elev_smooth to 1024x1024 to detect steep mountain slopes & peaks
elev_splat_img = Image.fromarray(elev_smooth).resize((SPLAT_SIZE, SPLAT_SIZE), Image.Resampling.BILINEAR)
elev_splat = np.array(elev_splat_img)

# Compute terrain slope gradient (rise over run)
dz, dx = np.gradient(elev_splat, MAP_SIZE / SPLAT_SIZE)
slope_mag = np.sqrt(dx**2 + dz**2)

# Steep mountain cliff drops and perimeter bluffs are rock
steep_rock = (slope_mag > 0.48) & splat_l
# Summit rocky crags (h > 92m) on steep ground
high_peak_rock = (elev_splat > 92.0) & splat_l & (slope_mag > 0.28)

splat_r = splat_r | steep_rock | high_peak_rock

# Town square plaza is pure sand/cobblestone
s_dist_origin = np.sqrt(sg_x**2 + sg_z**2)
plaza_mask = s_dist_origin < 55.0
splat_s[plaza_mask] = True
splat_g[plaza_mask] = False
splat_r[plaza_mask] = False

# Ensure green covers the mountain slopes, valleys, and forest floor
splat_g = splat_g & ~splat_r & ~splat_s

# Channel weights:
# R: sand
splat_rgba[..., 0] = np.where(splat_s, 255, 0).astype(np.uint8)
# G: green
splat_rgba[..., 1] = np.where(splat_g, 255, 0).astype(np.uint8)
# B: rock
splat_rgba[..., 2] = np.where(splat_r, 255, 0).astype(np.uint8)
# A: 255 on land, 0 on ocean
splat_rgba[..., 3] = np.where(splat_l, 255, 0).astype(np.uint8)

splat_pil = Image.fromarray(splat_rgba)
# Light blur to blend transitions smoothly
splat_pil = splat_pil.filter(ImageFilter.GaussianBlur(radius=2.0))
splat_path = os.path.join(OUTPUT_DIR, "island_rpg_splatmap.png")
splat_pil.save(splat_path)
print(f"Saved {splat_path}")

# 8. Extract Coordinates for Landmarks & 3D Props
# A. Docks (Northwest bay): (-265m, -140m)
# B. Farmland: 6 rectangular fields in the south
# C. Buildings along the town streets
# D. Dense Forest tree bounding region
# E. Offshore Islets

# Detect buildings / structures in town from original image:
# Houses have reddish/orange/grey roofs: (r > 130) and (r > g + 15) and (r > b + 25)
town_mask = (abs(grid_x) < 400.0) & (abs(grid_z) < 400.0) & grid_land & (dist_from_origin > 45.0)
buildings_list = []

# Town buildings around the square and along the streets:
# We sample points on land where sand road meets village houses
town_house_spots = [
    # Around the central plaza:
    {"x": -45, "z": -35, "rot": 0.4},
    {"x": -55, "z": 10, "rot": 1.2},
    {"x": -35, "z": 45, "rot": 2.1},
    {"x": 20, "z": 50, "rot": 2.8},
    {"x": 55, "z": 25, "rot": -2.2},
    {"x": 60, "z": -20, "rot": -1.3},
    {"x": 30, "z": -50, "rot": -0.6},
    {"x": -10, "z": -58, "rot": 0.1},
    # Along the harbor road (heading west toward docks):
    {"x": -90, "z": -25, "rot": 0.3},
    {"x": -130, "z": -40, "rot": 0.5},
    {"x": -165, "z": -70, "rot": 0.8},
    {"x": -200, "z": -100, "rot": 0.9},
    {"x": -110, "z": 15, "rot": -0.4},
    {"x": -150, "z": 20, "rot": -0.5},
    {"x": -190, "z": 5, "rot": -0.2},
    # Along north road:
    {"x": -25, "z": -110, "rot": 0.1},
    {"x": 20, "z": -115, "rot": -0.2},
    {"x": 50, "z": -160, "rot": -0.4},
    {"x": -10, "z": -180, "rot": 0.2},
    # Along east road toward forest:
    {"x": 100, "z": 10, "rot": 1.5},
    {"x": 140, "z": 30, "rot": 1.8},
    {"x": 180, "z": 65, "rot": 2.0},
    {"x": 115, "z": -30, "rot": -1.2},
    {"x": 155, "z": -40, "rot": -1.4},
    # Along south road toward farmland:
    {"x": -20, "z": 95, "rot": 3.1},
    {"x": 25, "z": 110, "rot": 3.0},
    {"x": -35, "z": 150, "rot": 2.9},
    {"x": 40, "z": 170, "rot": 3.1},
]

# Farmland fields (6 big rectangular golden fields):
farmland_fields = [
    {"cx": 80, "cz": 420, "w": 120, "h": 90, "rot": 0.3},
    {"cx": 210, "cz": 460, "w": 110, "h": 85, "rot": 0.3},
    {"cx": 330, "cz": 510, "w": 110, "h": 85, "rot": 0.35},
    {"cx": 40, "cz": 550, "w": 130, "h": 95, "rot": 0.3},
    {"cx": 180, "cz": 600, "w": 120, "h": 90, "rot": 0.32},
    {"cx": -80, "cz": 650, "w": 110, "h": 85, "rot": 0.25},
]

# Docks at northwest bay:
docks = [
    {"x": -255, "z": -130, "len": 45, "rot": -0.7},
    {"x": -275, "z": -165, "len": 55, "rot": -0.5},
    {"x": -240, "z": -95, "len": 40, "rot": -0.9},
]

# Offshore Islets:
islets = [
    {"name": "North Rock", "x": -340, "z": -860, "radius": 45},
    {"name": "West Rock", "x": -680, "z": -140, "radius": 40},
    {"name": "Southeast Reef", "x": 710, "z": 1000, "radius": 50},
]

landmarks_data = {
    "mapSize": MAP_SIZE,
    "fountain": {"x": 0.0, "y": 5.50, "z": 0.0},
    "townHouses": town_house_spots,
    "farmlandFields": farmland_fields,
    "docks": docks,
    "islets": islets,
    "forestZone": {"minX": 120, "maxX": 650, "minZ": -550, "maxZ": 250}
}

json_path = os.path.join(OUTPUT_DIR, "island_rpg_landmarks.json")
with open(json_path, "w") as f:
    json.dump(landmarks_data, f, indent=2)
print(f"Saved {json_path}")
