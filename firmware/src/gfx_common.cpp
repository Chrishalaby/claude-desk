#include "gfx.h"
#include <string.h>

static uint16_t rowbuf[SCR_W];
uint8_t gSharp = 1;
// alpha remap: soft = linear, sharp = steep curve (fewer grey edge pixels -> less blur)
static const uint8_t SHARP[16] = {0, 0, 0, 1, 2, 4, 6, 8, 10, 12, 14, 15, 15, 15, 15, 15};

// UTF-8 -> font code: ASCII as-is, degree -> 127, middle dot -> 128, else '?'
static int nextCode(const char *&p) {
  uint8_t c = (uint8_t)*p;
  if (!c) return -1;
  if (c < 0x80) { p++; return c; }
  if (c == 0xC2 && (uint8_t)p[1] == 0xB0) { p += 2; return 127; }
  if (c == 0xC2 && (uint8_t)p[1] == 0xB7) { p += 2; return 128; }
  if (c == 0x7F) { p++; return 127; }
  // skip one whole multibyte sequence
  int n = (c >= 0xF0) ? 4 : (c >= 0xE0) ? 3 : (c >= 0xC0) ? 2 : 1;
  while (n-- && *p) p++;
  return '?';
}

static bool glyph(const AAFont &f, int code, AAGlyph &g) {
  if (code < f.first || code > f.last) return false;
  memcpy_P(&g, &f.g[code - f.first], sizeof(AAGlyph));
  return true;
}

int tWidth(const AAFont &f, const char *s) {
  int w = 0, code;
  AAGlyph g;
  while ((code = nextCode(s)) >= 0)
    if (glyph(f, code, g)) w += g.adv;
  return w;
}

void tBox(const AAFont &f, const char *s, int bx, int bw, int baseline, Align al,
          uint16_t fg, uint16_t bg, const uint16_t *perChar) {
  if (bx < 0) { bw += bx; bx = 0; }
  if (bx + bw > SCR_W) bw = SCR_W - bx;
  if (bw <= 0) return;
  int tw = tWidth(f, s);
  int x0 = al == AL_LEFT ? bx : al == AL_CENTER ? bx + (bw - tw) / 2 : bx + bw - tw;

  // collect glyphs (max 48)
  struct G { AAGlyph g; int pen; uint16_t fg; } gs[48];
  int n = 0, pen = x0, code, ci = 0;
  const char *p = s;
  while ((code = nextCode(p)) >= 0 && n < 48) {
    AAGlyph g;
    if (!glyph(f, code, g)) { ci++; continue; }
    gs[n].g = g; gs[n].pen = pen; gs[n].fg = perChar ? perChar[ci] : fg;
    pen += g.adv; n++; ci++;
  }

  // per-colour 16-step palettes (cache last fg)
  uint16_t pal[16], palFg = 0; bool palOk = false;
  uint8_t br = (bg >> 8) & 0xF8, bgc = (bg >> 3) & 0xFC, bb = (bg << 3) & 0xF8;

  int top = baseline - f.ascent, bottom = top + f.height;
  for (int y = top; y < bottom; y++) {
    if (y < 0 || y >= SCR_H) continue;
    for (int i = 0; i < bw; i++) rowbuf[i] = bg;
    for (int k = 0; k < n; k++) {
      const AAGlyph &g = gs[k].g;
      int gy = y - (baseline + g.yo);
      if (gy < 0 || gy >= g.h || !g.w) continue;
      if (!palOk || palFg != gs[k].fg) {
        uint16_t c = gs[k].fg;
        uint8_t fr = (c >> 8) & 0xF8, fgc = (c >> 3) & 0xFC, fb = (c << 3) & 0xF8;
        for (int a = 0; a < 16; a++)
          pal[a] = c565(br + (fr - br) * a / 15, bgc + (fgc - bgc) * a / 15, bb + (fb - bb) * a / 15);
        palFg = c; palOk = true;
      }
      for (int gx = 0; gx < g.w; gx++) {
        int sx = gs[k].pen + g.xo + gx - bx;
        if (sx < 0 || sx >= bw) continue;
        uint32_t idx = (uint32_t)gy * g.w + gx;
        uint8_t b = pgm_read_byte(f.bmp + g.off + idx / 2);
        uint8_t a = (idx & 1) ? (b & 0x0F) : (b >> 4);
        if (gSharp) a = SHARP[a];
        if (a) rowbuf[sx] = pal[a];
      }
    }
    gRow(bx, y, bw, rowbuf);
  }
}

void tFit(const AAFont &f, char *s, int cap, int maxW) {
  if (tWidth(f, s) <= maxW) return;
  int len = strlen(s);
  while (len > 0) {
    len--;
    while (len > 0 && ((uint8_t)s[len] & 0xC0) == 0x80) len--;  // don't split UTF-8
    if (len + 4 > cap) continue;
    s[len] = 0;
    char tmp[96];
    strncpy(tmp, s, sizeof(tmp) - 4); tmp[sizeof(tmp) - 4] = 0;
    strcat(tmp, "...");
    if (tWidth(f, tmp) <= maxW) { strcpy(s, tmp); return; }
  }
  strcpy(s, "...");
}

void gLine(int x0, int y0, int x1, int y1, int thick, uint16_t c) {
  int dx = x1 - x0, dy = y1 - y0;
  int steps = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy) ? (dx < 0 ? -dx : dx) : (dy < 0 ? -dy : dy);
  if (!steps) steps = 1;
  int r = thick / 2;
  for (int i = 0; i <= steps; i++) {
    int x = x0 + dx * i / steps, y = y0 + dy * i / steps;
    if (r <= 0) gFill(x, y, 1, 1, c); else gCircle(x, y, r, c);
  }
}
