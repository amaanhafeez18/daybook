"""Draws the iPhone launch images (apple-touch-startup-image) for the Home Screen app.

Keep in sync with index.html .boot-nav (the launch shell's tab-bar capsule) and its --b-* colours:
the launch image shows first, then the boot shell draws on top of it, so the capsule must sit
exactly where .boot-nav puts it or it jumps. tests/launch-images.test.mjs guards the CSS numbers.

One-off: run it again only if the capsule or the colours change, then commit the PNGs.
    python scripts/make_launch.py
Needs Pillow (pip install Pillow). Drawn 2x larger and scaled down (LANCZOS) for smooth edges.

Only the background and the capsule are drawn: the status bar's height isn't known here, so a
top bar would jump. The capsule is anchored to the bottom (34 pt home-indicator inset on every
Face ID iPhone), in points:
    width  w = min(460, W - 24)      x = (W - w) / 2
    height 60 (fully rounded)        y = H - 104   (34 inset + 10 gap + 60)

Outputs (public/launch/, not precached, not in the manifest):
    launch-{W*3}x{H*3}-light.png and -dark.png for each portrait size below (RGB, no alpha)
"""
import os

from PIL import Image, ImageDraw, ImageFilter

SS = 2  # supersampling
DPR = 3
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'launch')

# Face ID iPhones, portrait, in points (all @3x).
DEVICES = [
    (375, 812),  # X, XS, 11 Pro, 12/13 mini
    (390, 844),  # 12, 13, 14, 12/13 Pro
    (393, 852),  # 14 Pro, 15, 15 Pro, 16
    (402, 874),  # 16 Pro, 17, 17 Pro
    (420, 912),  # Air
    (428, 926),  # 12/13 Pro Max, 14 Plus
    (430, 932),  # 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
    (440, 956),  # 16 Pro Max, 17 Pro Max
]

# From index.html's --b-* tokens. Shadows: (x, y, blur, (r, g, b, a)) in CSS px.
SCHEMES = {
    'light': {
        'bg': (0xF2, 0xF2, 0xF7),
        'glass': (255, 255, 255, 0.82),
        'edge': (255, 255, 255, 0.7),
        'shadow': (0, 10, 34, (30, 36, 56, 0.12)),
    },
    'dark': {
        'bg': (0x00, 0x00, 0x00),
        'glass': (36, 36, 38, 0.82),
        'edge': (255, 255, 255, 0.14),
        'shadow': (0, 12, 40, (0, 0, 0, 0.5)),
    },
}


def capsule_pt(W, H):
    w = min(460, W - 24)
    x = (W - w) / 2
    return x, H - 104, x + w, H - 44


def rgba(c):
    return (c[0], c[1], c[2], round(c[3] * 255))


def draw(W, H, scheme):
    k = DPR * SS  # canvas pixels per point
    size = (W * k, H * k)
    x0, y0, x1, y1 = [round(v * k) for v in capsule_pt(W, H)]
    radius = (y1 - y0) // 2

    img = Image.new('RGBA', size, scheme['bg'] + (255,))

    # Shape mask of the capsule (white inside).
    shape = Image.new('L', size, 0)
    ImageDraw.Draw(shape).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=radius, fill=255)

    # Shadow: offset, Gaussian with sigma = blur / 2, only outside the border box (as CSS draws it).
    sx, sy, blur, colour = scheme['shadow']
    sigma = blur / 2 * k
    pad = int(sigma * 3) + abs(sy * k) + 4
    box = (max(0, x0 - pad), max(0, y0 - pad), min(size[0], x1 + pad), min(size[1], y1 + pad))
    local = shape.crop(box)
    moved = Image.new('L', local.size, 0)
    moved.paste(local, (round(sx * k), round(sy * k)))
    blurred = moved.filter(ImageFilter.GaussianBlur(sigma))
    alpha = blurred.point(lambda v: round(v * colour[3]))
    outside = Image.eval(local, lambda v: 255 - v)
    alpha = Image.composite(alpha, Image.new('L', local.size, 0), outside)
    shadow = Image.new('RGBA', local.size, colour[:3] + (0,))
    shadow.putalpha(alpha)
    region = img.crop(box)
    region = Image.alpha_composite(region, shadow)
    img.paste(region, box[:2])

    # Glass fill, then the 1 CSS px edge drawn inside it (box-sizing: border-box).
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=radius, fill=rgba(scheme['glass']))
    img = Image.alpha_composite(img, layer)
    edge = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=radius, outline=rgba(scheme['edge']), width=k)
    img = Image.alpha_composite(img, edge)

    return img.resize((W * DPR, H * DPR), Image.LANCZOS).convert('RGB')


def main():
    os.makedirs(OUT, exist_ok=True)
    for W, H in DEVICES:
        for name, scheme in SCHEMES.items():
            path = os.path.join(OUT, f'launch-{W * DPR}x{H * DPR}-{name}.png')
            draw(W, H, scheme).save(path, optimize=True)
            print(os.path.relpath(path), os.path.getsize(path) // 1024, 'KB')


if __name__ == '__main__':
    main()
