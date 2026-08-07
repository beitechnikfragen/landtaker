"""
Build the rank badge set from four blank plates.

One plate per tier, chevrons composited on top by this script — so every
division of every tier is pixel-identical apart from the chevron count.
Generating each division separately produced twelve different shields, which
is why the chevrons are drawn here instead.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

SRC = sys.argv[1] if len(sys.argv) > 1 else "ranks/base2"
OUT = sys.argv[2] if len(sys.argv) > 2 else "ranks/final"

TIERS = ["bronze", "silver", "gold", "platinum"]

# Engraved chevrons: the shape is CUT INTO the plate, so the top edge falls in
# shadow and the bottom edge catches the light — the opposite of a raised inlay.
# The face itself stays close to the plate colour (a groove shows the same metal,
# just darker), which is what makes it read as engraving rather than a sticker.
# (shadow_top, groove_face, highlight_bottom)
CHEV = {
    "bronze":   ((38,  18,   6), (120,  68,  32), (255, 206, 150)),
    "silver":   ((28,  32,  38), (110, 122, 134), (246, 251, 255)),
    "gold":     ((46,  30,   4), (150, 108,  30), (255, 234, 165)),
    "platinum": ((26,  46,  50), (108, 152, 158), (232, 252, 255)),
}


def alpha_from_black(im):
    """Model renders on black; luminance doubles as alpha so the glow survives."""
    lum = im.convert("L")
    return lum.point(lambda v: 0 if v < 12 else min(255, int((v - 12) * 255 / 70)))


def chevron(draw, cx, cy, w, thick, colors, scale):
    """One engraved chevron.

    Drawn as three offset copies of the same V. Light comes from above, so a
    groove cut into the plate is dark along its upper lip and bright along its
    lower lip — drawing the shadow copy UP and the highlight copy DOWN is what
    sells the cut. Reverse those two and it immediately looks like a raised
    sticker sitting on the metal.
    """
    shadow, groove, highlight = colors
    half = w / 2
    rise = w * 0.42

    def poly(dy):
        return [
            (cx,          cy + dy - rise),
            (cx + half,   cy + dy),
            (cx + half,   cy + dy + thick),
            (cx,          cy + dy - rise + thick),
            (cx - half,   cy + dy + thick),
            (cx - half,   cy + dy),
        ]

    # An engraved chevron is mostly PLATE — the same metal, at the same
    # brightness — outlined by a dark cut line with a bright lip below it.
    # Filling the shape with a different colour is what made earlier passes
    # look like a sticker, so the interior is left transparent here and only
    # the edges are drawn.
    o = max(1.2, scale * 3.2)
    lw = max(2, int(scale * 5))

    draw.line(poly(o) + [poly(o)[0]],   fill=highlight, width=lw, joint="curve")
    draw.line(poly(-o) + [poly(-o)[0]], fill=shadow,    width=lw, joint="curve")
    draw.line(poly(0) + [poly(0)[0]],   fill=groove,    width=max(2, int(lw * 0.8)), joint="curve")


def build(tier, divisions, plate):
    im = plate.copy()
    w, h = im.size
    scale = w / 1024.0

    # Chevron block is centred on the plate face, which sits slightly above the
    # geometric centre because the shield tapers to a point at the bottom.
    face_cy = h * 0.50
    cw = w * 0.34            # chevron width
    thick = w * 0.052        # arm thickness
    gap = w * 0.088          # vertical pitch between chevrons

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    total = (divisions - 1) * gap
    start = face_cy - total / 2
    for i in range(divisions):
        chevron(d, w / 2, start + i * gap, cw, thick, CHEV[tier], scale)

    # Just enough softening to kill the aliasing — any more and the shadow/
    # highlight lips blur into each other and the engraving goes flat again.
    layer = layer.filter(ImageFilter.GaussianBlur(max(0.4, scale * 0.5)))

    # Clip to the plate so nothing spills past the rim.
    mask = im.split()[3]
    layer.putalpha(Image.composite(layer.split()[3], Image.new("L", (w, h), 0), mask))

    im.alpha_composite(layer)
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    for tier in TIERS:
        path = os.path.join(SRC, tier + ".png")
        if not os.path.exists(path):
            print("missing", path)
            continue

        raw = Image.open(path).convert("RGB")
        # These plates render flatter than the reference badge — push contrast and
        # saturation so the metal reads as polished rather than matte plastic.
        raw = ImageEnhance.Contrast(raw).enhance(1.22)
        raw = ImageEnhance.Color(raw).enhance(1.18)
        raw = ImageEnhance.Brightness(raw).enhance(1.06)

        rgba = raw.convert("RGBA")
        rgba.putalpha(alpha_from_black(raw))

        bbox = rgba.getbbox()
        rgba = rgba.crop(bbox)
        bw, bh = rgba.size
        side = max(bw, bh) + int(max(bw, bh) * 0.04)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(rgba, ((side - bw) // 2, (side - bh) // 2))
        sq = sq.resize((1024, 1024), Image.LANCZOS)

        for div in (1, 2, 3):
            badge = build(tier, div, sq)
            for size, suffix in ((512, ""), (128, "@small")):
                badge.resize((size, size), Image.LANCZOS).save(
                    f"{OUT}/{tier}{div}{suffix}.webp", "WEBP", quality=92, method=6
                )
        print(f"{tier}: 3 divisions written")


if __name__ == "__main__":
    main()
