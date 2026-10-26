#!/usr/bin/env python3
"""Generate the Panther Companion app icon.

The mark is a signal at the centre of widening rings: one thing worth
noticing, and the context around it. Drawn at 4x and downsampled so the
1024px master stays clean at 32px in the Dock.

    python3 scripts/make-icon.py

Writes build/icon.png (electron-builder converts it to .icns).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersample factor
CANVAS = SIZE * SS
OUT = Path(__file__).resolve().parent.parent / "build" / "icon.png"

BACKDROP_TOP = (18, 26, 33)
BACKDROP_BOTTOM = (8, 12, 16)
SIGNAL = (233, 255, 251)
RINGS = [
    # (radius as a fraction of the tile, stroke width, colour, alpha)
    (0.150, 0.052, (52, 226, 209), 255),
    (0.255, 0.044, (86, 190, 232), 210),
    (0.360, 0.036, (124, 118, 246), 160),
    (0.455, 0.028, (150, 108, 240), 105),
]


def squircle_mask(size: int, radius_fraction: float = 0.225) -> Image.Image:
    """A macOS-like rounded square, drawn at supersample then reduced."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    inset = int(size * 0.045)
    radius = int(size * radius_fraction)
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset), radius=radius, fill=255
    )
    return mask


def vertical_gradient(size: int) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        gradient.putpixel(
            (0, y),
            tuple(round(a + (b - a) * t) for a, b in zip(BACKDROP_TOP, BACKDROP_BOTTOM)),
        )
    return gradient.resize((size, size), Image.BILINEAR)


def main() -> None:
    tile = vertical_gradient(CANVAS)
    art = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    # A soft light from the upper left keeps the flat backdrop from looking dead.
    glow = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(glow).ellipse(
        (-CANVAS * 0.35, -CANVAS * 0.45, CANVAS * 0.75, CANVAS * 0.65), fill=60
    )
    glow = glow.filter(ImageFilter.GaussianBlur(CANVAS * 0.10))
    art.paste(Image.new("RGB", (CANVAS, CANVAS), (46, 96, 120)), (0, 0), glow)
    art = Image.alpha_composite(tile.convert("RGBA"), art)

    centre = CANVAS / 2
    rings = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rings)
    for radius_fraction, width_fraction, colour, alpha in RINGS:
        radius = radius_fraction * CANVAS
        width = width_fraction * CANVAS
        draw.ellipse(
            (
                centre - radius - width / 2,
                centre - radius - width / 2,
                centre + radius + width / 2,
                centre + radius + width / 2,
            ),
            outline=colour + (alpha,),
            width=int(width),
        )
    # Bloom the rings slightly so they read as light, not paint.
    bloom = rings.filter(ImageFilter.GaussianBlur(CANVAS * 0.012))
    art = Image.alpha_composite(art, bloom)
    art = Image.alpha_composite(art, rings)

    dot = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    dot_draw = ImageDraw.Draw(dot)
    dot_radius = 0.062 * CANVAS
    dot_draw.ellipse(
        (centre - dot_radius, centre - dot_radius, centre + dot_radius, centre + dot_radius),
        fill=SIGNAL + (255,),
    )
    halo = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(halo).ellipse(
        (
            centre - dot_radius * 3,
            centre - dot_radius * 3,
            centre + dot_radius * 3,
            centre + dot_radius * 3,
        ),
        fill=110,
    )
    halo = halo.filter(ImageFilter.GaussianBlur(CANVAS * 0.02))
    art.paste(Image.new("RGB", (CANVAS, CANVAS), (120, 245, 235)), (0, 0), halo)
    art = Image.alpha_composite(art, dot)

    art.putalpha(squircle_mask(CANVAS))
    icon = art.resize((SIZE, SIZE), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUT)
    print(f"wrote {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
