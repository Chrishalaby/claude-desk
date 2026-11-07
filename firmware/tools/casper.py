#!/usr/bin/env python3
"""Casper pixel sprites (40x32, facing right; drawn at 2x), built from shapes with an automatic outline.
Generates src/casper.h and a preview PNG.   Usage: casper.py <out.h> <preview.png>"""
import math, sys
from PIL import Image

W, H = 40, 32
FUR, SHADE, OUT, PINK, BLACK, TONGUE, ZZZ = 1, 2, 3, 4, 5, 6, 7
PAL = [None, (246, 246, 240), (200, 202, 200), (116, 118, 124), (238, 138, 150), (16, 16, 16),
       (228, 86, 110), (140, 170, 255)]


class G:
    def __init__(self):
        self.m = [[0] * W for _ in range(H)]

    def px(self, x, y, c=FUR):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < W and 0 <= y < H:
            self.m[y][x] = c

    def ellipse(self, cx, cy, rx, ry, c=FUR, rot=0.0):
        cs, sn = math.cos(rot), math.sin(rot)
        for y in range(H):
            for x in range(W):
                dx, dy = x - cx, y - cy
                u, v = dx * cs + dy * sn, -dx * sn + dy * cs
                if (u / rx) ** 2 + (v / ry) ** 2 <= 1.0:
                    self.m[y][x] = c

    def rect(self, x0, y0, x1, y1, c=FUR):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)

    def tri(self, pts, c=FUR):
        (ax, ay), (bx, by), (cx, cy) = pts
        def s(px, py, qx, qy, rx, ry): return (qx - px) * (ry - py) - (qy - py) * (rx - px)
        for y in range(H):
            for x in range(W):
                a, b, d = s(ax, ay, bx, by, x, y), s(bx, by, cx, cy, x, y), s(cx, cy, ax, ay, x, y)
                if (a >= 0 and b >= 0 and d >= 0) or (a <= 0 and b <= 0 and d <= 0):
                    self.m[y][x] = c

    def outline(self):
        o = [row[:] for row in self.m]
        for y in range(H):
            for x in range(W):
                if self.m[y][x] == 0:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < W and 0 <= ny < H and self.m[ny][nx] not in (0, OUT, ZZZ):
                            o[y][x] = OUT
                            break
        self.m = o

    def shade_bottom(self, y_from, x0=0, x1=W - 1):
        for y in range(y_from, H):
            for x in range(x0, x1 + 1):
                if self.m[y][x] == FUR:
                    self.m[y][x] = SHADE


HEAD_AWAKE = """
..W......W......
..WW....WW......
.WPW...WPW......
.WPPW..WPPW.....
.WPPWWWWPPW.....
WWWPWWWWPWWW....
WWWWWWWWWWWW....
WWWWWWWKWWWWW...
WWWWWWWKWWWWWWW.
WWWWWWWWWWWWWKKW
WWWWWWWWWWWWWKKW
.WWWWWWWWWWKWWW.
..WWWWWWWWWTTW..
...WWWWWWWWTT...
.....WWWWW......
"""

HEAD_SLEEP = """
..WWW...........
.WPPWW..........
.WWWWWWWWW......
WWWWWWWWWWWW....
WWWWWKKKWWWWWW..
WWWWWWWWWWWWWKKW
WWWWWWWWWWWWWKKW
.WWWWWWWWWWWWWW.
..WWWWWWWWWWW...
"""

CODES = {"W": FUR, "P": PINK, "K": BLACK, "T": TONGUE}


def stamp(g, art, ox, oy, only=None):
    for y, row in enumerate(art.strip("\n").split("\n")):
        for x, ch in enumerate(row):
            c = CODES.get(ch)
            if c and (only is None or c in only):
                g.px(ox + x, oy + y, c)


def head_side(g, hx, hy, mouth=True, eye="open", ears="up"):
    """hand-drawn head; (hx, hy) = top-left of the 16-wide head stamp"""
    art = HEAD_AWAKE if ears == "up" else HEAD_SLEEP
    stamp(g, art, hx, hy, only={FUR})      # fur first so the outline wraps the whole head
    return (hx, hy, art)


def head_details(g, h):
    hx, hy, art = h
    stamp(g, art, hx, hy, only={PINK, BLACK, TONGUE})


def leg(g, x0, y0, y1, c=FUR):
    g.rect(x0, y0, x0 + 2, y1, c)
    g.rect(x0, y1, x0 + 3, y1, c)    # paw


