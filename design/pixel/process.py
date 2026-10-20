#!/usr/bin/env python3
"""Shrink the generated pictures (gen.sh) to true pixel art for the pixel village (app/assets/pixel).

The image tool paints "pixel art" whose pixels are blocks of roughly 4 to 8 image pixels, not quite on a grid.
Every picture is shrunk to the size it is drawn at in the game (one art pixel = one canvas pixel), with box
averaging, then snapped to a small palette with hard alpha, so the game can scale it up by whole numbers.

Usage: python3 process.py [map plots manager char-bear ui-icons look-farmer ...]   (default: everything in raw/)
Writes app/assets/pixel/<name>.png and the manifest sprites.json: per sprite its size and anchor
(the point that stands on the ground, from its top-left: the middle of its lowest row, or of its feet when it holds a
tool to the ground; a character also records hx, hy, the middle of its head), and the sheet it was cut from.
Sprites take the painted farm's names where they replace one (icon-coin, act-search, manager-face); the client reads
them through lib/sprites/atlas.dart. ui-cursors becomes the pixel cursors in app/assets/cursors.
"""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from straighten import dirt_of, straighten_field, straighten_plots

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = HERE.parent.parent / "app" / "assets" / "pixel"
# The pixel density: how many of a picture's pixels make one of the village's art pixels. The game's pictures are
# drawn twice as dense (gen.sh hd-<name>, from raw/hd-<name>.png); by default the density is the one the game's
# pictures already have (its map's width against the village's 384), so a sheet is never cut to another. A trial
# elsewhere: PIXEL_DENSITY, PIXEL_RAW_PREFIX and PIXEL_OUT.
if "PIXEL_OUT" in os.environ:
    OUT = Path(os.environ["PIXEL_OUT"])
