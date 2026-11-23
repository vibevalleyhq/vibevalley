#!/usr/bin/env python3
"""Generate macOS 26 full-bleed channel icons, fallback .icns, and Retina DMG background.

Outputs under apps/mac/resources/:
  - appicon-{release,alpha,beta,dev}.png  (1024x1024 full-bleed PNG for actool Assets.car)
  - icon{,-alpha,-beta,-dev}.icns         (macOS 14/15 squircle fallback compiled via iconutil)
  - dmg-background.png                    (1360x880 @144 DPI = 680x440 pt Retina DMG canvas)

Deterministic: given the same design/pixel/raw/{app-icon,dmg-background}.png inputs,
produces identical outputs.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "design" / "pixel" / "raw"
OUT_DIR = ROOT / "apps" / "mac" / "resources"

ICON_SIZE = 1024
FALLBACK_SQUIRCLE_SIZE = 824
FALLBACK_SQUIRCLE_OFFSET = (ICON_SIZE - FALLBACK_SQUIRCLE_SIZE) // 2  # 100px

DMG_W = 1360
DMG_H = 880
DMG_DPI = 144

ICONSET_SIZES: tuple[tuple[str, int], ...] = (
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
)


@dataclass(frozen=True)
class ChannelBadge:
    channel: str
    icns_name: str
    label: str | None
    fill_top: tuple[int, int, int]
    fill_bottom: tuple[int, int, int]
    border: tuple[int, int, int]
    highlight: tuple[int, int, int, int]
    text_color: tuple[int, int, int]
    width: int


CHANNELS: tuple[ChannelBadge, ...] = (
    ChannelBadge(
        channel="release",
        icns_name="icon.icns",
        label=None,
        fill_top=(0, 0, 0),
        fill_bottom=(0, 0, 0),
        border=(0, 0, 0),
        highlight=(0, 0, 0, 0),
        text_color=(0, 0, 0),
        width=0,
    ),
    ChannelBadge(
        channel="alpha",
        icns_name="icon-alpha.icns",
        label="ALPHA",
        fill_top=(242, 166, 48),
        fill_bottom=(216, 132, 24),
        border=(45, 30, 18),
        highlight=(255, 244, 212, 130),
        text_color=(45, 30, 18),
        width=326,
    ),
    ChannelBadge(
        channel="beta",
        icns_name="icon-beta.icns",
        label="BETA",
        fill_top=(74, 138, 201),
        fill_bottom=(46, 102, 162),
        border=(22, 43, 69),
        highlight=(214, 236, 255, 115),
        text_color=(255, 255, 255),
        width=284,
    ),
    ChannelBadge(
        channel="dev",
        icns_name="icon-dev.icns",
        label="DEV",
        fill_top=(73, 95, 73),
        fill_bottom=(47, 63, 47),
        border=(24, 34, 24),
        highlight=(208, 232, 208, 95),
        text_color=(247, 243, 232),
        width=248,
    ),
)


def load_badge_font(size_px: int) -> ImageFont.FreeTypeFont:
    candidates: tuple[tuple[str, str | None], ...] = (
        ("/System/Library/Fonts/SFNSRounded.ttf", "Heavy"),
        ("/System/Library/Fonts/SFCompactRounded.ttf", "Heavy"),
        ("/System/Library/Fonts/SFNS.ttf", "Bold"),
        ("/System/Library/Fonts/Helvetica.ttc", None),
    )
    for path, variation in candidates:
        if not Path(path).exists():
            continue
        font = ImageFont.truetype(path, size_px)
        if variation is not None:
            try:
                font.set_variation_by_name(variation)
            except (OSError, ValueError):
                pass
        return font
    raise RuntimeError("No suitable bold system font found for channel badges")


def draw_tracked_text(
    draw: ImageDraw.ImageDraw,
    center_x: float,
    center_y: float,
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    tracking: float,
) -> None:
    glyph_boxes = [font.getbbox(ch) for ch in text]
    advances = [font.getlength(ch) for ch in text]
    total_w = sum(advances) + tracking * max(0, len(text) - 1)
    # Optical vertical centering based on the full string's ink bounding box.
    full_box = font.getbbox(text)
    ink_h = full_box[3] - full_box[1]
    top_y = center_y - ink_h / 2.0 - full_box[1]
    cursor_x = center_x - total_w / 2.0
    for ch, adv, _box in zip(text, advances, glyph_boxes):
        draw.text((cursor_x, top_y), ch, font=font, fill=fill)
        cursor_x += adv + tracking


def apply_channel_badge(base_icon: Image.Image, spec: ChannelBadge) -> Image.Image:
    if spec.label is None:
        return base_icon.copy()

    # Supersample the badge at 2x for crisp curves, gradient, border, and type.
    ss = 2
    canvas = Image.new("RGBA", (ICON_SIZE * ss, ICON_SIZE * ss), (0, 0, 0, 0))

    # Positioned neatly inside the lower-right macOS squircle safe area while keeping
    # the farmer's face, hands, and green two-leaf sprout completely unobstructed.
    pill_h = 122
    pill_w = spec.width
    x2 = 946
    y2 = 922
    x1 = x2 - pill_w
    y1 = y2 - pill_h

    sx1, sy1, sx2, sy2 = x1 * ss, y1 * ss, x2 * ss, y2 * ss
    radius = (pill_h * ss) // 2
    border_w = 5 * ss

    # Soft drop shadow under the pill.
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (sx1, sy1 + 8 * ss, sx2, sy2 + 8 * ss),
        radius=radius,
        fill=(24, 16, 10, 105),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=12 * ss))
    canvas = Image.alpha_composite(canvas, shadow)

    # Vertical gradient fill inside the pill.
    grad = Image.new("RGBA", (sx2 - sx1, sy2 - sy1), (0, 0, 0, 0))
    grad_draw = ImageDraw.Draw(grad)
    gh = sy2 - sy1
    for row in range(gh):
        t = row / max(1, gh - 1)
        r = round(spec.fill_top[0] * (1.0 - t) + spec.fill_bottom[0] * t)
        g = round(spec.fill_top[1] * (1.0 - t) + spec.fill_bottom[1] * t)
        b = round(spec.fill_top[2] * (1.0 - t) + spec.fill_bottom[2] * t)
        grad_draw.line([(0, row), (sx2 - sx1, row)], fill=(r, g, b, 255))

    pill_mask = Image.new("L", (sx2 - sx1, sy2 - sy1), 0)
    ImageDraw.Draw(pill_mask).rounded_rectangle(
        (0, 0, sx2 - sx1 - 1, sy2 - sy1 - 1),
        radius=radius,
        fill=255,
    )
    pill_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    pill_layer.paste(grad, (sx1, sy1), pill_mask)

    # Subtle top inner highlight arc for tactile polish.
    hi_layer = Image.new("RGBA", (sx2 - sx1, sy2 - sy1), (0, 0, 0, 0))
    hi_draw = ImageDraw.Draw(hi_layer)
    inset = border_w + 2 * ss
    hi_draw.rounded_rectangle(
        (inset, inset, sx2 - sx1 - 1 - inset, sy2 - sy1 - 1 - inset),
        radius=max(1, radius - inset),
        outline=spec.highlight,
        width=2 * ss,
    )
    # Fade highlight out toward the lower half so only the upper rim catches light.
    hi_alpha = hi_layer.getchannel("A")
    fade = Image.new("L", hi_alpha.size, 0)
    fade_draw = ImageDraw.Draw(fade)
    for row in range(gh):
        v = max(0, min(255, round(255 * (1.0 - (row / max(1, gh * 0.55))))))
        fade_draw.line([(0, row), (sx2 - sx1, row)], fill=v)
    hi_layer.putalpha(ImageChops.multiply(hi_alpha, fade))
    pill_layer.alpha_composite(hi_layer, (sx1, sy1))

    # Crisp dark outline harmonizing with the pixel-art line weight.
    pill_draw = ImageDraw.Draw(pill_layer)
    pill_draw.rounded_rectangle(
        (sx1, sy1, sx2 - 1, sy2 - 1),
        radius=radius,
        outline=(*spec.border, 255),
        width=border_w,
    )

    # Crisp bold label centered optically inside the pill.
    font = load_badge_font(65 * ss)
    draw_tracked_text(
        pill_draw,
        center_x=(sx1 + sx2) / 2.0,
        center_y=(sy1 + sy2) / 2.0 - 1 * ss,
        text=spec.label,
        font=font,
        fill=(*spec.text_color, 255),
        tracking=2.5 * ss,
    )

    canvas = Image.alpha_composite(canvas, pill_layer)
    badge_1x = canvas.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
    return Image.alpha_composite(base_icon.convert("RGBA"), badge_1x)


def make_squircle_mask(size: int, supersample: int = 2, exponent: float = 5.0) -> Image.Image:
    """Create a smooth Apple-style continuous superellipse alpha mask."""
    n = size * supersample
    half = (n - 1) / 2.0
    # Vector-free fast quadrant computation using symmetry.
    half_len = (n + 1) // 2
    mask = Image.new("L", (n, n), 0)
    px = mask.load()
    assert px is not None
    inv_half = 1.0 / half
    # Precompute |x/half|^exponent for one half-axis.
    pows = [abs((i - half) * inv_half) ** exponent for i in range(half_len)]
    # Soft 1px feather at the superellipse boundary for silky anti-aliasing.
    for y in range(half_len):
        py_val = pows[y]
        y_mir = n - 1 - y
        for x in range(half_len):
            d = py_val + pows[x]
            if d <= 0.992:
                val = 255
            elif d >= 1.008:
                val = 0
            else:
                val = round(255 * (1.008 - d) / 0.016)
            if val:
                x_mir = n - 1 - x
                px[x, y] = val
                px[x_mir, y] = val
                px[x, y_mir] = val
                px[x_mir, y_mir] = val
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def render_fallback_squircle(full_bleed: Image.Image, squircle_mask: Image.Image) -> Image.Image:
    """Place full-bleed artwork inside an 824x824 Apple squircle with subtle Dock shadow."""
    inner = full_bleed.convert("RGBA").resize(
        (FALLBACK_SQUIRCLE_SIZE, FALLBACK_SQUIRCLE_SIZE),
        Image.Resampling.LANCZOS,
    )
    masked = Image.new("RGBA", (FALLBACK_SQUIRCLE_SIZE, FALLBACK_SQUIRCLE_SIZE), (0, 0, 0, 0))
    masked.paste(inner, (0, 0), squircle_mask)

    # Subtle macOS 14/15 Dock drop shadow.
    shadow = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    shadow_alpha = squircle_mask.point(lambda p: round(p * 0.28))
    shadow_fill = Image.new("RGBA", (FALLBACK_SQUIRCLE_SIZE, FALLBACK_SQUIRCLE_SIZE), (18, 12, 6, 255))
    shadow_fill.putalpha(shadow_alpha)
    shadow.paste(shadow_fill, (FALLBACK_SQUIRCLE_OFFSET, FALLBACK_SQUIRCLE_OFFSET + 12), shadow_alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=22))

    out = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    out = Image.alpha_composite(out, shadow)
    out.paste(masked, (FALLBACK_SQUIRCLE_OFFSET, FALLBACK_SQUIRCLE_OFFSET), masked)
    return out


def build_icns(image_1024: Image.Image, dest: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="vv-iconset-") as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for filename, dim in ICONSET_SIZES:
            resized = image_1024.resize((dim, dim), Image.Resampling.LANCZOS)
            resized.save(iconset / filename, format="PNG")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(dest)],
            check=True,
        )


def build_dmg_background(raw_bg_path: Path, dest: Path) -> None:
    """Compose a 1360x880 @144 DPI (680x440 pt) Retina pastoral DMG installer background."""
    raw = Image.open(raw_bg_path).convert("RGBA")
    # Scale raw width (1536) cleanly to 1360 -> height becomes 907px.
    scaled_w = DMG_W
    scaled_h = round(raw.height * (DMG_W / raw.width))
    scaled = raw.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)

    # Shift the landscape down so the calm warm-cream morning sky fills the upper ~66%
    # and the soft rolling hills + sunlit meadow anchor the bottom ~34%, keeping the
    # drop zones and icon labels uncluttered while keeping the sun cleanly above the left card.
    shift_down = 88
    top_sky = scaled.crop((0, 0, DMG_W, 1)).resize((DMG_W, DMG_H), Image.Resampling.BILINEAR)
    canvas = top_sky.copy()

    # Feather the top 48px of the shifted raw artwork into the opaque sky base so the transition is invisible.
    cropped_land = scaled.crop((0, 0, DMG_W, DMG_H - shift_down))
    seam_mask = Image.new("L", cropped_land.size, 255)
    seam_draw = ImageDraw.Draw(seam_mask)
    feather = 48
    for y in range(feather):
        v = round(255 * (y / feather))
        seam_draw.line([(0, y), (DMG_W, y)], fill=v)
    canvas.paste(cropped_land, (0, shift_down), seam_mask)

    # Very subtle sunlit atmospheric veil across the upper sky to keep drop zones crisp.
    veil = Image.new("RGBA", (DMG_W, DMG_H), (0, 0, 0, 0))
    veil_draw = ImageDraw.Draw(veil)
    for y in range(DMG_H):
        if y < 520:
            alpha = round(24 * (1.0 - y / 520.0) ** 1.3)
            veil_draw.line([(0, y), (DMG_W, y)], fill=(255, 251, 240, alpha))
    canvas = Image.alpha_composite(canvas, veil)

    # Render drop zones and directional arrow at 2x supersampling for razor-sharp Retina detail.
    ss = 2
    overlay = Image.new("RGBA", (DMG_W * ss, DMG_H * ss), (0, 0, 0, 0))

    zone_size = 340
    zone_radius = 44
    zone_centers = ((360, 420), (1000, 420))

    for cx, cy in zone_centers:
        x1 = (cx - zone_size // 2) * ss
        y1 = (cy - zone_size // 2) * ss
        x2 = (cx + zone_size // 2) * ss
        y2 = (cy + zone_size // 2) * ss
        r = zone_radius * ss

        # Very delicate ambient lift shadow behind the parchment card.
        card_shadow = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
        ImageDraw.Draw(card_shadow).rounded_rectangle(
            (x1, y1 + 6 * ss, x2, y2 + 6 * ss),
            radius=r,
            fill=(96, 74, 48, 26),
        )
        card_shadow = card_shadow.filter(ImageFilter.GaussianBlur(radius=14 * ss))
        overlay = Image.alpha_composite(overlay, card_shadow)

        # Frosted warm parchment fill: rgba(255, 250, 238, 0.58)
        card = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle(
            (x1, y1, x2, y2),
            radius=r,
            fill=(255, 250, 238, 148),
        )

        # Soft warm inner glow inset 3px inside the card perimeter.
        glow_inset = 3 * ss
        cd.rounded_rectangle(
            (x1 + glow_inset, y1 + glow_inset, x2 - glow_inset, y2 - glow_inset),
            radius=max(1, r - glow_inset),
            outline=(255, 253, 247, 130),
            width=3 * ss,
        )

        # Delicate hairline border: rgba(122, 102, 74, 0.28)
        cd.rounded_rectangle(
            (x1, y1, x2, y2),
            radius=r,
            outline=(122, 102, 74, 72),
            width=2 * ss,
        )
        overlay = Image.alpha_composite(overlay, card)

    # Center directional arrow pill at exact (680, 420) = logical (340, 210).
    acx, acy = 680 * ss, 420 * ss
    pill_w, pill_h = 116 * ss, 76 * ss
    px1, py1 = acx - pill_w // 2, acy - pill_h // 2
    px2, py2 = acx + pill_w // 2, acy + pill_h // 2
    pr = pill_h // 2

    arrow_shadow = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    ImageDraw.Draw(arrow_shadow).rounded_rectangle(
        (px1, py1 + 5 * ss, px2, py2 + 5 * ss),
        radius=pr,
        fill=(96, 74, 48, 36),
    )
    arrow_shadow = arrow_shadow.filter(ImageFilter.GaussianBlur(radius=10 * ss))
    overlay = Image.alpha_composite(overlay, arrow_shadow)

    arrow_layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    ad = ImageDraw.Draw(arrow_layer)
    ad.rounded_rectangle(
        (px1, py1, px2, py2),
        radius=pr,
        fill=(255, 250, 238, 206),
        outline=(122, 102, 74, 88),
        width=2 * ss,
    )
    # Soft inner rim highlight on the arrow pill.
    ad.rounded_rectangle(
        (px1 + 3 * ss, py1 + 3 * ss, px2 - 3 * ss, py2 - 3 * ss),
        radius=max(1, pr - 3 * ss),
        outline=(255, 254, 249, 140),
        width=2 * ss,
    )

    # Clean, balanced right-pointing arrow geometry in warm oak (#6B4E31).
    ink = (107, 78, 49, 235)
    stroke = 7 * ss
    half_stroke = stroke / 2.0

    shaft_x1 = acx - 24 * ss
    shaft_x2 = acx + 20 * ss
    tip_x = acx + 24 * ss
    wing_x = acx + 6 * ss
    wing_dy = 16 * ss

    def draw_capsule(p0: tuple[float, float], p1: tuple[float, float]) -> None:
        ad.line([p0, p1], fill=ink, width=stroke)
        for px, py in (p0, p1):
            ad.ellipse(
                (px - half_stroke, py - half_stroke, px + half_stroke, py + half_stroke),
                fill=ink,
            )

    draw_capsule((shaft_x1, acy), (shaft_x2, acy))
    draw_capsule((wing_x, acy - wing_dy), (tip_x, acy))
    draw_capsule((wing_x, acy + wing_dy), (tip_x, acy))

    overlay = Image.alpha_composite(overlay, arrow_layer)
    overlay_1x = overlay.resize((DMG_W, DMG_H), Image.Resampling.LANCZOS)
    final = Image.alpha_composite(canvas, overlay_1x).convert("RGB")
    final.save(dest, format="PNG", dpi=(DMG_DPI, DMG_DPI), optimize=True)


def main() -> int:
    raw_icon = RAW_DIR / "app-icon.png"
    raw_bg = RAW_DIR / "dmg-background.png"
    for required in (raw_icon, raw_bg):
        if not required.exists():
            print(f"Missing raw asset: {required}. Run ./design/art.sh first.", file=sys.stderr)
            return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    base_icon = Image.open(raw_icon).convert("RGBA").resize(
        (ICON_SIZE, ICON_SIZE),
        Image.Resampling.LANCZOS,
    )
    squircle_mask = make_squircle_mask(FALLBACK_SQUIRCLE_SIZE)

    for spec in CHANNELS:
        full_bleed = apply_channel_badge(base_icon, spec).convert("RGB")
        png_path = OUT_DIR / f"appicon-{spec.channel}.png"
        full_bleed.save(png_path, format="PNG", optimize=True)

        fallback_1024 = render_fallback_squircle(full_bleed, squircle_mask)
        icns_path = OUT_DIR / spec.icns_name
        build_icns(fallback_1024, icns_path)
        print(f"Generated {png_path.relative_to(ROOT)} and {icns_path.relative_to(ROOT)}")

    dmg_dest = OUT_DIR / "dmg-background.png"
    build_dmg_background(raw_bg, dmg_dest)
    print(f"Generated {dmg_dest.relative_to(ROOT)} ({DMG_W}x{DMG_H} @{DMG_DPI} DPI)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
