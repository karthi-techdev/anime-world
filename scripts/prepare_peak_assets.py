"""Prepare peak CC0 surfaces without changing gameplay or overwriting files.

Run from the project root with: python -I scripts/prepare_peak_assets.py ...
Network responses and archives stay in separate new temporary directories.
Only albedo, OpenGL normal, roughness maps and source records enter public.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid
from urllib.parse import urlparse
import zipfile

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public/assets/3d/environment/peak/surfaces"
BUDGET = 15_000_000
LICENSE_URL = "https://docs.ambientcg.com/license/"
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/"
CANDIDATES = ["Rock059", "Rock064", "Grass004", "Ground048", "Bark014", "Plaster001", "Bricks097", "RoofingTiles013B"]
# Material-local grade: saturation, contrast, RGB multipliers, normal XY strength.
MATERIALS = [
    ("rock", "Rock059", 512, 0.90, 1.05, (1.00, 1.035, 0.96), 0.85, (2.0, 2.0)),
    ("grass", "Grass004", 512, 0.90, 1.04, (0.96, 1.035, 0.94), 0.72, None),
    ("soil", "Ground048", 512, 0.84, 1.04, (1.035, 1.00, 0.96), 0.82, None),
    ("bark", "Bark014", 512, 0.82, 1.06, (1.035, 1.00, 0.965), 0.90, None),
    ("plaster", "Plaster001", 512, 0.65, 0.96, (1.04, 1.015, 0.96), 0.55, (2.0, 2.0)),
    ("brick", "Bricks097", 512, 0.82, 1.06, (1.035, 1.00, 0.955), 0.90, (2.4, 2.4)),
    ("roof", "RoofingTiles013B", 512, 0.84, 1.04, (1.02, 1.00, 0.97), 0.88, None),
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_new(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)


def write_json(path: Path, data: object) -> None:
    write_new(path, (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def fetch(root: Path, label: str, url: str, filename: str, max_bytes: int) -> dict:
    if urlparse(url).scheme != "https":
        raise ValueError("Only HTTPS source URLs are accepted")
    folder = root / (label + "-" + uuid.uuid4().hex[:10])
    folder.mkdir(parents=False, exist_ok=False)
    path = folder / filename
    result = subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "20", "--max-time", "180",
        "--max-filesize", str(max_bytes), "--output", str(path),
        "--write-out", "%{url_effective}", url,
    ], check=True, capture_output=True, text=True, cwd=ROOT)
    data = path.read_bytes()
    if len(data) > max_bytes:
        raise ValueError("Response exceeded byte limit")
    record = {"url": url, "effective_url": result.stdout.strip(), "bytes": len(data), "sha256": sha(data), "path": str(path)}
    write_json(folder / "receipt.json", record)
    return record


def candidates(workspace: Path) -> dict:
    found = {}
    for path in sorted(workspace.glob("query-*/assets.json")):
        for asset in json.loads(path.read_text(encoding="utf-8"))["foundAssets"]:
            found[asset["assetId"]] = asset
    return found


def packages(asset: dict, attribute: str) -> dict:
    matches = [d for f in asset["downloadFolders"].values()
               for c in f["downloadFiletypeCategories"].values()
               for d in c["downloads"] if d["attribute"] == attribute]
    if len(matches) != 1:
        raise ValueError(f"Expected one {attribute} download for {asset['assetId']}")
    package = matches[0]
    if not 0 < package["size"] <= 25_000_000:
        raise ValueError("Package exceeds the explicitly bounded 1K source limit")
    return package


def preview(workspace: Path) -> None:
    assets = candidates(workspace)
    sheet = Image.new("RGB", (4 * 280, 2 * 300), "#24282d")
    draw = ImageDraw.Draw(sheet)
    for i, asset_id in enumerate(CANDIDATES):
        record = fetch(workspace, asset_id + "-preview", assets[asset_id]["previewImage"]["256-PNG"], "preview.png", 2_000_000)
        with Image.open(record["path"]) as image:
            image = image.convert("RGB")
            image.thumbnail((256, 256))
            sheet.paste(image, ((i % 4) * 280 + 12, (i // 4) * 300 + 8))
        draw.text(((i % 4) * 280 + 12, (i // 4) * 300 + 274), asset_id, fill="white")
    folder = workspace / ("inspection-" + uuid.uuid4().hex[:10])
    folder.mkdir(exist_ok=False)
    sheet.save(folder / "candidates.jpg", quality=92)
    print(folder / "candidates.jpg")


def download(workspace: Path) -> None:
    ids = [m[1] for m in MATERIALS]
    url = "https://ambientcg.com/api/v2/full_json?id=" + ",".join(ids) + "&include=tagData,displayData,dimensionsData,downloadData,previewData,mapData"
    api = fetch(workspace, "selected-api", url, "assets.json", 2_000_000)
    assets = {a["assetId"]: a for a in json.loads(Path(api["path"]).read_text(encoding="utf-8"))["foundAssets"]}
    if set(assets) != set(ids):
        raise ValueError("Authoritative API did not return all selected assets")
    license_path = workspace / "license-page/license.html"
    license_data = license_path.read_bytes()
    if b"All ambientCG assets" not in license_data or b"CC0 1.0 Universal" not in license_data:
        raise ValueError("Global CC0 license evidence missing")
    receipts = {"api": api, "license": {"url": LICENSE_URL, "bytes": len(license_data), "sha256": sha(license_data), "path": str(license_path)}, "assets": {}}
    for asset_id in ids:
        asset = assets[asset_id]
        if asset["dataType"] != "Material":
            raise ValueError("Only PBR Material assets are allowed")
        page = fetch(workspace, asset_id + "-page", asset["shortLink"], "asset.html", 2_000_000)
        page_data = Path(page["path"]).read_text(encoding="utf-8")
        if "CC0" not in page_data or asset["displayName"] not in page_data:
            raise ValueError(f"No verified asset identity/CC0 declaration on {asset_id} page")
        package = packages(asset, "1K-PNG")
        archive = fetch(workspace, asset_id + "-archive", package["fullDownloadPath"], package["fileName"], package["size"] + 4096)
        if archive["bytes"] != package["size"]:
            raise ValueError(f"Archive size differs from authoritative API for {asset_id}")
        receipts["assets"][asset_id] = {"page": page, "archive": archive, "api_package": package}
        print(asset_id, archive["bytes"], archive["sha256"], flush=True)
    write_json(workspace / "selected-downloads.json", receipts)


def safe_archive(path: Path) -> tuple[dict, dict]:
    maps, licenses = {}, {}
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 100 or sum(m.file_size for m in members) > 100_000_000:
            raise ValueError("Unexpected archive expansion or member count")
        bad = archive.testzip()
        if bad:
            raise ValueError(f"Archive CRC failure: {bad}")
        for member in members:
            # Never extract archives to disk and never execute any member.
            name = member.filename
            if ".." in Path(name).parts or name.startswith(("/", "\\")):
                raise ValueError("Unsafe archive member name")
            if member.file_size > 30_000_000:
                raise ValueError("Unexpected member size")
            if re.search(r"_(Color|NormalGL|Roughness)\.png$", name):
                maps[name] = archive.read(member)
            elif name.lower().endswith(".txt"):
                data = archive.read(member)
                if b"CC0" in data or b"creativecommons.org/publicdomain/zero" in data:
                    licenses[name] = data
    return maps, licenses


def decoded(data: bytes, mode: str) -> Image.Image:
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or image.size not in ((1024, 1024), (1024, 512)):
            raise ValueError(f"Expected verified 1K PNG, received {image.format} {image.size}")
        image.load()
        return image.convert(mode)


def resize_tile(image: Image.Image, size: int) -> Image.Image:
    # Bricks097's 1K package is 1024x512. Repeat the seamless tile in V
    # before square downsampling instead of stretching its bricks into squares.
    if image.size == (1024, 512):
        square = Image.new(image.mode, (1024, 1024))
        square.paste(image, (0, 0))
        square.paste(image, (0, 512))
        image = square
    return image.resize((size, size), Image.Resampling.LANCZOS)


def normal_map(image: Image.Image, size: int, strength: float) -> Image.Image:
    # Work on signed tangent-space vectors, not gamma-corrected color.
    image = resize_tile(image, size)
    vector = np.asarray(image, dtype=np.float32) / 127.5 - 1.0
    vector[:, :, :2] *= strength
    length = np.linalg.norm(vector, axis=2, keepdims=True)
    vector /= np.maximum(length, 1e-8)
    return Image.fromarray(np.rint(np.clip((vector + 1.0) * 127.5, 0, 255)).astype(np.uint8))


def color_map(image: Image.Image, size: int, saturation: float, contrast: float, tint: tuple) -> Image.Image:
    # Pointwise artist grade only: no shadows/AO baked in, no boundary-altering blur.
    color = np.asarray(resize_tile(image, size), dtype=np.float32) / 255.0
    luminance = (color * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)).sum(axis=2, keepdims=True)
    color = (luminance + (color - luminance) * saturation - 0.5) * contrast + 0.5
    color *= np.array(tint, dtype=np.float32)
    return Image.fromarray(np.rint(np.clip(color * 255.0, 0, 255)).astype(np.uint8))


def encode(image: Image.Image, semantic: str) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True, compress_level=9)
    return buffer.getvalue()


def prepare(workspace: Path) -> None:
    if OUTPUT.exists():
        raise FileExistsError(f"Refusing to overwrite existing target: {OUTPUT}")
    receipts = json.loads((workspace / "selected-downloads.json").read_text(encoding="utf-8"))
    api_data = Path(receipts["api"]["path"]).read_bytes()
    if sha(api_data) != receipts["api"]["sha256"]:
        raise ValueError("API evidence checksum changed")
    assets = {a["assetId"]: a for a in json.loads(api_data)["foundAssets"]}
    license_data = (workspace / "license-page/license.html").read_bytes()
    if b"All ambientCG assets" not in license_data or b"CC0 1.0 Universal" not in license_data:
        raise ValueError("Global CC0 license evidence missing")
    manifest = {
        "schema_version": 1, "prepared_date": "2026-11-14",
        "provider": "ambientCG", "license": "CC0-1.0", "license_url": CC0_URL,
        "provider_license_url": LICENSE_URL, "provider_license_sha256": sha(license_data),
        "rights_verification": "Global ambientCG license page and each selected asset page explicitly declare CC0; asset pages and archive licenses retained where present.",
        "attribution_required": False, "source_upload": False,
        "preparation_command": "python -I scripts/prepare_peak_assets.py prepare --workspace <absolute-temporary-workspace>",
        "script_sha256": sha(Path(__file__).read_bytes()),
        "tool_versions": {"python": sys.version.split()[0], "pillow": Image.__version__, "numpy": np.__version__},
        "source_api": {k: v for k, v in receipts["api"].items() if k != "path"},
        "budget_bytes": BUDGET,
        "runtime_semantics": {
            "albedo": {"color_space": "sRGB", "channels": "RGB", "encoding": "lossless PNG", "usage": "base color / map; no AO or lighting added"},
            "normal": {"color_space": "linear / NoColorSpace", "channels": "RGB = signed tangent XYZ mapped from [-1,1] to [0,1]", "convention": "OpenGL (+Y / NormalGL), not DirectX", "encoding": "lossless PNG", "usage": "tangent-space normal map; XY scaled then vectors renormalized"},
            "roughness": {"color_space": "linear / NoColorSpace", "channels": "R (8-bit grayscale PNG; replicate into RGB when packing; Three.js roughnessMap samples G)", "range": "0=smooth, 1=rough (not glossiness)", "encoding": "lossless PNG", "usage": "roughness map; RGB replication also supports engines that sample G"},
        },
        "integration": {"url_root": "/assets/3d/environment/peak/surfaces/", "wrapping": "RepeatWrapping U and V; retain original UV orientation", "uv_orientation": "Original source orientation, no flip/rotate/crop; bark grain follows source V; rectangular Bricks097 source repeats twice in V before square resampling", "normal_scale": [1, 1], "metalness": 0, "roughness_multiplier": 1, "mipmaps": "Generate at runtime; all sizes are powers of two", "world_unit": "meters", "displacement": "Not included; texture normals do not alter silhouette or collision", "next_public_doc": "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/public-folder.md"},
        "materials": [],
    }
    pending = {}
    for slug, asset_id, size, saturation, contrast, tint, strength, fallback in MATERIALS:
        asset = assets[asset_id]
        source = receipts["assets"][asset_id]
        archive_data = Path(source["archive"]["path"]).read_bytes()
        if sha(archive_data) != source["archive"]["sha256"]:
            raise ValueError("Archive checksum changed")
        maps, licenses = safe_archive(Path(source["archive"]["path"]))
        if len(maps) != 3:
            raise ValueError(f"Expected Color, NormalGL and Roughness for {asset_id}; found {list(maps)}")
        pending[f"sources/{asset_id}/api-record.json"] = (json.dumps(asset, indent=2) + "\n").encode()
        page_data = Path(source["page"]["path"]).read_bytes()
        if sha(page_data) != source["page"]["sha256"] or b"CC0" not in page_data:
            raise ValueError("Per-asset CC0 evidence missing or changed")
        # Retain the exact declaration snippet, not scripts or the full downloaded HTML.
        page_text = page_data.decode("utf-8")
        matches = re.findall(r".{0,180}CC0.{0,240}", page_text)
        pending[f"sources/{asset_id}/rights.json"] = (json.dumps({"license": "CC0-1.0", "page": {k: v for k, v in source["page"].items() if k != "path"}, "cc0_declaration_snippets": matches, "archive_license_members": list(licenses)}, indent=2) + "\n").encode()
        for index, (name, data) in enumerate(licenses.items()):
            pending[f"sources/{asset_id}/archive-license-{index + 1}.txt"] = data
        dimensions = (asset.get("dimensionX", 0), asset.get("dimensionY", 0))
        # Provider page gives dimensions in cm. Unknown 0 values are explicitly not measured.
        known = all(v > 0 for v in dimensions)
        tile = tuple(v / 100 for v in dimensions) if known else fallback
        material = {
            "name": slug, "asset_id": asset_id, "source_page_url": asset["shortLink"],
            "license": "CC0-1.0", "source_archive": {k: v for k, v in source["archive"].items() if k != "path"},
            "api_reported_archive_bytes": source["api_package"]["size"],
            "archive_attribute": "1K-PNG", "source_creation_method": asset.get("creationMethod"),
            "provider_dimensions_cm": list(dimensions), "tile_size_m": list(tile),
            "tile_size_basis": "provider measured dimensions" if known else "artist recommendation; provider reports unknown size (0)",
            "uv_repeats_per_meter": [round(1 / v, 6) for v in tile],
            "grade": {"saturation": saturation, "contrast_about_srgb_0_5": contrast, "rgb_multiplier": list(tint), "normal_xy_strength_baked": strength, "style": "Restrained warm/green palette, reduced photographic saturation, retained high-frequency material detail"},
            "maps": {},
        }
        for semantic, suffix, mode in [("albedo", "Color", "RGB"), ("normal", "NormalGL", "RGB"), ("roughness", "Roughness", "L")]:
            name = next(n for n in maps if n.endswith("_" + suffix + ".png"))
            image = decoded(maps[name], mode)
            source_dimensions = list(image.size)
            if image.size == (1024, 512) and asset_id != "Bricks097":
                raise ValueError("Only the verified rectangular brick source may be tiled in V")
            material["source_tile_repeat_uv"] = [1, 2] if image.size == (1024, 512) else [1, 1]
            target_size = size
            if semantic == "albedo":
                image = color_map(image, target_size, saturation, contrast, tint)
            elif semantic == "normal":
                image = normal_map(image, target_size, strength)
            else:
                image = resize_tile(image, target_size)
            data = encode(image, semantic)
            relative = f"{slug}/{semantic}.png"
            pending[relative] = data
            with Image.open(io.BytesIO(data)) as check:
                check.load()
                if check.size != (target_size, target_size) or check.format != "PNG":
                    raise ValueError("Encoded map validation failed")
            material["maps"][semantic] = {"file": relative, "url": manifest["integration"]["url_root"] + relative, "dimensions": [target_size, target_size], "bytes": len(data), "sha256": sha(data), "source_member": name, "source_member_sha256": sha(maps[name]), "source_dimensions": source_dimensions}
        manifest["materials"].append(material)
        print("Prepared", slug, sum(m["bytes"] for m in material["maps"].values()), "bytes", flush=True)
    pending["sources/provider-license.json"] = (json.dumps({"url": LICENSE_URL, "sha256": sha(license_data), "license": "CC0-1.0", "license_url": CC0_URL, "declaration": "All ambientCG assets are provided under the Creative Commons CC0 1.0 Universal License. This applies to the downloadable asset files and the material preview renders shown for each asset on the site.", "attribution_required": False}, indent=2) + "\n").encode()
    manifest["texture_bytes"] = sum(len(v) for k, v in pending.items() if k.endswith(".png"))
    manifest["total_files"] = len(pending) + 1
    pending["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    total = sum(map(len, pending.values()))
    if total > BUDGET:
        raise ValueError(f"Total prepared footprint {total} exceeds {BUDGET}; no public output written")
    OUTPUT.mkdir(parents=True, exist_ok=False)
    for relative, data in pending.items():
        write_new(OUTPUT / relative, data)
    print("TOTAL", total, "bytes", len(pending), "files")
    validate(workspace)


def validate(workspace: Path) -> None:
    manifest = json.loads((OUTPUT / "manifest.json").read_text(encoding="utf-8"))
    expected = {"manifest.json", "sources/provider-license.json"}
    for material in manifest["materials"]:
        asset_id = material["asset_id"]
        expected.update({f"sources/{asset_id}/api-record.json", f"sources/{asset_id}/rights.json"})
        rights = json.loads((OUTPUT / f"sources/{asset_id}/rights.json").read_text(encoding="utf-8"))
        for index in range(len(rights["archive_license_members"])):
            expected.add(f"sources/{asset_id}/archive-license-{index + 1}.txt")
        for semantic, record in material["maps"].items():
            path = OUTPUT / record["file"]
            expected.add(record["file"])
            data = path.read_bytes()
            assert sha(data) == record["sha256"] and len(data) == record["bytes"]
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                assert list(image.size) == record["dimensions"]
                assert image.format == "PNG" and image.size == (512, 512)
                assert image.mode == ("L" if semantic == "roughness" else "RGB")
                arr = np.asarray(image.convert("RGB"), dtype=np.float32)
                assert np.ptp(arr) > 0, f"Flat placeholder: {path}"
                if semantic == "normal":
                    lengths = np.linalg.norm(arr / 127.5 - 1, axis=2)
                    assert np.max(np.abs(lengths - 1)) < 0.015, "Normal vectors must be unit length"
                    assert arr[:, :, 2].min() >= 127, "Expected positive-Z tangent normals"
                if semantic == "roughness":
                    assert np.array_equal(arr[:, :, 0], arr[:, :, 1]) and np.array_equal(arr[:, :, 0], arr[:, :, 2])
            print(record["file"], record["dimensions"], record["bytes"], record["sha256"])
    actual = {p.relative_to(OUTPUT).as_posix() for p in OUTPUT.rglob("*") if p.is_file()}
    assert actual == expected, f"Unexpected/missing files: {actual ^ expected}"
    total = sum((OUTPUT / p).stat().st_size for p in actual)
    assert total <= BUDGET
    print("VALIDATED", len(actual), "files", total, "bytes", "texture bytes", manifest["texture_bytes"])


def inspect(workspace: Path) -> None:
    manifest = json.loads((OUTPUT / "manifest.json").read_text(encoding="utf-8"))
    sheet = Image.new("RGB", (7 * 210, 3 * 230), "#232930")
    draw = ImageDraw.Draw(sheet)
    for column, material in enumerate(manifest["materials"]):
        for row, semantic in enumerate(("albedo", "normal", "roughness")):
            with Image.open(OUTPUT / material["maps"][semantic]["file"]) as image:
                image = image.convert("RGB").resize((200, 200), Image.Resampling.LANCZOS)
                sheet.paste(image, (column * 210 + 5, row * 230 + 5))
            draw.text((column * 210 + 5, row * 230 + 211), material["name"] + " " + semantic, fill="white")
    folder = workspace / ("inspection-output-" + uuid.uuid4().hex[:10])
    folder.mkdir(exist_ok=False)
    sheet.save(folder / "prepared.jpg", quality=94)
    print(folder / "prepared.jpg")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preview", "download", "prepare", "validate", "inspect"))
    parser.add_argument("--workspace", required=True, type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    if workspace.parent != (ROOT / "tmp").resolve() or not workspace.name.startswith("peak-downloads-"):
        parser.error("Workspace must be a separate tmp/peak-downloads-[unique] directory")
    if Path.cwd().resolve() != ROOT:
        parser.error("Run from the project root, never from downloaded data directories")
    if not sys.flags.isolated:
        parser.error("Python isolated mode (-I) is required")
    globals()[args.command](workspace)


if __name__ == "__main__":
    main()
