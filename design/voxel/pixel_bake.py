"""Finish a scene bake at the farm's logical pixel density before nearest-neighbour display."""

from pathlib import Path
import sys

from PIL import Image, ImageChops, ImageFilter, ImageOps


def finish(path):
    with Image.open(path) as source:
        width, height = source.size
        rgba = source.convert("RGBA").resize(((width + 1) // 2, (height + 1) // 2), Image.Resampling.BOX)
    color = rgba.convert("RGB")
    alpha = rgba.getchannel("A").point(lambda a: 255 if a >= 128 else 0)

    # The dark side of a strong material boundary gets one ink pixel at the logical resolution.
    light = ImageOps.grayscale(color)
    contrast = ImageChops.subtract(light.filter(ImageFilter.MaxFilter(3)), light)
    contour = contrast.point(lambda v: min(195, max(0, (v - 19) * 3)))
    silhouette = ImageChops.subtract(alpha, alpha.filter(ImageFilter.MinFilter(3)))
    ink = ImageChops.lighter(contour, silhouette)
    shade = ImageChops.multiply(color, Image.new("RGB", color.size, (181, 185, 191)))
    color = Image.composite(shade, color, ink)
    # Reserve ink, lamp, roof and flower accents; median cut alone spends most colours on the meadow.
    accents = (
        "291f20",
        "43312a",
        "51635a",
        "43595f",
        "366578",
        "447786",
        "73aba9",
        "6796ac",
        "633e35",
        "975231",
        "b76531",
        "db7940",
        "ea8139",
        "faa84a",
        "ffce68",
        "ffe79a",
        "fbf2c8",
        "d8ceb4",
        "ee8b8b",
        "aa81b4",
        "86a955",
        "c2c376",
        "c5d5cf",
        "777e85",
    )
    count = 128 - len(accents)
    chosen = color.quantize(colors=count, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = chosen.getpalette()[: count * 3] + [int(h[i : i + 2], 16) for h in accents for i in (0, 2, 4)]
    swatches = Image.new("P", (1, 1))
    swatches.putpalette(palette + palette[-3:] * (256 - len(palette) // 3))
    indexed = color.quantize(palette=swatches, dither=Image.Dither.NONE).convert("RGBA")
    indexed = Image.composite(indexed, Image.new("RGBA", indexed.size), alpha)
    # Cropping preserves an exact two-device-pixel grid for odd-sized atlas entries.
    indexed.resize((indexed.width * 2, indexed.height * 2), Image.Resampling.NEAREST).crop((0, 0, width, height)).save(path, optimize=True)


if __name__ == "__main__":
    finish(Path(sys.argv[1]))