MANIFEST = OUT / "sprites.json"
_game_map = json.loads(MANIFEST.read_text()).get("map") if MANIFEST.exists() else None
DENSITY = int(os.environ.get("PIXEL_DENSITY", str(_game_map["w"] // 384 if _game_map else 1)))
RAW_PREFIX = os.environ.get("PIXEL_RAW_PREFIX", "hd-" if DENSITY == 2 else "")

# The languages with a logo: three sheets of twelve (gen.sh ui-langs-1..3).
LANGS = [
    ["typescript", "javascript", "python", "go", "rust", "java", "kotlin", "swift", "c", "cpp", "csharp", "ruby"],
    ["php", "shell", "html", "css", "sql", "dart", "lua", "scala", "elixir", "haskell", "zig", "r"],
    ["markdown", "json", "yaml", "julia", "vue", "svelte", "docker", "jupyter", "sass", "powershell", "terraform", "other"],
]

# The village is 384 x 256 canvas pixels; the map is generated at 1536 x 1024.
MAP_SIZE = (384 * DENSITY, 256 * DENSITY)
MAP_COLOURS = 64


@dataclass
class Sheet:
    """A grid of sprites on magenta. `height` is how tall the reference cells come out, in canvas pixels."""

    cols: int
    rows: int
    names: list[str | None]
    height: int
    # Cells whose height sets the scale for the whole sheet, so every frame shrinks by the same factor.
    reference: list[int]
    colours: int = 32
    # Characters: record the middle of the head, for round avatars.
    head: bool = False
    # Sprites drawn too big for the rest of the sheet: name -> extra factor.
    resize: dict[str, float] | None = None
    # Pictures standing in a frame (the plots' beds): each cell is scaled so its frame is this many art pixels wide and
    # cut on whole pixels around it, anchored at the frame's bottom middle, so every frame lands in the same place.
    frame_width: int | None = None
    # Cells holding a tool to the ground (a fork, a trowel): it reaches below the feet, which stand on the ground.
    tools: tuple[int, ...] = ()
    # Centre each picture on its feet, not on its box: a tool held out to one side (a hammer) does not move the body
    # between frames.
    feet_middle: bool = False
    # Logos: purple or pink of their own, so keyed by the background's reach rather than by colour alone (key()), and
    # sometimes in pieces far apart (a pair of braces), so cut by where each piece's middle is (logo_cells()).
    logos: bool = False
    # Glyphs in pieces (three dots, two sliders): every piece in the cell is kept, not just the largest and what is near
    # it; specks dropped.
    pieces: bool = False


DIRS = ["down", "up", "side"]
# Sitting (the bench), reading (the library), hammering (the anvil, from its side), working at something (the mast).
POSE_NAMES = ["sit", "read", "hammer-1", "hammer-2", "tinker-1", "tinker-2"]
CHAR_NAMES = [
    "down", "down-1", "down-2", "work",
    "up", "up-1", "up-2", "cheer",
    "side", "side-1", "side-2", "worry",
]

SHEETS: dict[str, Sheet] = {
    "plots": Sheet(4, 3, [
        "plot-empty", "plot-seeded", "plot-sprout", "plot-leafy",
        "plot-flowering", "plot-wheat", "plot-withered", "plot-weeds",
        "plot-dry", "plot-locked", "plot-harvested", "plot-carrot",
    ], height=28, reference=[0, 1, 2, 8, 10], frame_width=34),
    # The manager himself comes from look-farmer, the dog from its own sheet; this one gives nothing now (the mailbox
    # is a prop). Its dog is the reference for the dog sheet.
    "manager": Sheet(3, 2, [None, None, None, None, None, None], height=32, reference=[0]),
    # The dog in twelve poses (lib/village/dog.dart); the sitting ones set the scale.
    "dog": Sheet(4, 3, [
        "dog-sleep", "dog-lie", "dog-stretch", "dog-awake",
        "dog-wag-1", "dog-wag-2", "dog-bark", "dog-scratch",
        "dog-jump", "dog-belly", "dog-stand", "dog-yawn",
    ], height=20, reference=[3, 4, 5]),
    # The other pets, in the dog's twelve poses (gen.sh ragdoll bluecat), named as its are: <pet>-sleep, <pet>-wag-1…
    **{pet: Sheet(4, 3, [
        f"{pet}-{pose}" for pose in ["sleep", "lie", "stretch", "awake", "wag-1", "wag-2", "bark", "scratch", "jump", "belly", "stand", "yawn"]
    ], height=20, reference=[3, 4, 5]) for pet in ["ragdoll", "bluecat"]},
    # What the panels open from, standing in the yard (lib/village/world.dart).
    # Plants in front of the camera, framing the view: the nearest parallax layer.
    "foreground": Sheet(3, 2, ["fg-branch-left", "fg-branch-right", "fg-grass", "fg-bush-left", "fg-bush-right", "fg-fern"], height=56, reference=[3, 4], colours=24),
    "props": Sheet(3, 2, ["prop-stall", "prop-board", "prop-crates", "prop-table", "prop-mailbox", "prop-signpost"], height=30, reference=[0],
                   resize={"prop-mailbox": 0.65, "prop-signpost": 0.8}),
    # The interface, redrawn from the painted sheets (design/assets/raw), in their grids and with their names.
    "ui-icons": Sheet(4, 3, [
        "icon-hand", "icon-water", "icon-bug", "icon-weed",
        "icon-harvest", "icon-shovel", "icon-shop", "icon-crate",
        "icon-tasks", "icon-log", "icon-coin", "icon-clock",
    ], height=24, reference=list(range(12))),
    "ui-icons-more": Sheet(4, 3, [
        "icon-task-board", "icon-skillbook", "icon-shed", "icon-trophy",
        "icon-scarecrow", "icon-seeds", "icon-bunting", "icon-doghouse",
        "icon-wrench", "icon-bell", "icon-board", "icon-star",
    ], height=24, reference=list(range(12))),
    "ui-actions": Sheet(5, 2, [f"act-{a}" for a in ["thinking", "read_file", "edit_file", "run_command", "search", "web", "mcp", "wait", "other", "speaking_text"]], height=18, reference=list(range(10))),
    "ui-medals": Sheet(4, 2, ["medal-bronze", "medal-silver", "medal-gold", "medal-wood", "medal-locked", "stamp-done", "coins-stack", "banner-title"], height=40, reference=[0, 1, 2]),
    "ui-emblems": Sheet(5, 3, [
        f"emblem-{a}"
        for a in ["harvests", "first_try", "big_graph", "farm_level", "steady", "untangle", "comeback", "thrifty", "every_machine", "handoff", "parallel_graph", "night_owl", "weekend", "full_house", "wreath"]
    ], height=24, reference=list(range(15))),
    "ui-starter": Sheet(4, 2, [f"emblem-{a}" for a in ["s_open", "s_hire", "s_tell", "s_review", "s_voice", "s_split", "s_call", "starter"]], height=24, reference=list(range(8))),
    # Language logos, redrawn from design/assets/raw/langs-<n>.png; the letters in them stay (gen.sh, prompts/ui-langs.txt).
    **{f"ui-langs-{n}": Sheet(4, 3, [f"lang-{lang}" for lang in langs], height=24, reference=list(range(12)), logos=True) for n, langs in enumerate(LANGS, start=1)},
    # The runtimes' logos (logos/, LobeHub Icons) as pixel art: logo-<runtime id>, pinned on the machines.
    "logos": Sheet(4, 2, [f"logo-{r}" for r in ["claude", "codex", "opencode", "pi", "cursor", "grok", "kimi", "antigravity"]], height=24, reference=list(range(8)), logos=True),
    "ui-icons-extra": Sheet(3, 2, ["connector-weixin", "connector-feishu", "connector-qq", "icon-deed", "icon-pigeon", "app-sprout"], height=24, reference=list(range(6)), logos=True),
    # The energy meter's bottles (lib/ui/energy.dart): level and how full, one picture each.
    "energy": Sheet(3, 3, [
        "energy-plenty-100", "energy-plenty-75", "energy-plenty-50",
        "energy-low-40", "energy-low-25", "energy-empty-10",
        "energy-empty-0", "energy-unknown", "energy-gold",
    ], height=24, reference=list(range(9))),
    # The chat's buttons (lib/desk/chat/), shown at their own size.
    "buttons": Sheet(4, 2, [
        "button-send", "button-mic", "button-hangup", "button-back",
        "button-enlarge", "button-shrink", "button-collapse", "button-thread",
    ], height=16, reference=[1]),
    # The sound buttons (the voice settings' samples), drawn from Hugeicons' shapes (icons/).
    "media": Sheet(4, 2, [
        "button-play", "button-pause", "button-stop", "button-speaker",
        "button-mute", "button-replay", "button-record", "button-wait",
    ], height=16, reference=[0, 1, 2, 6]),
    # The interface's marks and small buttons, drawn from Hugeicons' shapes (icons/) beside the sound buttons, so the
    # pages draw no line icons: close, add, delete, the way in (turned for down and up), done, failed, a warning, copy.
    "glyphs": Sheet(4, 2, [
        "button-close", "button-add", "button-delete", "button-next",
        "mark-check", "mark-cross", "mark-warn", "button-copy",
    ], height=16, reference=[0, 1, 5]),
    # More buttons, drawn the same way beside the glyphs: refresh, a folder, search, edit, open, filter, settings, more.
    "tools": Sheet(4, 2, [
        "button-refresh", "button-folder", "button-search", "button-edit",
        "button-open", "button-filter", "button-settings", "button-more",
    ], height=16, reference=[0, 1, 2, 3], pieces=True),
    # The owner's face, beside the manager's and the helpers' in the chat (lib/shared/chat_widgets.dart OwnerFace).
    "owner": Sheet(1, 1, ["owner-face"], height=32, reference=[0]),
    # The projects page's commit calendar: a day's plot, bare to in flower (lib/desk/projects/codebase.dart).
    "calendar": Sheet(3, 2, ["day-0", "day-1", "day-2", "day-3", "day-4", None], height=12, reference=[0, 1, 2, 3, 4]),
    # The yard's small creatures and things (lib/village/life.dart): two frames each.
    "critters": Sheet(4, 2, [
        "critter-butterfly-1", "critter-butterfly-2", "critter-bird-1", "critter-bird-2",
        "critter-fish-1", "critter-fish-2", "critter-leaf-1", "critter-leaf-2",
    ], height=5, reference=[0], resize={"critter-bird-1": 0.8, "critter-bird-2": 0.8, "critter-fish-1": 0.85, "critter-fish-2": 0.85, "critter-leaf-1": 0.5, "critter-leaf-2": 0.5}),
    # DeepSeek Harness came after the eight above (gen.sh dsh): its machine at their scale, its logo beside the logos.
    "dsh": Sheet(2, 1, ["machine-dsh", "logo-dsh"], height=30, reference=[0]),
    "ui-machines": Sheet(4, 2, ["machine-tractor", "machine-watercart", "machine-wheelbarrow", "machine-pump", "machine-seeder", "machine-windmill", "machine-beehive", "machine-lantern"], height=30, reference=list(range(8))),
    # The map page (lib/desk/map/): its icon, the compass in its corner, a queued job's sack and a free spot's stake on an
    # island, a cloud drifting over, and a worktree's branch.
    "mapbits": Sheet(3, 2, ["icon-map", "map-compass", "map-sack", "map-stake", "map-cloud", "icon-branch"], height=24, reference=[0],
                     resize={"map-compass": 1.7, "map-sack": 0.55, "map-stake": 0.55, "map-cloud": 2.0, "icon-branch": 0.45}),
}
SPECIES = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"]
for species in SPECIES:
    for outfit in ["farmer", "gardener", "rain", "winter"]:
        raw = f"char-{species}" if outfit == "farmer" else f"char-{species}-{outfit}"
        SHEETS[raw] = Sheet(4, 3, [f"{species}-{outfit}-{n}" for n in CHAR_NAMES], height=28, reference=[0, 4, 8], head=True, tools=(CHAR_NAMES.index("work"),))
        # Six more poses for what helpers do at the buildings (gen.sh pose-*): the standing ones set the same scale.
        SHEETS[raw.replace("char-", "pose-", 1)] = Sheet(3, 2, [f"{species}-{outfit}-{n}" for n in POSE_NAMES], height=28, reference=[1, 4, 5], feet_middle=True)
# The manager's looks: the farmer is plain "manager", the others manager-<look>, each with -talk, -listen, -face.
for look in ["farmer", "foreman", "auntie", "grandpa", "gardener", "robot"]:
    base = "manager" if look == "farmer" else f"manager-{look}"
    SHEETS[f"look-{look}"] = Sheet(2, 2, [base, f"{base}-talk", f"{base}-listen", f"{base}-face"], height=32, reference=[0])
if DENSITY != 1:
    SHEETS = {k: replace(v, height=v.height * DENSITY, frame_width=v.frame_width * DENSITY if v.frame_width else None) for k, v in SHEETS.items()}

CURSOR_PARTS = ["glove", "glove-point", "glove-press", "glove-grab", "can", "spray", "weeder", "sickle", "trowel", "no", "sparkle", "hourglass"]
TOOL_CURSORS = {"water": "can", "bug": "spray", "weed": "weeder", "harvest": "sickle", "shovel": "trowel"}
# name: (base, badge, pressed)
CURSOR_RECIPES = {
    "hand": ("glove", None, False),
    "hand-point": ("glove-point", None, False),
    "hand-press": ("glove-press", None, False),
    "hand-grab": ("glove-grab", None, False),
    "hand-no": ("glove", "no", False),
    "wait": ("hourglass", None, False),
    **{k: v for tool, icon in TOOL_CURSORS.items() for k, v in {
        tool: (icon, None, False),
        f"{tool}-ok": (icon, "sparkle", False),
        f"{tool}-no": (icon, "no", False),
        f"{tool}-press": (icon, None, True),
    }.items()},
}
CURSORS_OUT = OUT.parent / "cursors"


def key(img: Image.Image, keep_purple: bool = False) -> np.ndarray:
    """
    RGBA with the magenta background (and its fringe) made transparent. `keep_purple`: magenta-ish pixels are background
    only where joined to the sheet's border (or nearly pure magenta), so a purple or pink picture keeps its colour.
    """
    a = np.asarray(img.convert("RGB")).astype(np.int32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # Magenta and the pinkish halo the painter leaves around shapes.
    bg = ndimage.binary_opening((r > 150) & (b > 150) & (g < 110) & (np.abs(r - b) < 90), iterations=1)
    if keep_purple:
        labels, _ = ndimage.label(bg)
        edges = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        bg = np.isin(labels, np.setdiff1d(np.unique(edges), [0]))
    bg = bg | ((r > 200) & (b > 200) & (g < 70))
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    return np.dstack([a.astype(np.uint8), alpha])


def shrink(rgba: np.ndarray, size: tuple[int, int], box: tuple[float, float, float, float] | None = None) -> np.ndarray:
    """Box-average to `size` (the part of `rgba` in `box`, fractional, when given), weighting colour by alpha, then make alpha hard."""
    a = rgba[..., 3:4].astype(np.float32) / 255
    pre = rgba[..., :3].astype(np.float32) * a
    big = np.dstack([pre, a[..., 0] * 255]).astype(np.float32)
    channels = [np.asarray(Image.fromarray(big[..., i]).resize(size, Image.Resampling.BOX, box=box)) for i in range(4)]
    small = np.dstack(channels)
    alpha = small[..., 3] / 255
    rgb = np.where(alpha[..., None] > 0, small[..., :3] / np.maximum(alpha[..., None], 1e-6), 0)
    out = np.dstack([np.clip(rgb, 0, 255), np.where(alpha >= 0.5, 255, 0)]).astype(np.uint8)
    return out


def quantize(rgba: np.ndarray, colours: int) -> np.ndarray:
    """Snaps opaque pixels to a palette of `colours`, no dithering."""
    rgb = Image.fromarray(rgba[..., :3])
    pal = rgb.quantize(colors=colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    return np.dstack([np.asarray(pal), rgba[..., 3]])


def bbox(alpha: np.ndarray) -> tuple[int, int, int, int] | None:
    """The largest blob and everything near it (a tool, a sweat drop), as x0, y0, x1, y1."""
    mask = alpha > 0
    grown = ndimage.binary_dilation(mask, iterations=12)
    labels, n = ndimage.label(grown)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, labels, range(1, n + 1))
    keep = labels == (int(np.argmax(sizes)) + 1)
    ys, xs = np.nonzero(mask & keep)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# A blob smaller than this many image pixels is a speck, not a piece of a logo.
SPECK = 400


def pieces_box(alpha: np.ndarray) -> tuple[int, int, int, int] | None:
    """Every piece in the cell but specks, as x0, y0, x1, y1."""
    mask = alpha > 0
    labels, n = ndimage.label(mask)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, labels, range(1, n + 1))
    keep = np.isin(labels, [k + 1 for k, size in enumerate(sizes) if size >= SPECK])
    ys, xs = np.nonzero(keep)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def logo_cells(rgba: np.ndarray, sheet: Sheet) -> list:
    """
    Each cell's logo: every blob whose middle falls in the cell, however far its edges reach, and however far apart
    its pieces are (a pair of braces); specks dropped. Each cell is the whole sheet with only its blobs left, boxed.
    """
    h, w = rgba.shape[:2]
    solid = rgba[..., 3] > 0
    labels, n = ndimage.label(solid)
    blobs = range(1, n + 1)
    sizes = ndimage.sum(solid, labels, blobs)
    middles = ndimage.center_of_mass(solid, labels, blobs)
    cells = []
    for i in range(sheet.cols * sheet.rows):
        c, r = i % sheet.cols, i // sheet.cols
        mine = [
            k
            for k, size, (cy, cx) in zip(blobs, sizes, middles)
            if size >= SPECK and min(sheet.cols - 1, int(cx / (w / sheet.cols))) == c and min(sheet.rows - 1, int(cy / (h / sheet.rows))) == r
        ]
        if not mine:
            cells.append((rgba, None))
            continue
        mask = np.isin(labels, mine)
        cell = rgba.copy()
        cell[..., 3][~mask] = 0
        ys, xs = np.nonzero(mask)
        cells.append((cell, (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)))
    return cells


def cells_of(name: str, sheet: Sheet, prefix: str | None = None) -> tuple[list, float]:
    rgba = key(Image.open(RAW / f"{RAW_PREFIX if prefix is None else prefix}{name}.png"), sheet.logos)
    h, w = rgba.shape[:2]
    cw, ch = w / sheet.cols, h / sheet.rows
    cells = logo_cells(rgba, sheet) if sheet.logos else []
    for i in range(0 if sheet.logos else sheet.cols * sheet.rows):
        c, r = i % sheet.cols, i // sheet.cols
        x0, y0 = int(c * cw), int(r * ch)
        cell = rgba[y0:int(y0 + ch), x0:int(x0 + cw)].copy()
        cell[..., 3][:6] = 0
        cell[..., 3][-6:] = 0
        cell[..., 3][:, :6] = 0
        cell[..., 3][:, -6:] = 0
        box = pieces_box(cell[..., 3]) if sheet.pieces else bbox(cell[..., 3])
        cells.append((cell, box))
    heights = [cells[i][1][3] - cells[i][1][1] for i in sheet.reference if cells[i][1]]
    return cells, sheet.height / float(np.median(heights))


def small_of(cell: np.ndarray, box: tuple[int, int, int, int], factor: float, colours: int) -> np.ndarray:
    x0, y0, x1, y1 = box
    size = (max(1, round((x1 - x0) * factor)), max(1, round((y1 - y0) * factor)))
    return quantize(shrink(cell[y0:y1, x0:x1], size), colours)


def frame_of(alpha: np.ndarray, box: tuple[int, int, int, int]) -> tuple[int, int, int]:
    """
    A framed picture's frame, in image pixels: its left and right edge and its bottom row. The bottom is the lowest row
    at least half the picture wide (the frame's base, which crops do not cover); the edges are the median of that row
    and the dozen above it, so a leaf hanging over one row does not move them.
    """
    x0, y0, x1, y1 = box
    solid = alpha[y0:y1, x0:x1] > 0
    wide = np.nonzero(solid.sum(axis=1) >= 0.5 * (x1 - x0))[0]
    bottom = int(wide[-1]) if len(wide) else y1 - y0 - 1
    rows = [r for r in solid[max(0, bottom - 12) : bottom + 1] if r.any()]
    left = int(np.median([np.nonzero(r)[0].min() for r in rows]))
    right = int(np.median([np.nonzero(r)[0].max() for r in rows]))
    return x0 + left, x0 + right, y0 + bottom


def framed(cell: np.ndarray, box: tuple[int, int, int, int], width: int, colours: int) -> tuple[np.ndarray, int, int]:
    """A framed picture with its frame exactly `width` wide on whole art pixels; and its anchor, the frame's bottom middle."""
    left, right, bottom = frame_of(cell[..., 3], box)
    x0, y0, x1, y1 = box
    k = width / (right + 1 - left)
    # Whole art pixels of the picture past the frame on each side, and above and below its base.
    over_l, over_r = math.ceil((left - x0) * k - 1e-6), math.ceil((x1 - right - 1) * k - 1e-6)
    above, below = math.ceil((bottom + 1 - y0) * k - 1e-6), math.ceil((y1 - bottom - 1) * k - 1e-6)
    # The crop may reach past the cell: pad it with nothing.
    pad = 32
    padded = np.pad(cell, ((pad, pad), (pad, pad), (0, 0)))
    crop = (pad + left - over_l / k, pad + bottom + 1 - above / k, pad + right + 1 + over_r / k, pad + bottom + 1 + below / k)
    small = quantize(shrink(padded, (over_l + width + over_r, above + below), crop), colours)
    return small, over_l + width // 2, above - 1


# The narrowest a row of feet is, art pixels; a tool's tip below them is narrower.
FEET_MIN = 7


def feet_middle(alpha: np.ndarray, ground: int) -> int:
    """The middle of a picture's feet: of the opaque pixels in the three rows it stands on."""
    xs = np.nonzero(alpha[max(0, ground - 2) : ground + 1] > 0)[1]
    return int(round((xs.min() + xs.max()) / 2)) if len(xs) else alpha.shape[1] // 2


def ground_row(alpha: np.ndarray, tool: bool) -> int:
    """The row a sprite stands on: its lowest row with anything in it, or with a tool in hand, the lowest as wide as feet."""
    rows = np.nonzero((alpha > 0).sum(axis=1) >= (FEET_MIN if tool else 1))[0]
    return int(rows[-1]) if len(rows) else alpha.shape[0] - 1


def sheet_path(name: str) -> str:
    """Where a raw sheet is, from the repository's root: the manifest records it for the asset browser (#/assets)."""
    return f"design/pixel/raw/{name}.png"


def cut(name: str, sheet: Sheet, manifest: dict) -> None:
    cells, factor = cells_of(name, sheet)
    for i, ((cell, box), sprite) in enumerate(zip(cells, sheet.names)):
        if sprite is None or box is None:
            continue
        if sheet.frame_width:
            small, ax, ay = framed(cell, box, sheet.frame_width, sheet.colours)
        else:
            small = small_of(cell, box, factor * (sheet.resize or {}).get(sprite, 1), sheet.colours)
            ay = ground_row(small[..., 3], i in sheet.tools)
            ax = feet_middle(small[..., 3], ay) if sheet.feet_middle else small.shape[1] // 2
        h, w = small.shape[:2]
        Image.fromarray(small, "RGBA").save(OUT / f"{sprite}.png")
        entry = {"w": w, "h": h, "ax": ax, "ay": ay, "sheet": sheet_path(name)}
        if sheet.head:
            # The head is the top of a chibi body: about the upper 45%.
            entry |= {"hx": w / 2, "hy": round(h * 0.3, 1)}
        manifest[sprite] = entry
    print(f"{name}: {len([n for n in sheet.names if n])} sprites, x{factor:.3f}")


# The map page's islands (gen.sh island-<rim>), one per project: each is shrunk until its yard is this many art pixels
# wide, room for three plots side by side with the helpers in them, so every island's plots are the village's size.
ISLAND_YARD = 150


def yard_of(rgba: np.ndarray) -> tuple[int, int, int, int]:
    """An island's yard, as x0, y0, x1, y1: the biggest stretch of bare soil, less the path out of its gate (the rows
    and columns the soil fills most of)."""
    soil = ndimage.binary_opening(dirt_of(rgba[..., :3]) & (rgba[..., 3] > 0), iterations=3)
    labels, n = ndimage.label(soil)
    sizes = ndimage.sum(soil, labels, range(1, n + 1))
    biggest = labels == int(np.argmax(sizes)) + 1
    rows, cols = biggest.sum(axis=1), biggest.sum(axis=0)
    ys, xs = np.nonzero(rows >= 0.6 * rows.max())[0], np.nonzero(cols >= 0.6 * cols.max())[0]
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def island(name: str, manifest: dict) -> None:
    """An island, with where its yard is (its `yard`, in the picture's pixels, edges exclusive) for the plots."""
    rgba = key(Image.open(RAW / f"{RAW_PREFIX}{name}.png"))
    box = bbox(rgba[..., 3])
    yx0, yy0, yx1, yy1 = yard_of(rgba)
    factor = ISLAND_YARD * DENSITY / (yx1 - yx0)
    small = small_of(rgba, box, factor, MAP_COLOURS)
    h, w = small.shape[:2]
    Image.fromarray(small, "RGBA").save(OUT / f"{name}.png")
    yard = [round((yx0 - box[0]) * factor), round((yy0 - box[1]) * factor), round((yx1 - box[0]) * factor), round((yy1 - box[1]) * factor)]
    manifest[name] = {"w": w, "h": h, "ax": w // 2, "ay": h - 1, "yard": yard, "sheet": sheet_path(name)}
    print(f"{name}: {w}x{h}, yard {yard}, x{factor:.3f}")


def make_cursors() -> None:
    """Pixel cursors: each part shrunk to 16 pixels, badges and presses composed at that size, written at 2x and 4x."""
    sheet = Sheet(4, 3, CURSOR_PARTS, height=16, reference=list(range(12)))
    # The pointer's own size, whatever the pictures' density: always from the plain sheet.
    cells, factor = cells_of("ui-cursors", sheet, prefix="")
    parts = {n: Image.fromarray(small_of(c, b, factor, 24), "RGBA") for (c, b), n in zip(cells, CURSOR_PARTS) if b}
    for n in ("no", "sparkle"):
        parts[n] = parts[n].resize((9, 9), Image.Resampling.NEAREST) if max(parts[n].size) > 9 else parts[n]
    CURSORS_OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (base, badge, pressed) in CURSOR_RECIPES.items():
        img = parts[base]
        canvas = Image.new("RGBA", (img.width + 6, img.height + 6))
        # Pressing nudges the tool one pixel down and right, like a key going down.
        canvas.alpha_composite(img, (1, 1) if pressed else (0, 0))
        if badge:
            b = parts[badge]
            canvas.alpha_composite(b, (canvas.width - b.width, canvas.height - b.height))
        canvas = canvas.crop(canvas.getbbox())
        alpha = np.asarray(canvas)[..., 3]
        ys, xs = np.nonzero(alpha > 0)
        i = int(np.argmin(xs + ys))
        for k, suffix in ((2, ""), (4, "@2x")):
            canvas.resize((canvas.width * k, canvas.height * k), Image.Resampling.NEAREST).save(CURSORS_OUT / f"{name}{suffix}.png")
        manifest[name] = {"hx": int(xs[i]) * 2, "hy": int(ys[i]) * 2}
    (CURSORS_OUT / "cursors.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"cursors: {len(manifest)}")


def backdrop(manifest: dict) -> None:
    img = Image.open(RAW / f"{RAW_PREFIX}map.png").convert("RGBA")
    small = shrink(np.asarray(img), MAP_SIZE)
    small[..., 3] = 255
    Image.fromarray(quantize(small, MAP_COLOURS), "RGBA").convert("RGB").save(OUT / "map.png")
    straighten_field(OUT / "map.png")
    manifest["map"] = {"w": MAP_SIZE[0], "h": MAP_SIZE[1], "ax": 0, "ay": 0, "sheet": sheet_path("map")}
    print("map: done")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    wanted = sys.argv[1:] or [p.stem for p in sorted(RAW.glob("*.png"))]
    for name in wanted:
        if not (RAW / f"{RAW_PREFIX if name != 'ui-cursors' else ''}{name}.png").exists():
            print(f"{name}: not generated yet")
        elif name == "map":
            backdrop(manifest)
        elif name == "ui-cursors":
            make_cursors()
        elif name.startswith("island-"):
            island(name, manifest)
        elif name in SHEETS:
            cut(name, SHEETS[name], manifest)
            if name == "plots":
                straighten_plots(OUT, [n for n in SHEETS[name].names if n])
    MANIFEST.write_text(json.dumps(dict(sorted(manifest.items())), indent=1) + "\n")


if __name__ == "__main__":
    main()
