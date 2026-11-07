// Host framebuffer implementation of the gfx primitives (for layout previews).
#include "../src/gfx.h"
#include <stdio.h>
uint16_t FB[SCR_W * SCR_H];
static void px(int x, int y, uint16_t c) { if (x >= 0 && y >= 0 && x < SCR_W && y < SCR_H) FB[y * SCR_W + x] = c; }
void gFill(int x, int y, int w, int h, uint16_t c) { for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) px(i, j, c); }
void gCircle(int cx, int cy, int r, uint16_t c) { for (int y = -r; y <= r; y++) for (int x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) px(cx + x, cy + y, c); }
void gRRect(int x, int y, int w, int h, int r, uint16_t c) {
  gFill(x + r, y, w - 2 * r, h, c); gFill(x, y + r, w, h - 2 * r, c);
  gCircle(x + r, y + r, r, c); gCircle(x + w - r - 1, y + r, r, c);
  gCircle(x + r, y + h - r - 1, r, c); gCircle(x + w - r - 1, y + h - r - 1, r, c);
}
static int sgn(int x0, int y0, int x1, int y1, int x, int y) { return (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0); }
void gTri(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c) {
  int minx = x0 < x1 ? (x0 < x2 ? x0 : x2) : (x1 < x2 ? x1 : x2), maxx = x0 > x1 ? (x0 > x2 ? x0 : x2) : (x1 > x2 ? x1 : x2);
  int miny = y0 < y1 ? (y0 < y2 ? y0 : y2) : (y1 < y2 ? y1 : y2), maxy = y0 > y1 ? (y0 > y2 ? y0 : y2) : (y1 > y2 ? y1 : y2);
  for (int y = miny; y <= maxy; y++) for (int x = minx; x <= maxx; x++) {
    int a = sgn(x0, y0, x1, y1, x, y), b = sgn(x1, y1, x2, y2, x, y), d = sgn(x2, y2, x0, y0, x, y);
    if ((a >= 0 && b >= 0 && d >= 0) || (a <= 0 && b <= 0 && d <= 0)) px(x, y, c);
  }
}
void gRow(int x, int y, int w, const uint16_t *p) { for (int i = 0; i < w; i++) px(x + i, y, p[i]); }
void dump(const char *path) {
  FILE *f = fopen(path, "wb"); fprintf(f, "P6 %d %d 255\n", SCR_W, SCR_H);
  for (int i = 0; i < SCR_W * SCR_H; i++) { uint16_t c = FB[i]; unsigned char rgb[3] = {(unsigned char)((c >> 8) & 0xF8), (unsigned char)((c >> 3) & 0xFC), (unsigned char)((c << 3) & 0xF8)}; fwrite(rgb, 1, 3, f); }
  fclose(f);
}
