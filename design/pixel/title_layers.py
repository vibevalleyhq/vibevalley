#!/usr/bin/env python3
"""Cut what moves over the title screen out of its sheets (gen.sh title-clouds title-smoke title-dandelion
title-plants): magenta off, each cell trimmed to what is drawn. They keep the scale they were drawn at, the title
pictures' own (an art pixel is four image pixels, on a 1536 x 1024 scene), so the page places them on the scene in
the scene's own coordinates (app/lib/shell/title/layers.dart). Writes app/assets/title/<name>.png and sprites.json
(each sprite's width and height).

Run from design/pixel: python3 title_layers.py
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "app" / "assets" / "title"

SHEETS = {
    "title-clouds": (3, 2, ["cloud-big-1", "cloud-mid-1", "cloud-wisp-1", "cloud-big-2", "cloud-mid-2", "cloud-wisp-2"]),
    "title-smoke": (4, 2, ["puff-1", "puff-2", "puff-3", "puff-4", "wisp-1", "wisp-2", "wisp-3", "wisp-4"]),
    "title-dandelion": (4, 2, ["dandelion-1", "dandelion-2", "dandelion-3", "dandelion-4", "seed-1", "seed-2", "seed-3", "seed-4"]),
    "title-plants": (3, 2, ["grass-tall", "grass-yellow", "grass-daisy", "fern", "grass-dandelion", "grass-low"]),
    # The farmer at each hour, and each pet's frames, standing where the scene leaves room for them.
    "title-manager": (4, 1, ["manager-morning", "manager-day", "manager-evening", "manager-night"]),
    **{f"title-{pet}": (4, 1, [f"{pet}-sit", f"{pet}-tail", f"{pet}-look", f"{pet}-sleep"]) for pet in ["dog", "ragdoll", "bluecat"]},
}


def solid_mask(im: Image.Image) -> np.ndarray:
    """What is drawn: not magenta, nor the pink fringe where the painting met it (red and blue high, green low)."""
    rgb = np.asarray(im.convert("RGB")).astype(int)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return ~((r > 140) & (b > 140) & (g < np.minimum(r, b) - 60))


def unfringe(rgb: np.ndarray, mine: np.ndarray) -> np.ndarray:
    """Peels the purple rim the magenta left on the edges: pixels where red and blue both stand well above green,
    next to what is transparent, a few times over. Brown outlines (blue below green) stay."""
    r, g, b = (rgb[..., k].astype(int) for k in range(3))
    purple = (r - g > 30) & (b - g > 30)
    for _ in range(3):
        edge = mine & ~ndimage.binary_erosion(mine)
        peel = edge & purple
        if not peel.any():
            break
        mine = mine & ~peel
    return mine


def items(im: Image.Image, cols: int, rows: int) -> list[Image.Image]:
    """The sheet's items, in reading order. Items are found as blobs, not cut by the grid: the painting does not keep
    to its cells (a tall plant reaches into the row below). An item's pieces (a seed's fluff and stalk) are joined by
    growing the drawing a little first; specks are dropped."""
    rgb = np.asarray(im.convert("RGB")).astype(np.uint8)
    solid = solid_mask(im)
    grown = ndimage.binary_dilation(solid, iterations=14)
    labels, count = ndimage.label(grown)
    blobs = []
    for i, box in enumerate(ndimage.find_objects(labels), start=1):
        if box is None:
            continue
        mine = (labels[box] == i) & solid[box]
        if mine.sum() < 400:
            continue
        mine = unfringe(rgb[box], mine)
        alpha = np.where(mine, 255, 0).astype(np.uint8)
        blobs.append((box, Image.fromarray(np.dstack([rgb[box], alpha]), "RGBA")))
    if len(blobs) != cols * rows:
        raise SystemExit(f"found {len(blobs)} items, expected {cols * rows}")
    # Rows by where each item's middle is, then left to right.
    blobs.sort(key=lambda b: (b[0][0].start + b[0][0].stop) / 2)
    ordered = []
    for r in range(rows):
        row = blobs[r * cols : (r + 1) * cols]
        ordered += sorted(row, key=lambda b: b[0][1].start)
    return [b[1] for b in ordered]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict[str, int]] = {}
    for sheet, (cols, rows, names) in SHEETS.items():
        for name, sprite in zip(names, items(Image.open(HERE / "raw" / f"{sheet}.png"), cols, rows)):
            sprite.save(OUT / f"{name}.png", optimize=True)
            manifest[name] = {"w": sprite.width, "h": sprite.height}
    (OUT / "sprites.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"title layers: {len(manifest)} sprites in {OUT}")


main()
