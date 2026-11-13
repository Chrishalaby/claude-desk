#pragma once
#include <stdint.h>
#ifdef ARDUINO
#include <pgmspace.h>
#else
#define PROGMEM
#define pgm_read_byte(p) (*(const uint8_t *)(p))
#define memcpy_P memcpy
#define pgm_read_ptr(p) (*(const void *const *)(p))
#define strcmp_P strcmp
#define strlen_P strlen
#define snprintf_P snprintf
#define PSTR(x) x
#endif

struct AAGlyph {
  uint32_t off;   // offset into bitmap (4-bit pixels, 2 per byte)
  uint8_t w, h;
  int8_t xo, yo;  // top-left relative to pen position on baseline
  uint8_t adv;
};

struct AAFont {
  const uint8_t *bmp;
  const AAGlyph *g;
  uint8_t first, last;
  uint8_t ascent, height;
};
