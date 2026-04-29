#!/usr/bin/env python3
# Generates placeholder pixel-art PNGs for the game.
#   python3 scripts/gen-placeholders.py            # only fills missing files
#   python3 scripts/gen-placeholders.py --force    # overwrite everything
# Default is non-destructive so your real Aseprite art is never clobbered.
import math, os, struct, sys, zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'public')
FORCE = '--force' in sys.argv

def write_png(path, w, h, px):
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = px[y * w + x]
            raw += bytes((r, g, b, a))
    data = (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)
    print(f'wrote {path} ({w}x{h})')

# --- drawing primitives on a flat RGBA buffer --------------------------------
def make(w, h):
    return [(0, 0, 0, 0)] * (w * h)

def setpx(buf, w, h, x, y, c):
    if 0 <= x < w and 0 <= y < h:
        buf[y * w + x] = c

def rect(buf, w, h, x0, y0, x1, y1, c):
    for y in range(max(0, y0), min(h, y1 + 1)):
        for x in range(max(0, x0), min(w, x1 + 1)):
            buf[y * w + x] = c

def disk(buf, w, h, cx, cy, r, c):
    for y in range(max(0, cy - r), min(h, cy + r + 1)):
        for x in range(max(0, cx - r), min(w, cx + r + 1)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                buf[y * w + x] = c

def ring(buf, w, h, cx, cy, r_out, r_in, c):
    for y in range(max(0, cy - r_out), min(h, cy + r_out + 1)):
        for x in range(max(0, cx - r_out), min(w, cx + r_out + 1)):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if r_in * r_in <= d2 <= r_out * r_out:
                buf[y * w + x] = c

def line(buf, w, h, x0, y0, x1, y1, c):
    # Bresenham, thickened to 2px for chunky pixel-art lines.
    dx = abs(x1 - x0); dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1; sy = 1 if y0 < y1 else -1
    err = dx + dy
    x, y = x0, y0
    while True:
        for ox in (0, 1):
            for oy in (0, 1):
                setpx(buf, w, h, x + ox, y + oy, c)
        if x == x1 and y == y1: break
        e2 = 2 * err
        if e2 >= dy: err += dy; x += sx
        if e2 <= dx: err += dx; y += sy

# --- biker strip: 4 frames × 64×48 = 256×48 ---------------------------------
# Wheels baked into each frame; spokes step through 90° / 4 frames = 22.5°
# per frame. A 4-spoke wheel has 4-fold rotational symmetry, so 90° of unique
# motion covers a full visual cycle.
FRAME_W, FRAME_H = 64, 48
N_FRAMES = 4
REAR_AXLE  = (13, 37)
FRONT_AXLE = (51, 37)
WHEEL_R    = 7

def _draw_body(buf, sw, sh, ox):
    FRAME  = (255, 107, 107, 255)
    SADDLE = (45, 27, 61, 255)
    BODY   = (255, 210, 63, 255)
    HEAD   = (255, 230, 150, 255)
    HELMET = (244, 162, 89, 255)
    line(buf, sw, sh, ox + 13, 37, ox + 32, 26, FRAME)
    line(buf, sw, sh, ox + 32, 26, ox + 51, 37, FRAME)
    line(buf, sw, sh, ox + 13, 37, ox + 51, 37, FRAME)
    line(buf, sw, sh, ox + 32, 26, ox + 32, 20, SADDLE)
    rect(buf, sw, sh, ox + 28, 18, ox + 36, 20, SADDLE)
    line(buf, sw, sh, ox + 51, 37, ox + 47, 22, FRAME)
    rect(buf, sw, sh, ox + 44, 20, ox + 50, 22, FRAME)
    rect(buf, sw, sh, ox + 30, 12, ox + 42, 20, BODY)
    line(buf, sw, sh, ox + 41, 14, ox + 47, 21, BODY)
    disk(buf, sw, sh, ox + 44, 9, 4, HEAD)
    for y in range(5, 9):
        for x in range(40, 49):
            if (x - 44) ** 2 + (y - 9) ** 2 <= 4 * 4:
                buf[y * sw + (ox + x)] = HELMET

def _draw_wheel(buf, sw, sh, cx, cy, spoke_phase):
    TIRE = (30, 22, 40, 255)
    SPOK = (215, 215, 225, 255)
    HUB  = (255, 210, 63, 255)
    ring(buf, sw, sh, cx, cy, WHEEL_R, WHEEL_R - 2, TIRE)
    # 4 spokes rotated by spoke_phase
    for k in range(4):
        ang = spoke_phase + k * math.pi / 2
        ex = cx + math.cos(ang) * (WHEEL_R - 1)
        ey = cy + math.sin(ang) * (WHEEL_R - 1)
        line(buf, sw, sh, cx, cy, int(round(ex)), int(round(ey)), SPOK)
    disk(buf, sw, sh, cx, cy, 1, HUB)

def gen_biker():
    W, H = FRAME_W * N_FRAMES, FRAME_H
    buf = make(W, H)
    for fi in range(N_FRAMES):
        ox = fi * FRAME_W
        spoke_phase = fi * (math.pi / 2) / N_FRAMES
        _draw_body(buf, W, H, ox)
        for axle in (REAR_AXLE, FRONT_AXLE):
            _draw_wheel(buf, W, H, ox + axle[0], axle[1], spoke_phase)
    return W, H, buf

# --- terrain tile 32x32 (tileable on both axes) ------------------------------
# Fills the hill interior. Scrolls and zooms with the world.
def gen_terrain():
    W, H = 32, 32
    BASE  = (45, 27, 61, 255)
    LIGHT = (62, 42, 84, 255)
    DARK  = (32, 18, 46, 255)
    buf = [BASE] * (W * H)
    # Hand-placed speckles, kept away from the edges so the seam is invisible.
    spots = [(5, 4, LIGHT), (14, 8, DARK), (22, 3, LIGHT),
             (28, 14, DARK), (3, 16, DARK), (18, 19, LIGHT),
             (10, 25, DARK), (26, 27, LIGHT)]
    for cx, cy, c in spots:
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if abs(dx) + abs(dy) <= 1:
                    setpx(buf, W, H, cx + dx, cy + dy, c)
    return W, H, buf

# --- background layers (tileable on X) ---------------------------------------
def gen_bg_far():
    W, H = 512, 256
    buf = make(W, H)
    # Two periodic sines so the silhouette tiles cleanly at x=W.
    def silhouette(x):
        a = 60 * math.sin(2 * math.pi * x / W * 1) + 30 * math.sin(2 * math.pi * x / W * 3 + 1.2)
        return int(H - 80 + a)
    MTN = (62, 48, 84, 255)   # muted purple
    for x in range(W):
        top = max(0, silhouette(x))
        for y in range(top, H):
            buf[y * W + x] = MTN
    return W, H, buf

def gen_bg_near():
    W, H = 512, 192
    buf = make(W, H)
    def silhouette(x):
        a = 30 * math.sin(2 * math.pi * x / W * 2 + 0.5) + 14 * math.sin(2 * math.pi * x / W * 5 + 2.1)
        return int(H - 60 + a)
    HILL = (38, 26, 56, 255)  # darker purple
    TREE = (24, 18, 38, 255)
    for x in range(W):
        top = max(0, silhouette(x))
        for y in range(top, H):
            buf[y * W + x] = HILL
    # A few "tree" blips along the ridge for texture; periodic so it tiles.
    for k in range(20):
        x = int((k * W / 20 + 7) % W)
        top = silhouette(x)
        for dy in range(0, 8):
            for dx in range(-1, 2):
                xi = (x + dx) % W
                if 0 <= top - dy < H:
                    buf[(top - dy) * W + xi] = TREE
    return W, H, buf

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, gen in [('biker.png', gen_biker),
                      ('terrain.png', gen_terrain),
                      ('bg-far.png', gen_bg_far), ('bg-near.png', gen_bg_near)]:
        path = os.path.join(OUT, name)
        if os.path.exists(path) and not FORCE:
            print(f'skip {path} (exists; pass --force to overwrite)')
            continue
        w, h, buf = gen()
        write_png(path, w, h, buf)
