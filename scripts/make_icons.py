"""Draws the app icons from the in-app logo (BrandMark in src/components/ui/Icon.jsx).

One-off: run it again only if the logo changes, then commit the PNGs in public/.
    python scripts/make_icons.py
Needs Pillow (pip install Pillow). Everything is drawn 4x larger and scaled down, for smooth edges.

The mark, on a 32-unit grid (keep in sync with BrandMark):
    rounded square  rx 9, #1F2B36
    crescent        M17.2 7.2 a9 9 0 1 0 7.6 13.9 A8 8 0 0 1 17.2 7.2 Z, #F4EFE6
    dot             circle (22.6, 9.4) r 1.9, #D9A441

Outputs (public/):
    apple-touch-icon.png  180, full bleed (iOS rounds the corners itself)
    icon-192.png          192, the rounded square as in the app
    icon-512.png          512, the same
    maskable-512.png      512, full bleed, the mark inside the 80% safe zone (Android adaptive icons)
    badge-96.png          96, white crescent and dot on transparent (Android status bar; iOS ignores it)
"""
import math
import os

from PIL import Image, ImageDraw

SS = 4  # supersampling
GRID = 32
BG = (0x1F, 0x2B, 0x36, 255)
MOON = (0xF4, 0xEF, 0xE6, 255)
GOLD = (0xD9, 0xA4, 0x41, 255)
RADIUS = 9
DOT = (22.6, 9.4, 1.9)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')


def arc_points(x1, y1, x2, y2, r, large, sweep, steps=180):
    """Points along an SVG elliptical arc with rx = ry = r and no rotation (SVG spec, F.6.5)."""
    hx, hy = (x1 - x2) / 2, (y1 - y2) / 2
    lam = (hx * hx + hy * hy) / (r * r)
    if lam > 1:
        r *= math.sqrt(lam)
    num = r * r * r * r - r * r * hy * hy - r * r * hx * hx
    den = r * r * hy * hy + r * r * hx * hx
    coef = math.sqrt(max(0.0, num / den))
    if large == sweep:
        coef = -coef
    cxp, cyp = coef * hy, -coef * hx
    cx, cy = cxp + (x1 + x2) / 2, cyp + (y1 + y2) / 2
    start = math.atan2((hy - cyp) / r, (hx - cxp) / r)
    end = math.atan2((-hy - cyp) / r, (-hx - cxp) / r)
    delta = end - start
    if sweep == 0 and delta > 0:
        delta -= 2 * math.pi
    elif sweep == 1 and delta < 0:
        delta += 2 * math.pi
    return [(cx + r * math.cos(start + delta * i / steps), cy + r * math.sin(start + delta * i / steps)) for i in range(steps + 1)]


def crescent():
    outer = arc_points(17.2, 7.2, 24.8, 21.1, 9, 1, 0)
    inner = arc_points(24.8, 21.1, 17.2, 7.2, 8, 0, 1)
    return outer + inner[1:]


def draw_mark(draw, size, scale=1.0, moon=MOON, gold=GOLD):
    """The crescent and the dot, scaled about the grid's centre by `scale`."""
    unit = size / GRID

    def at(x, y):
        return ((16 + (x - 16) * scale) * unit, (16 + (y - 16) * scale) * unit)

    draw.polygon([at(x, y) for x, y in crescent()], fill=moon)
    cx, cy = at(DOT[0], DOT[1])
    r = DOT[2] * scale * unit
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=gold)


def render(size, kind):
    big = size * SS
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if kind == 'rounded':
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=RADIUS / GRID * big, fill=BG)
        draw_mark(draw, big)
    elif kind == 'bleed':
        draw.rectangle([0, 0, big, big], fill=BG)
        draw_mark(draw, big)
    elif kind == 'maskable':
        draw.rectangle([0, 0, big, big], fill=BG)
        draw_mark(draw, big, scale=safe_scale())
    elif kind == 'badge':
        white = (255, 255, 255, 255)
        draw_mark(draw, big, scale=badge_scale(), moon=white, gold=white)
    return image.resize((size, size), Image.LANCZOS)


def mark_points():
    x, y, r = DOT
    dot = [(x + r * math.cos(a / 36 * 2 * math.pi), y + r * math.sin(a / 36 * 2 * math.pi)) for a in range(36)]
    return crescent() + dot


def safe_scale():
    """Largest scale (at most 1) that keeps the mark inside the maskable safe circle (40% of the size), with a margin."""
    reach = max(math.hypot(x - 16, y - 16) for x, y in mark_points())
    return min(1.0, GRID * 0.4 * 0.94 / reach)


def badge_scale():
    """The badge is only the mark: let it fill most of the square."""
    reach = max(max(abs(x - 16), abs(y - 16)) for x, y in mark_points())
    return GRID / 2 * 0.88 / reach


def main():
    outputs = [
        ('apple-touch-icon.png', 180, 'bleed'),
        ('icon-192.png', 192, 'rounded'),
        ('icon-512.png', 512, 'rounded'),
        ('maskable-512.png', 512, 'maskable'),
        ('badge-96.png', 96, 'badge'),
    ]
    for name, size, kind in outputs:
        path = os.path.normpath(os.path.join(OUT, name))
        render(size, kind).save(path, optimize=True)
        print(f'{name}: {size}x{size} ({kind})')


if __name__ == '__main__':
    main()
