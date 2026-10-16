#!/usr/bin/env python3
"""Lay the Hugeicons SVGs out as the reference sheets gen.sh redraws: raw/<sheet>-ref.png, 1536x1024, 4 x 2 cells.

Usage: python3 ref.py [media|glyphs|tools ...]   (default: every sheet)
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
# Each sheet's icons, in the order of process.py's sheet of the same name.
SHEETS = {
    "media": ["play", "pause", "stop", "speaker", "mute", "replay", "record", "wait"],
    "glyphs": ["close", "add", "delete", "next", "check", "cross", "warn", "copy"],
    "tools": ["refresh", "folder", "search", "edit", "open", "filter", "settings", "more"],
}
W, H, COLS, ROWS, SIZE = 1536, 1024, 4, 2, 300

for sheet_name in sys.argv[1:] or SHEETS:
    sheet = Image.new("RGB", (W, H), "white")
    with tempfile.TemporaryDirectory() as tmp:
        for i, name in enumerate(SHEETS[sheet_name]):
            png = Path(tmp) / f"{name}.png"
            # macOS's own renderer: ImageMagick's draws these strokes blank.
            subprocess.run(["sips", "-s", "format", "png", str(HERE / f"{name}.svg"), "--resampleHeightWidthMax", str(SIZE), "--out", str(png)], check=True, capture_output=True)
            icon = Image.open(png).convert("RGBA")
            cx, cy = (i % COLS) * W // COLS + W // COLS // 2, (i // COLS) * H // ROWS + H // ROWS // 2
            sheet.paste(icon, (cx - icon.width // 2, cy - icon.height // 2), icon)
    sheet.save(HERE.parent / "raw" / f"{sheet_name}-ref.png")
    print(f"raw/{sheet_name}-ref.png")
