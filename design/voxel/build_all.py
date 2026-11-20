"""Build every refined VibeValley 3D voxel .glb asset and baked scene sprite.

Usage:
    blender --background --python design/voxel/build_all.py -- assets/models
    blender --background --python design/voxel/build_all.py -- assets/models --only helpers,scenes
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from companions import build_managers, build_pets
from helpers import OUTFITS, SPECIES, build_helper
from scenes import build_farm_scene, build_foreground, build_islands
from world_props import build_machines, build_plots, build_props

ALL_TARGETS = {"helpers", "companions", "props", "scenes"}


def parse_args(argv):
    args = argv[argv.index("--") + 1:]
    out_dir = Path(args[0]).resolve()
    targets = set(ALL_TARGETS)
    if "--only" in args:
        idx = args.index("--only")
        targets = {t.strip() for t in args[idx + 1].split(",") if t.strip()}
    return out_dir, targets


if __name__ == "__main__":
    out_dir, targets = parse_args(sys.argv)
    out_dir.mkdir(parents=True, exist_ok=True)
    if "helpers" in targets:
        for sp in SPECIES:
            for of in OUTFITS:
                build_helper(sp, of, out_dir / f"{sp}-{of}.glb")
    if "companions" in targets:
        build_pets(out_dir)
        build_managers(out_dir)
    if "props" in targets:
        build_props(out_dir)
        build_machines(out_dir)
        build_plots(out_dir)
    if "scenes" in targets:
        assets_dir = out_dir.parent
        sprites_path = assets_dir / "pixel" / "sprites.json"
        if sprites_path.exists():
            sprites_meta = json.loads(sprites_path.read_text())
            build_farm_scene(assets_dir)
            build_islands(assets_dir, sprites_meta)
            build_foreground(assets_dir, sprites_meta)
    total = len(list(out_dir.glob("*.glb")))
    print(f"Built {total} .glb models in {out_dir} (targets={sorted(targets)})")
