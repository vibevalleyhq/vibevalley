"""Straight lines the image tool cannot draw: run by process.py after it cuts the map and the plots.

- The field: the dirt in the middle of the map is a rectangle. Grass the painting let into it becomes dirt, dirt that
  bulges out of it becomes grass, along each edge; the paths that lead out of it (to the house, to the gate) stay.
- The plots: the painting leans each bed's sides in; every row is stretched until they stand straight up. The
  magenta's purple rim goes.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

# ── The field ──────────────────────────────────────────────────────────────────────────────────────────────────────

# Of the map at 384 x 256 art pixels: the dirt rectangle, edges inclusive (scaled by the map's density).
FIELD = (94, 97, 290, 201)
BAND = 5  # art pixels either side of an edge that are put right


def dirt_of(rgb: np.ndarray) -> np.ndarray:
    """Where a picture is bare light-brown soil: the map's field, an island's yard."""
    r, g, b = (rgb[..., k].astype(int) for k in range(3))
    return (r > 160) & (g > 110) & (g < 190) & (b > 50) & (b < 140) & (r - g > 35) & (g - b > 25)


def straighten_field(path: Path) -> None:
    img = Image.open(path).convert("RGB")
    d = img.width // 384
    rgb = np.asarray(img).copy()
    dirt = dirt_of(rgb)
    x0, y0, x1, y1 = (v * d for v in FIELD)
    x1, y1 = x1 + d - 1, y1 + d - 1
    band = BAND * d
    reach = band + 3 * d  # where to look for what a pixel should be: past the band
    h, w = dirt.shape
    out = rgb.copy()

    def fix(y: int, x: int, inside: bool, dy: int, dx: int) -> None:
        """Puts right the pixel at (y, x): inside the field it must be dirt, outside grass (unless a path goes out)."""
        sy, sx = y + dy * reach, x + dx * reach
        if not (0 <= sy < h and 0 <= sx < w):
            return
        if inside and not dirt[y, x]:
            # Dirt from further in, on the same line: the grain carries on.
            iy, ix = y - dy * reach, x - dx * reach
            if 0 <= iy < h and 0 <= ix < w and dirt[iy, ix]:
                out[y, x] = rgb[iy, ix]
        elif not inside and dirt[y, x]:
            # Grass from further out, unless the dirt goes on out there anywhere along the way (a path).
            ahead = [(y + dy * k, x + dx * k) for k in range(d, 2 * reach, d)]
            if not any(0 <= py < h and 0 <= px < w and dirt[py, px] for py, px in ahead[band // d :]):
                out[y, x] = rgb[sy, sx]

    for y in range(y0 - band, y1 + band + 1):
        for x in range(x0 - band, x1 + band + 1):
            if not (0 <= y < h and 0 <= x < w):
                continue
            inside = x0 <= x <= x1 and y0 <= y <= y1
            # The nearest edge decides which way is in and out.
            dists = [(abs(y - y0), -1, 0), (abs(y - y1), 1, 0), (abs(x - x0), 0, -1), (abs(x - x1), 0, 1)]
            dist, dy, dx = min(dists)
            if dist > band:
                continue
            fix(y, x, inside, dy, dx)
    Image.fromarray(out).save(path)


# ── The plots ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _purple(rgb: np.ndarray) -> np.ndarray:
    r, g, b = (rgb[..., k].astype(int) for k in range(3))
    return (r - g > 30) & (b - g > 30)


def _edges(alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray, int, int]:
    """
    The frame's left and right edge on every row, as lines fitted to the rows the frame spans (a leaf over its side, a
    row of it too short, do not count); and the first and last of those rows.
    """
    solid = alpha > 0
    widths = solid.sum(axis=1)
    rows = np.nonzero(widths >= 0.8 * widths.max())[0]
    ys = rows.astype(float)
    left = np.array([np.nonzero(solid[y])[0].min() for y in rows], float)
    right = np.array([np.nonzero(solid[y])[0].max() for y in rows], float)

    def fit(xs: np.ndarray) -> np.ndarray:
        keep = np.ones(len(xs), bool)
        for _ in range(3):
            k, c = np.polyfit(ys[keep], xs[keep], 1)
            keep = np.abs(xs - (k * ys + c)) <= 1.5
        all_y = np.clip(np.arange(alpha.shape[0]), rows[0], rows[-1])
        return k * all_y + c

    return fit(left), fit(right), int(rows[0]), int(rows[-1])


def straighten_plots(out: Path, names: list[str]) -> None:
    """
    Squares every plot sprite's frame. The painting leans its sides in (a bed seen from above, drawn a little in
    perspective), so each row is stretched until the frame's edges stand straight up, at the width of its base. What
    grows above the frame moves with its top row. The magenta's purple rim goes.
    """
    for name in names:
        src = np.asarray(Image.open(out / f"{name}.png").convert("RGBA")).copy()
        src[_purple(src[..., :3]) & (src[..., 3] > 0), 3] = 0
        h, w = src.shape[:2]
        left, right, _, bottom = _edges(src[..., 3])
        l0, r0 = round(left[bottom]), round(right[bottom])  # the base: where every row's edges go
        out_img = np.zeros_like(src)
        xs = np.arange(w, dtype=float)
        for y in range(h):
            # Where in the painted row each straight column comes from (nearest pixel).
            scale = (right[y] - left[y]) / max(1.0, r0 - l0)
            at = np.rint(left[y] + (xs - l0) * scale).astype(int)
            ok = (at >= 0) & (at < w)
            out_img[y, ok] = src[y, at[ok]]
        Image.fromarray(out_img, "RGBA").save(out / f"{name}.png")
    print(f"plots: {len(names)} squared")
