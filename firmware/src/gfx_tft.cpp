// Device implementation of the gfx primitives on TFT_eSPI (ST7789 240x240).
#include <TFT_eSPI.h>
#include "gfx.h"

TFT_eSPI tft;

void gfxInit() {
  tft.init();
  tft.setRotation(0);
  tft.invertDisplay(true);   // this panel needs inversion for correct colours
  tft.setSwapBytes(true);    // gRow pixels are native-endian RGB565
  tft.fillScreen(TFT_BLACK);
}

void gFill(int x, int y, int w, int h, uint16_t c) { tft.fillRect(x, y, w, h, c); }
void gCircle(int cx, int cy, int r, uint16_t c) { tft.fillCircle(cx, cy, r, c); }
void gRRect(int x, int y, int w, int h, int r, uint16_t c) { tft.fillRoundRect(x, y, w, h, r, c); }
void gTri(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c) { tft.fillTriangle(x0, y0, x1, y1, x2, y2, c); }
void gRow(int x, int y, int w, const uint16_t *px) { tft.pushImage(x, y, w, 1, (uint16_t *)px); }

// ST7789 GAMSET (0x26): gamma curve 1..4
void gfxGamma(uint8_t g) {
  if (g < 1 || g > 4) g = 1;
  tft.writecommand(0x26);
  tft.writedata(1 << (g - 1));
}

// Panel tuning: gamma tables (presets) + VCOM voltage. Preset 0 = TFT_eSPI default.
static const uint8_t GAM[3][2][14] = {
  {{0xd0,0x00,0x02,0x07,0x0a,0x28,0x32,0x44,0x42,0x06,0x0e,0x12,0x14,0x17},
   {0xd0,0x00,0x02,0x07,0x0a,0x28,0x31,0x54,0x47,0x0e,0x1c,0x17,0x1b,0x1e}},
  {{0xf0,0x05,0x0a,0x06,0x06,0x03,0x2b,0x32,0x43,0x36,0x11,0x10,0x2b,0x32},
   {0xf0,0x08,0x0c,0x0b,0x09,0x24,0x2b,0x22,0x43,0x38,0x15,0x16,0x2f,0x37}},
  {{0xd0,0x04,0x0d,0x11,0x13,0x2b,0x3f,0x54,0x4c,0x18,0x0d,0x0b,0x1f,0x23},
   {0xd0,0x04,0x0c,0x11,0x13,0x2c,0x3f,0x44,0x51,0x2f,0x1f,0x1f,0x20,0x23}},
};

void gfxPanelTune(uint8_t gtab, uint8_t vcom) {
  if (gtab > 2) gtab = 0;
  tft.writecommand(0xE0); for (int i = 0; i < 14; i++) tft.writedata(GAM[gtab][0][i]);
  tft.writecommand(0xE1); for (int i = 0; i < 14; i++) tft.writedata(GAM[gtab][1][i]);
  if (vcom > 0x3F) vcom = 0x28;
  tft.writecommand(0xBB); tft.writedata(vcom);
}
