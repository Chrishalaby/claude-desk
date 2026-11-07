#include "ui.h"
#include "gfx.h"
#include "fonts.h"
#include "icons.h"
#include "casper.h"
#include "reactions.h"
#include <stdio.h>
#include <string.h>

// palette
static const uint16_t BG      = 0x0000;
static const uint16_t CARD_BG = 0x0000;              // pure black (dark greys tint green in RGB565)
static const uint16_t BODY    = c565(217, 119, 87);
static const uint16_t BODY_DK = c565(168, 82, 56);
static const uint16_t FACE    = c565(16, 16, 16);   // neutral in RGB565
static const uint16_t EYE     = c565(240, 238, 230);
static const uint16_t BULB_ON = c565(255, 196, 160);
static const uint16_t BULB_OFF= c565(110, 58, 40);
static const uint16_t DOT_OFF = c565(70, 50, 42);
static uint16_t WHITE   = c565(240, 240, 240);
static uint16_t DIM     = c565(90, 96, 108);
const uint16_t COL_ORANGE = c565(217, 119, 87);
uint16_t COL_TEAL   = c565(62, 201, 193);
const uint16_t COL_GREEN  = c565(46, 204, 113);
uint16_t COL_GREY   = c565(130, 136, 148);

int uiLayout = 0;
char uiUnread[24] = "";
bool uiLocationSet = true;
bool (*uiPackEntry)(int idx, bool small, EmojiHdr &h) = nullptr;
void (*uiPackRead)(uint32_t off, uint8_t *buf, int n) = nullptr;

void uiSetSoft(bool soft) {   // soft = lower-contrast, cooler palette (closer to the stock look)
  WHITE    = soft ? c565(196, 206, 216) : c565(240, 240, 240);
  COL_TEAL = soft ? c565(58, 160, 158)  : c565(62, 201, 193);
  COL_GREY = soft ? c565(112, 120, 134) : c565(130, 136, 148);
  DIM      = soft ? c565(74, 80, 92)    : c565(90, 96, 108);
}

