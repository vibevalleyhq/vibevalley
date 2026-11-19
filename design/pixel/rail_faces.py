"""Render the navigation portraits from their pixel sprites at each supported display density."""

import argparse
import json
from math import floor
from pathlib import Path

from PIL import Image


RAIL_SIZE = 38


def rail_faces(image, sprite):
    # At the rail's half-point horizontal origin, the browser snaps the two x edges down.
    # The y origin is integral. Snap each y edge to the nearest point before sampling.
    scale = RAIL_SIZE / (image.width * 0.86)
    left = floor((RAIL_SIZE - image.width * scale) / 2)
    right = floor((RAIL_SIZE + image.width * scale) / 2)
    top = floor(RAIL_SIZE * 0.04 + 0.5)
    bottom = floor(RAIL_SIZE * 0.04 + image.height * scale + 0.5)
    for dpr in (1, 2):
        tile = Image.new("RGBA", (RAIL_SIZE * dpr, RAIL_SIZE * dpr))
        portrait = image.resize(((right - left) * dpr, (bottom - top) * dpr), Image.Resampling.NEAREST)
        tile.paste(portrait, (left * dpr, top * dpr))
        yield f"{sprite}-{dpr}x.png", tile


def save_rail_faces(image, directory, sprite):
    directory.mkdir(exist_ok=True)
    for name, tile in rail_faces(image, sprite):
        tile.save(directory / name, optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[2] / "assets/pixel")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    manifest_file = args.directory / "sprites.json"
    manifest = json.loads(manifest_file.read_text())
    directory = args.directory / "rail"
    for sprite, entry in manifest.items():
        if not (sprite.startswith("manager-") and sprite.endswith("-face")):
            continue
        with Image.open(args.directory / f"{sprite}.png") as source:
            image = source.convert("RGBA")
        if args.check:
            if entry.get("railSize") != RAIL_SIZE:
                raise SystemExit(f"Missing railSize for {sprite} in {manifest_file}")
            for name, tile in rail_faces(image, sprite):
                with Image.open(directory / name) as actual:
                    if actual.size != tile.size or actual.convert("RGBA").tobytes() != tile.tobytes():
                        raise SystemExit(f"Regenerate {directory / name} with {Path(__file__).name}")
        else:
            save_rail_faces(image, directory, sprite)
            entry["railSize"] = RAIL_SIZE
    if not args.check:
        manifest_file.write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
