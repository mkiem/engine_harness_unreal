"""Draws the Engine Harness icon set and installer bitmaps: an indigo rounded square, a hexagon nut for the engine,
and an orange play triangle for playtesting. Original artwork; regenerate with:

    python3 distro/branding/make_icons.py <output dir>

Writes icon.png (1024), icon@2x.png (2048), icon-512.png, icon.ico, icon.icns, tray templates, icon.svg/glyph.svg,
and the NSIS sidebar (164x314) and header (150x57) bitmaps, at the file names the goose desktop app uses.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

INDIGO_TOP = (43, 36, 92)
INDIGO_BOTTOM = (22, 18, 48)
ORANGE = (255, 138, 51)
WHITE = (245, 244, 255)


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(math.radians(60 * i - 90)), cy + r * math.sin(math.radians(60 * i - 90))) for i in range(6)]


def play(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    # An equilateral triangle pointing right, nudged so its visual centre sits on (cx, cy).
    return [(cx - r * 0.5 + r * 0.12, cy - r * 0.866), (cx + r + r * 0.12, cy), (cx - r * 0.5 + r * 0.12, cy + r * 0.866)]


def app_icon(size: int) -> Image.Image:
    scale = 4  # draw large, then downsample for clean edges
    s = size * scale
    gradient = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / (s - 1)
        gradient.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(INDIGO_TOP, INDIGO_BOTTOM)))
    background = gradient.resize((s, s))
    mask = Image.new("L", (s, s), 0)
    margin = s * 0.06
    ImageDraw.Draw(mask).rounded_rectangle([margin, margin, s - margin, s - margin], radius=s * 0.22, fill=255)
    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(background, (0, 0), mask)
    draw = ImageDraw.Draw(icon)
    c = s / 2
    draw.polygon(hexagon(c, c, s * 0.30), outline=WHITE, width=round(s * 0.045))
    draw.polygon(play(c, c, s * 0.13), fill=ORANGE)
    return icon.resize((size, size), Image.LANCZOS)


def tray(size: int, dot: bool = False) -> Image.Image:
    """macOS menu-bar template: black on transparent; the update variant adds a dot."""
    scale = 8
    s = size * scale
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    c = s / 2
    draw.polygon(hexagon(c, c, s * 0.42), outline=(0, 0, 0, 255), width=round(s * 0.09))
    draw.polygon(play(c, c, s * 0.18), fill=(0, 0, 0, 255))
    if dot:
        draw.ellipse([s * 0.70, s * 0.02, s * 0.98, s * 0.30], fill=(0, 0, 0, 255))
    return image.resize((size, size), Image.LANCZOS)


def font(px: int) -> ImageFont.ImageFont:
    for name in ["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"]:
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def sidebar() -> Image.Image:
    image = Image.new("RGB", (164, 314), INDIGO_BOTTOM)
    draw = ImageDraw.Draw(image)
    for y in range(314):
        t = y / 313
        draw.line([(0, y), (163, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(INDIGO_TOP, INDIGO_BOTTOM)))
    logo = app_icon(96)
    image.paste(logo, (34, 70), logo)
    draw.text((82, 196), "Engine", font=font(20), fill=WHITE, anchor="mm")
    draw.text((82, 222), "Harness", font=font(20), fill=WHITE, anchor="mm")
    return image


def header() -> Image.Image:
    image = Image.new("RGB", (150, 57), (255, 255, 255))
    logo = app_icon(41)
    image.paste(logo, (6, 8), logo)
    ImageDraw.Draw(image).text((52, 28), "Engine\nHarness", font=font(13), fill=INDIGO_BOTTOM, anchor="lm", spacing=1)
    return image


SVG = """<svg width="600" height="600" viewBox="0 0 600 600" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="{hexagon}" stroke="currentColor" stroke-width="30" stroke-linejoin="round"/>
  <path d="{play}" fill="currentColor"/>
</svg>
"""


def svg() -> str:
    path = lambda points: "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in points) + " Z"  # noqa: E731
    return SVG.format(hexagon=path(hexagon(300, 300, 250)), play=path(play(300, 300, 105)))


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
    images = out / "src" / "images"
    images.mkdir(parents=True, exist_ok=True)
    big = app_icon(1024)
    big.save(images / "icon.png")
    app_icon(2048).save(images / "icon@2x.png")
    app_icon(512).save(images / "icon-512.png")
    big.save(images / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(images / "icon.icns")
    tray(22).save(images / "iconTemplate.png")
    tray(44).save(images / "iconTemplate@2x.png")
    tray(22, dot=True).save(images / "iconTemplateUpdate.png")
    tray(44, dot=True).save(images / "iconTemplateUpdate@2x.png")
    (images / "icon.svg").write_text(svg())
    (images / "glyph.svg").write_text(svg())
    sidebar().save(out / "electron-builder.nsis.sidebar.bmp")
    header().save(out / "electron-builder.nsis.header.bmp")
    print(f"wrote the icon set to {out}")


if __name__ == "__main__":
    main()
