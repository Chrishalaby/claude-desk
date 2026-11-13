#pragma once
#include <stdint.h>
#include "font.h"

#define SCR_W 240
#define SCR_H 240

static inline uint16_t c565(uint8_t r, uint8_t g, uint8_t b) {
  return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}

// ---- platform primitives (gfx_tft.cpp on device, gfx_host.cpp for previews)
void gFill(int x, int y, int w, int h, uint16_t c);
void gCircle(int cx, int cy, int r, uint16_t c);                      // filled
void gRRect(int x, int y, int w, int h, int r, uint16_t c);           // filled
void gTri(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c);// filled
extern uint16_t gRowBuf[SCR_W];
void gRow(int x, int y, int w, const uint16_t *px);                   // push one pixel row

// ---- common helpers (gfx_common.cpp)
extern int16_t tScroll;
extern uint8_t gSharp;   // 1 = crisper text edges (steeper anti-alias curve)
enum Align { AL_LEFT, AL_CENTER, AL_RIGHT };
void gLine(int x0, int y0, int x1, int y1, int thick, uint16_t c);   // thick line via circles
int  tWidth(const AAFont &f, const char *utf8);
// Draw text inside a box [bx, bx+bw) on the font's line band at baseline.
// The whole band row is painted (bg) so redraws never flicker or leave residue.
// perChar: optional fg colour per glyph (nullptr = fg for all).
void tBox(const AAFont &f, const char *utf8, int bx, int bw, int baseline, Align al,
          uint16_t fg, uint16_t bg, const uint16_t *perChar = nullptr);
// Shorten s (in place, buffer size cap) with "..." until it fits maxW.
void tFit(const AAFont &f, char *s, int cap, int maxW);