static const char *WDAY[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *MON[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

// ------------------------------------------------------------------ robot ---
// 20x20 cell grid, pushed scaled row by row (no flicker, ~800 bytes RAM)
static uint16_t grid[20 * 20];

static void gr(int x1, int y1, int x2, int y2, uint16_t c) {
  for (int y = y1; y <= y2; y++)
    for (int x = x1; x <= x2; x++)
      if (x >= 0 && x < 20 && y >= 0 && y < 20) grid[y * 20 + x] = c;
}

enum Eyes { E_OPEN, E_WIDE, E_CLOSED, E_HAPPY, E_HALF };
static const uint16_t ZCOL = c565(140, 170, 255);

static void robotGrid(int dy, Eyes eyes, int look, uint16_t bulb, uint16_t bg) {
  gr(0, 0, 19, 19, bg);
  int y0 = 6 + dy;
  gr(9, y0 - 3, 10, y0 - 1, BODY_DK);          // antenna
  gr(8, y0 - 5, 11, y0 - 4, bulb);             // bulb
  gr(2, y0 + 4, 2, y0 + 7, BODY_DK);           // ears
  gr(17, y0 + 4, 17, y0 + 7, BODY_DK);
  gr(3, y0, 16, y0 + 11, BODY);                // head
  gr(3, y0, 3, y0, bg); gr(16, y0, 16, y0, bg);
  gr(3, y0 + 11, 3, y0 + 11, bg); gr(16, y0 + 11, 16, y0 + 11, bg);
  gr(5, y0 + 2, 14, y0 + 8, FACE);             // face screen
  int ex[2] = {7 + look, 12 + look}, ey = y0 + 4;
  for (int i = 0; i < 2; i++) {
    int e = ex[i];
    switch (eyes) {
      case E_OPEN:   gr(e - 1, ey, e, ey + 2, EYE); break;
      case E_WIDE:   gr(e - 1, ey - 1, e, ey + 2, EYE); break;
      case E_CLOSED: gr(e - 1, ey + 2, e, ey + 2, EYE); break;
      case E_HALF:   gr(e - 1, ey + 1, e, ey + 2, EYE); break;
      case E_HAPPY:
        gr(e - 2, ey + 2, e - 2, ey + 2, EYE); gr(e - 1, ey + 1, e, ey + 1, EYE);
        gr(e + 1, ey + 2, e + 1, ey + 2, EYE); break;
    }
  }
  gr(9, y0 + 10, 10, y0 + 10, BODY_DK);        // mouth light
}

static void blitGrid(int x, int y, int s) {
  uint16_t *row = gRowBuf;
  for (int gy = 0; gy < 20; gy++) {
    for (int gx = 0; gx < 20; gx++)
      for (int k = 0; k < s; k++) row[gx * s + k] = grid[gy * 20 + gx];
    for (int k = 0; k < s; k++) gRow(x, y + gy * s + k, 20 * s, row);
  }
}

#define ROBOT_X (uiLayout ? 156 : 148)
#define ROBOT_Y (uiLayout ? 156 : 150)

static void gz(int x, int y) {   // tiny 3x3 'z' inside the robot grid
  gr(x, y, x + 2, y, ZCOL); gr(x + 1, y + 1, x + 1, y + 1, ZCOL); gr(x, y + 2, x + 2, y + 2, ZCOL);
}

uint32_t uiRobotFrame(RobotMode mode, uint32_t frame) {
  if (mode == ROBOT_IDLE) {
    // calm: slow bob, a blink, soft antenna pulse
    static const int8_t dy[]  = {0, 0, 0, 0, 1, 1, 1, 0};
    static const uint8_t ey[] = {E_OPEN, E_OPEN, E_CLOSED, E_OPEN, E_OPEN, E_OPEN, E_OPEN, E_OPEN};
    static const uint16_t ms[] = {600, 600, 140, 600, 600, 600, 600, 600};
    int i = frame % 8;
    robotGrid(dy[i], (Eyes)ey[i], 0, dy[i] ? BULB_OFF : BULB_ON, BG);
    blitGrid(ROBOT_X, ROBOT_Y, 4);
    return ms[i];
  }
  if (mode == ROBOT_DOZE) {
    // heavy eyelids, nodding, the odd small z
    static const int8_t dy[]  = {0, 1, 1, 1, 0, 0};
    static const uint8_t ey[] = {E_HALF, E_HALF, E_CLOSED, E_CLOSED, E_HALF, E_OPEN};
    int i = frame % 6;
    robotGrid(dy[i], (Eyes)ey[i], 0, BULB_OFF, BG);
    if (i == 2) gz(16, 3);
    if (i == 3) gz(16, 0);
    blitGrid(ROBOT_X, ROBOT_Y, 4);
    return i == 5 ? 400 : 1100;
  }
  if (mode == ROBOT_SLEEP) {   // breathing + z's drifting up the corner
    int i = frame % 6;
    robotGrid(i >= 3 ? 1 : 0, E_CLOSED, 0, BULB_OFF, BG);
    gz(16, 4 - i * 4 / 5);
    if (i >= 3) gz(12, 3 - (i - 3));
    blitGrid(ROBOT_X, ROBOT_Y, 4);
    return 650;
  }
  if (mode == ROBOT_HAPPY) {
    int i = frame % 2;
    robotGrid(i, E_HAPPY, 0, BULB_ON, BG);
    blitGrid(ROBOT_X, ROBOT_Y, 4);
    return 350;
  }
  // working: eyes scan, antenna blinks, dots tick
  static const int8_t look[] = {-1, -1, 0, 1, 1, 0};
  int i = frame % 6;
  robotGrid(0, E_OPEN, look[i], (i % 2 == 0) ? BULB_ON : BULB_OFF, BG);
  for (int k = 0; k < 3; k++) gr(6 + k * 4, 19, 7 + k * 4, 19, k == i % 3 ? EYE : DOT_OFF);
  blitGrid(ROBOT_X, ROBOT_Y, 4);
  return 220;
}

// ----------------------------------------------------------------- casper ---
static const uint8_t *const CASPER_FR[] = {C_WALK1, C_WALK2, C_SIT1, C_SIT2, C_SLEEP1, C_SLEEP2};

int uiSceneRight() { return ROBOT_X - 2; }

void uiSceneClear() {
  int top = uiLayout ? 146 : 140;
  gFill(0, top, uiSceneRight(), SCR_H - top, BG);
}

void uiCasper(int frame, int x, int y, bool flip, int padL, int padR, int clipR) {
  uint16_t *row = gRowBuf;
  const uint8_t *spr = CASPER_FR[frame % 6];
  int x0 = x - padL, x1 = x + CASPER_W * 2 + padR;
  if (x0 < 0) x0 = 0;
  if (x1 > clipR) x1 = clipR;
  if (x1 > SCR_W) x1 = SCR_W;
  if (x1 <= x0) return;
  for (int sy = 0; sy < CASPER_H; sy++) {
    for (int px = x0; px < x1; px++) {
      int d = px - x;
      if (d < 0 || d >= CASPER_W * 2) { row[px - x0] = BG; continue; }
      int sx = d >> 1;
      if (flip) sx = CASPER_W - 1 - sx;
      uint8_t c = pgm_read_byte(spr + sy * CASPER_W + sx);
      row[px - x0] = c ? CASPER_PAL[c] : BG;
    }
    gRow(x0, y + sy * 2, x1 - x0, row);
    gRow(x0, y + sy * 2 + 1, x1 - x0, row);
  }
}

// three z's rising and fading above a sleeping Casper (call every ~120 ms)
void uiCasperZ(int casperX, uint32_t t) {
  int clipR = uiSceneRight();
  for (int k = 0; k < 3; k++) {
    int ph = (t + k * 10) % 30;                   // 0..29
    int x = casperX + 66 + ph / 6, y = 206 - ph * 2;
    if (x + 10 > clipR) x = clipR - 10;
    uint8_t a = ph < 20 ? 15 : 15 - (ph - 20) * 3 / 2;   // fade out near the top
    uint16_t c = c565(140 * a / 15, 170 * a / 15, 255 * a / 15);
    tBox(F_S, ph < 29 ? "z" : "", x, 10, y, AL_LEFT, c, BG);
    gFill(x, y + 3, 10, 3, BG);                   // erase the step below
  }
}

void uiCardCasper(uint32_t frame) {
  int up = frame % 2;                       // hop: up / down
  int y = up ? 22 : 30;
  if (up) gFill(0, y + CASPER_H * 2, 80, 8, BG); else gFill(0, 22, 80, 8, BG);
  uiCasper(up ? CF_SIT1 : CF_SIT2, 0, y, false, 0, 0, 80);
}

// ------------------------------------------------------------ clock screen ---
void uiClockTime(int h, int m) {
  char s[8];
  snprintf(s, sizeof s, "%02d:%02d", h, m);
  const uint16_t pc[5] = {WHITE, WHITE, DIM, COL_TEAL, COL_TEAL};  // hours white, minutes teal
  if (uiLayout) tBox(F_TALL, s, 0, SCR_W, 138, AL_CENTER, WHITE, BG, pc);
  else tBox(F_CLOCK, s, 0, SCR_W, 112, AL_CENTER, WHITE, BG, pc);
}

static void windIcon(int x, int y);

void uiClockDate(int wday, int mday, int mon, const Weather &w) {
  char s[24];
  snprintf(s, sizeof s, "%s %d %s", WDAY[wday % 7], mday, MON[mon % 12]);
  char r[24] = "";
  if (w.ok) snprintf(r, sizeof r, "H %d\x7f  L %d\x7f", (int)(w.tmax + 0.5f), (int)(w.tmin + 0.5f));
  if (uiLayout && uiUnread[0]) {          // unread message: envelope + sender replaces H/L + wind
    tBox(F_M, s, 14, 160, 28, AL_LEFT, COL_GREY, BG);
    gFill(14, 34, 160, 18, BG);
    gRRect(15, 37, 16, 12, 2, COL_ORANGE);
    gTri(15, 38, 30, 38, 23, 44, BG); gTri(16, 38, 29, 38, 23, 43, COL_ORANGE);
    gLine(16, 38, 23, 44, 1, BG); gLine(23, 44, 30, 38, 1, BG);
    char m[40]; snprintf(m, sizeof m, "from %s", uiUnread);
    tBox(F_S, m, 36, 138, 48, AL_LEFT, COL_ORANGE, BG);
    return;
  }
  if (uiLayout) {
    tBox(F_M, s, 14, 160, 28, AL_LEFT, COL_GREY, BG);
    tBox(F_S, r, 14, 80, 48, AL_LEFT, DIM, BG);
    gFill(94, 34, 28, 18, BG);
    char wd[12] = "";
    if (w.ok) { windIcon(94, 35); snprintf(wd, sizeof wd, "%d km/h", (int)(w.wind + 0.5f)); }
    tBox(F_S, wd, 121, 55, 48, AL_LEFT, DIM, BG);
  } else {
    tBox(F_M, s, 14, 130, 32, AL_LEFT, COL_GREY, BG);
    tBox(F_S, r, 144, 82, 30, AL_RIGHT, DIM, BG);
  }
}

[[maybe_unused]] static const char *condition(int c) {
  if (c == 0) return "Clear";
  if (c == 1) return "Mostly clear";
  if (c == 2) return "Partly cloudy";
  if (c == 3) return "Cloudy";
  if (c == 45 || c == 48) return "Fog";
  if (c >= 51 && c <= 57) return "Drizzle";
  if (c == 66 || c == 67) return "Freezing rain";
  if (c >= 61 && c <= 65) return "Rain";
  if (c >= 71 && c <= 77) return "Snow";
  if (c >= 80 && c <= 82) return "Showers";
  if (c == 85 || c == 86) return "Snow showers";
  if (c >= 95) return "Storm";
  return "";
}

// --------------------------------------------------------------- icons ---
static void blitIcon(const Icon &ic, int x, int y) {
  uint16_t *row = gRowBuf;
  for (int r = 0; r < ic.h; r++) {
    for (int c = 0; c < ic.w; c++) {
      uint32_t i = (uint32_t)r * ic.w + c;
      uint8_t b = pgm_read_byte(ic.px + i / 2);
      row[c] = ic.pal[(i & 1) ? (b & 0x0F) : (b >> 4)];
    }
    gRow(x, y + r, ic.w, row);
  }
}

// draw icon centred in a box, clearing the box first
static void iconIn(const Icon &ic, int x, int y, int bw, int bh) {
  gFill(x, y, bw, bh, BG);
  blitIcon(ic, x + (bw - ic.w) / 2, y + (bh - ic.h) / 2);
}

static const Icon &weatherIcon(int c, bool day) {
  if (c == 0 || c == 1) return day ? I_CLEAR_D : I_CLEAR_N;
  if (c == 2) return day ? I_PARTLY_D : I_PARTLY_N;
  if (c == 45 || c == 48) return I_FOG;
  if (c >= 51 && c <= 57) return I_DRIZZLE;
  if (c == 66 || c == 67) return I_SLEET;
  if ((c >= 61 && c <= 65) || (c >= 80 && c <= 82)) return I_RAIN;
  if ((c >= 71 && c <= 77) || c == 85 || c == 86) return I_SNOW;
  if (c >= 95) return I_STORM;
  return I_OVERCAST;
}

static void windIcon(int x, int y) { blitIcon(I_WIND_S, x, y); }

void uiWeather(const Weather &w) {
  char t[12], h[8];
  snprintf(t, sizeof t, "%d\x7f", (int)(w.temp + (w.temp < 0 ? -0.5f : 0.5f)));
  snprintf(h, sizeof h, "%d%%", w.hum);
  if (uiLayout) {
    gFill(176, 0, 64, 56, BG);
    gFill(0, 146, 152, 94, BG);
    if (!uiLocationSet) { tBox(F_S, "Set your location on", 14, 136, 186, AL_LEFT, DIM, BG);
                          tBox(F_S, "the settings page", 14, 136, 206, AL_LEFT, DIM, BG); return; }
    if (!w.ok) { tBox(F_S, "Weather loading...", 14, 136, 200, AL_LEFT, DIM, BG); return; }
    iconIn(weatherIcon(w.code, w.day), 176, 4, 60, 50);
    iconIn(I_THERMO, 8, 150, 30, 38);
    tBox(F_TEMP, t, 44, 104, 186, AL_LEFT, WHITE, BG);
    iconIn(I_HUMID, 8, 194, 30, 36);
    tBox(F_TEMP, h, 44, 104, 228, AL_LEFT, WHITE, BG);
    return;
  }
  gFill(4, 140, 144, 92, BG);
  if (!uiLocationSet) { tBox(F_S, "Set your location on", 14, 132, 200, AL_LEFT, DIM, BG);
                        tBox(F_S, "the settings page", 14, 132, 220, AL_LEFT, DIM, BG); return; }
  if (!w.ok) { tBox(F_S, "Weather loading...", 14, 132, 222, AL_LEFT, DIM, BG); return; }
  iconIn(weatherIcon(w.code, w.day), 4, 144, 60, 50);
  iconIn(I_THERMO_S, 66, 158, 20, 28);
  tBox(F_TEMP, t, 88, 58, 186, AL_LEFT, WHITE, BG);
  blitIcon(I_HUMID_S, 12, 208);
  tBox(F_S, h, 32, 40, 222, AL_LEFT, COL_GREY, BG);
  blitIcon(I_WIND_S, 68, 208);
  char wd[12];
  snprintf(wd, sizeof wd, "%d km/h", (int)(w.wind + 0.5f));
  tBox(F_S, wd, 98, 50, 222, AL_LEFT, COL_GREY, BG);
}

void uiClockFull(int h, int m, int wday, int mday, int mon, const Weather &w) {
  gFill(0, 0, SCR_W, SCR_H, BG);
  uiClockDate(wday, mday, mon, w);
  uiClockTime(h, m);
  uiWeather(w);
}

// ------------------------------------------------------------------ cards ---
void uiCard(bool needs, const char *project, const char *detail, const char *footer) {
  uint16_t accent = needs ? COL_ORANGE : COL_GREEN;
  gFill(0, 0, SCR_W, SCR_H, CARD_BG);
  robotGrid(0, needs ? E_WIDE : E_HAPPY, 0, needs ? BULB_ON : COL_GREEN, CARD_BG);
  blitGrid(80, 10, 4);
  if (needs) {
    gRRect(162, 20, 35, 31, 8, accent);
    gTri(166, 46, 158, 58, 176, 48, accent);
    tBox(F_L, "!", 162, 35, 46, AL_CENTER, CARD_BG, accent);
  } else {
    gCircle(177, 35, 15, accent);
    gLine(170, 35, 175, 41, 4, CARD_BG);
    gLine(175, 41, 185, 29, 4, CARD_BG);
  }
  tBox(F_L, needs ? "NEEDS YOU" : "DONE", 0, SCR_W, 128, AL_CENTER, accent, CARD_BG);
  char buf[96];
  strncpy(buf, project && *project ? project : "claude code", sizeof buf - 1); buf[sizeof buf - 1] = 0;
  tFit(F_M, buf, sizeof buf, 220);
  tBox(F_M, buf, 0, SCR_W, 160, AL_CENTER, WHITE, CARD_BG);
  if (detail && *detail) {
    strncpy(buf, detail, sizeof buf - 1); buf[sizeof buf - 1] = 0;
    tFit(F_S, buf, sizeof buf, 220);
    tBox(F_S, buf, 0, SCR_W, 188, AL_CENTER, COL_GREY, CARD_BG);
  }
  if (footer && *footer) {
    strncpy(buf, footer, sizeof buf - 1); buf[sizeof buf - 1] = 0;
    tFit(F_S, buf, sizeof buf, 220);
    tBox(F_S, buf, 0, SCR_W, 226, AL_CENTER, DIM, CARD_BG);
  }
}

void uiMessage(const char *title, const char *l1, const char *l2, const char *l3, uint16_t accent) {
  gFill(0, 0, SCR_W, SCR_H, CARD_BG);
  robotGrid(0, E_OPEN, 0, BULB_ON, CARD_BG);
  blitGrid(80, 14, 4);
  tBox(F_L, title, 0, SCR_W, 128, AL_CENTER, accent, CARD_BG);
  const char *ls[3] = {l1, l2, l3};
  char buf[64];
  for (int i = 0; i < 3; i++) {
    if (!ls[i] || !*ls[i]) continue;
    const AAFont &f = i == 0 ? F_M : F_S;
    strncpy(buf, ls[i], sizeof buf - 1); buf[sizeof buf - 1] = 0;
    tFit(f, buf, sizeof buf, 224);
    tBox(f, buf, 0, SCR_W, 162 + i * 28, AL_CENTER, i == 0 ? WHITE : COL_GREY, CARD_BG);
  }
}

// ------------------------------------------------------------- hub screens ---
static const uint16_t PINKC = c565(255, 150, 172);

void uiPair(const char *code, const char *where) {
  gFill(0, 0, SCR_W, SCR_H, CARD_BG);
  robotGrid(0, E_WIDE, 0, BULB_ON, CARD_BG);
  blitGrid(90, 8, 3);
  tBox(F_M, "PAIR THIS DESK", 0, SCR_W, 96, AL_CENTER, COL_TEAL, CARD_BG);
  char c[12];
  snprintf(c, sizeof c, "%.3s %.3s", code, strlen(code) > 3 ? code + 3 : "");
  tBox(F_TEMP, c, 0, SCR_W, 146, AL_CENTER, WHITE, CARD_BG);
  tBox(F_S, "enter this code at", 0, SCR_W, 184, AL_CENTER, COL_GREY, CARD_BG);
  char w[64];
  strncpy(w, where, sizeof w - 1); w[sizeof w - 1] = 0;
  tFit(F_S, w, sizeof w, 228);
  tBox(F_S, w, 0, SCR_W, 206, AL_CENTER, COL_ORANGE, CARD_BG);
}

// greedy word wrap into up to `maxLines` lines of maxW px; returns line count
static int wrap(const AAFont &f, const char *text, char lines[][64], int maxLines, int maxW) {
  int n = 0;
  lines[0][0] = 0;
  const char *p = text;
  while (*p && n < maxLines) {
    while (*p == ' ') p++;
    const char *e = p;
    while (*e && *e != ' ') e++;
    char word[64];
    int wl = e - p < 63 ? e - p : 63;
    memcpy(word, p, wl); word[wl] = 0;
    char trial[128];
    snprintf(trial, sizeof trial, "%s%s%s", lines[n], lines[n][0] ? " " : "", word);
    if (tWidth(f, trial) <= maxW || !lines[n][0]) {
      strncpy(lines[n], trial, 63); lines[n][63] = 0;
      if (tWidth(f, lines[n]) > maxW) tFit(f, lines[n], 64, maxW);
      p = e;
    } else {
      if (++n >= maxLines) break;
      lines[n][0] = 0;
    }
  }
  int count = n < maxLines ? n + 1 : maxLines;
  if (*p && count == maxLines) {           // text left over: ellipsis on the last line
    char t[70];
    snprintf(t, sizeof t, "%s...", lines[maxLines - 1]);
    strncpy(lines[maxLines - 1], t, 63); lines[maxLines - 1][63] = 0;
    tFit(f, lines[maxLines - 1], 64, maxW);
  }
  return lines[0][0] ? count : 0;
}

// draw a reaction image (pack from storage, or built-in pixel set from flash).
// pad = extra border painted black (erases motion trails); flip = mirror horizontally
static void blitE(int idx, bool small, int x, int y, int pad, bool flip = false) {
  uint16_t *row = gRowBuf;
  static uint8_t line[48];
  EmojiHdr h;
  const uint8_t *pgm = nullptr;
  if (!(uiPackEntry && uiPackEntry(idx, small, h))) {
    const EmojiImg *ep = small ? (idx == 5 ? &P_HEART_S : &P_WAVE_S) : (const EmojiImg *)pgm_read_ptr(&REACT_IMG[idx]);
    EmojiImg e;
    memcpy_P(&e, ep, sizeof e);
    h.w = e.w; h.h = e.h; memcpy(h.pal, e.pal, sizeof h.pal); h.off = 0;
    pgm = e.px;
  }
  int bpr = (h.w + 1) / 2;
  int x0 = x - pad, x1 = x + h.w + pad;
  if (x0 < 0) x0 = 0;
  if (x1 > SCR_W) x1 = SCR_W;
  for (int ry = -pad; ry < h.h + pad; ry++) {
    bool in = ry >= 0 && ry < h.h;
    if (in) {
      if (pgm) memcpy_P(line, pgm + (uint32_t)ry * bpr, bpr);
      else uiPackRead(h.off + (uint32_t)ry * bpr, line, bpr);
    }
    for (int px = x0; px < x1; px++) {
      int d = px - x;
      uint16_t c = CARD_BG;
      if (in && d >= 0 && d < h.w) {
        int sx = flip ? h.w - 1 - d : d;
        uint8_t b = line[sx / 2];
        c = h.pal[(sx & 1) ? (b & 0x0F) : (b >> 4)];
      }
      row[px - x0] = c;
    }
    if (y + ry >= 0 && y + ry < SCR_H) gRow(x0, y + ry, x1 - x0, row);
  }
}

static void blitReact(int idx, int x, int y, int pad, bool flip = false) { blitE(idx, false, x, y, pad, flip); }

static void senderLine(const char *from, bool partner, int baseline) {
  char n[40];
  strncpy(n, from, sizeof n - 1); n[sizeof n - 1] = 0;
  tFit(F_L, n, sizeof n, 220);
  tBox(F_L, n, 0, SCR_W, baseline, AL_CENTER, partner ? PINKC : COL_TEAL, CARD_BG);
}

void uiMessage2(const char *from, bool partner, const char *text, const char *when) {
  gFill(0, 0, SCR_W, SCR_H, CARD_BG);
  blitE(partner ? 5 : 0, true, (SCR_W - 44) / 2, 8, 0);   // small heart (partner) or wave (friend)
  senderLine(from, partner, 86);
  char lines[3][64];
  int n = wrap(F_M, text, lines, 3, 224);
  int base = n == 1 ? 140 : n == 2 ? 128 : 118;
  for (int i = 0; i < n; i++) tBox(F_M, lines[i], 0, SCR_W, base + i * 28, AL_CENTER, WHITE, CARD_BG);
  tBox(F_S, when, 0, SCR_W, 226, AL_CENTER, DIM, CARD_BG);
}

int uiReactionIndex(const char *name) {
  for (int i = 0; i < REACT_COUNT; i++) if (!strcmp(name, REACT_NAMES[i])) return i;
  return -1;
}

static const char *const REACT_CAPTION[] = {
  "waves at you", "gives you a thumbs up", "is laughing", "sends you a coffee", "says that's fire",
  "sends you love", "sends you a hug", "sends you a kiss", "says goodnight", "misses you"};

void uiReactionCard(const char *from, bool partner, int idx, const char *when) {
  gFill(0, 0, SCR_W, SCR_H, CARD_BG);
  senderLine(from, partner, 150);
  tBox(F_M, REACT_CAPTION[idx], 0, SCR_W, 180, AL_CENTER, WHITE, CARD_BG);
  tBox(F_S, when, 0, SCR_W, 226, AL_CENTER, DIM, CARD_BG);
  blitReact(idx, 80, 32, 0);
}

// small floating hearts / stars around partner reactions
static void particle(int idx, int k, uint32_t frame, bool erase) {
  int ph = (frame + k * 7) % 21;
  int x = (k == 0 ? 26 : k == 1 ? 200 : 50), y = 112 - ph * 4;
  uint16_t c = erase ? CARD_BG : (idx == 8 ? c565(255, 208, 62) : PINKC);
  if (y < 4) return;
  if (idx == 8) { gFill(x + 2, y, 2, 6, c); gFill(x, y + 2, 6, 2, c); return; }   // twinkle star
  gFill(x, y + 1, 3, 2, c); gFill(x + 4, y + 1, 3, 2, c); gFill(x + 1, y + 3, 5, 2, c); gFill(x + 2, y + 5, 3, 1, c);
}

uint32_t uiReactionFrame(int idx, uint32_t f) {
  switch (idx) {
    case 0: { static const int8_t dx[] = {-6, 0, 6, 0}; blitReact(idx, 80 + dx[f % 4], 32, 7); return 130; }   // wave
    case 1: case 7: { static const int8_t dy[] = {0, -4, -8, -4}; blitReact(idx, 80, 32 + dy[f % 4], 9);       // thumbs / kiss
                      if (idx == 7) for (int k = 0; k < 3; k++) { particle(idx, k, f - 1, true); particle(idx, k, f, false); }
                      return 130; }
    case 2: { blitReact(idx, 80, 32 + (f % 2 ? 2 : -2), 3); return 90; }                                      // laugh
    case 3: case 9: { blitReact(idx, 80, 32 + (f % 2 ? 0 : -3), 4); return 500; }                             // coffee / missyou
    case 4: { blitReact(idx, 80, 32, 0, f % 2); return 170; }                                                 // fire flicker
    case 5: case 6: {                                                                                          // heart / hug
      static const int8_t dy[] = {0, -3, -6, -3};
      blitReact(idx, 80, 32 + dy[f % 4], 7);
      for (int k = 0; k < 3; k++) { particle(idx, k, f - 1, true); particle(idx, k, f, false); }
      return 200;
    }
    case 8: {                                                                                                  // goodnight
      blitReact(idx, 80, 32 + (f % 4 < 2 ? 0 : -2), 3);
      for (int k = 0; k < 3; k++) { particle(idx, k, f - 1, true); particle(idx, k, f, false); }
      return 400;
    }
  }
  return 1000;
}