def walk(phase):
    g = G()
    g.ellipse(6.5, 10, 3.0, 6.0, rot=-0.55)            # tail plume
    g.ellipse(9, 5.5, 2.6, 2.6)
    if phase == 0:
        legs = [(8, SHADE), (13, FUR), (22, SHADE), (27, FUR)]
    else:
        legs = [(10, SHADE), (11, FUR), (24, SHADE), (25, FUR)]
    for x0, c in legs:
        leg(g, x0, 19, 30, c)
    g.ellipse(17.5, 16, 11, 5.6)                         # body
    g.ellipse(26.5, 13.5, 4.6, 5.8)                      # chest ruff
    h = head_side(g, 24, 0)
    for y in range(19, 22):                              # belly shade
        for x in range(8, 30):
            if g.m[y][x] == FUR:
                g.m[y][x] = SHADE
    for x0, c in legs:                                   # keep legs' own colour below belly
        g.rect(x0, 22, x0 + 2, 30, c); g.rect(x0, 30, x0 + 3, 30, c)
    g.outline()
    head_details(g, h)
    return g


def sit(tail_up):
    g = G()
    if tail_up:
        g.ellipse(7.5, 19, 2.8, 5.8, rot=-0.6)
        g.ellipse(5.5, 13.5, 2.4, 2.4)
    else:
        g.ellipse(9, 28, 6.5, 2.4, rot=0.15)
    g.ellipse(15.5, 23.5, 7.6, 6.2)                      # haunch
    leg(g, 26, 21, 30, SHADE)                            # far front leg
    g.ellipse(23, 18, 5.2, 8.2)                          # chest
    leg(g, 22, 22, 30, FUR)                              # near front leg
    g.rect(13, 29, 20, 30)                               # back paw
    h = head_side(g, 20, 0)
    for y in range(27, 31):
        for x in range(8, 22):
            if g.m[y][x] == FUR:
                g.m[y][x] = SHADE
    g.outline()
    head_details(g, h)
    return g


def hop():
    g = sit(True)
    g.m = [row[:] for row in g.m[5:]] + [[0] * W for _ in range(5)]
    return g


def sleep(breath):
    g = G()
    g.ellipse(18, 25 - 0.3 * breath, 13, 5.2 + 0.5 * breath)   # curled body (breathing)
    g.ellipse(10, 28.6, 7, 2.3, rot=0.1)                 # tail wrapped in front
    g.rect(29, 29, 36, 30)                               # front paws
    h = head_side(g, 24, 19, ears="down")
    for y in range(28, 31):
        for x in range(4, 30):
            if g.m[y][x] == FUR:
                g.m[y][x] = SHADE
    g.outline()
    head_details(g, h)
    return g


FRAMES = [("C_WALK1", walk(0)), ("C_WALK2", walk(1)), ("C_SIT1", sit(True)), ("C_SIT2", sit(False)),
          ("C_SLEEP1", sleep(0)), ("C_SLEEP2", sleep(1))]


def c565(r, g, b):
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


if __name__ == "__main__":
    out, prev = sys.argv[1], sys.argv[2]
    lines = ["// Generated by tools/casper.py: Casper pixel sprites (40x32, facing right). Do not edit.",
             "#pragma once", "#include <stdint.h>", '#include "font.h"', "#define CASPER_W 40", "#define CASPER_H 32",
             "static const uint16_t CASPER_PAL[8] = {0," + ",".join(f"0x{c565(*c):04x}" for c in PAL[1:]) + "};"]
    S = 5
    sheet = Image.new("RGB", (len(FRAMES) * (W * S + 10), H * S + 10), (24, 24, 24))
    for i, (name, g) in enumerate(FRAMES):
        flat = [v for row in g.m for v in row]
        lines.append(f"static const uint8_t {name}[] PROGMEM = {{" + ",".join(map(str, flat)) + "};")
        im = Image.new("RGB", (W, H), (0, 0, 0))
        for y in range(H):
            for x in range(W):
                if g.m[y][x]:
                    im.putpixel((x, y), PAL[g.m[y][x]])
        sheet.paste(im.resize((W * S, H * S), Image.NEAREST), (i * (W * S + 10) + 5, 5))
    open(out, "w").write("\n".join(lines) + "\n")
    sheet.save(prev)
    print("ok")
