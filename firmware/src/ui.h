#pragma once
#include <stdint.h>

struct Weather {
  bool ok = false;
  float temp = 0, tmax = 0, tmin = 0, wind = 0;
  int hum = 0, code = -1;
  bool day = true;
};

enum RobotMode { ROBOT_IDLE, ROBOT_WORKING, ROBOT_DOZE, ROBOT_SLEEP, ROBOT_HAPPY };
enum CasperFrame { CF_WALK1, CF_WALK2, CF_SIT1, CF_SIT2, CF_SLEEP1, CF_SLEEP2 };

// clock screen
void uiClockFull(int h, int m, int wday, int mday, int mon, const Weather &w);
void uiClockTime(int h, int m);
void uiClockDate(int wday, int mday, int mon, const Weather &w);
void uiWeather(const Weather &w);
// robot animation in the clock corner; returns ms until next frame
uint32_t uiRobotFrame(RobotMode mode, uint32_t frame);
// Casper scenes in the bottom-left area (left of the robot)
#define CASPER_SCENE_Y 174
int  uiSceneRight();
void uiSceneClear();
// draw Casper (2x) at x,y; padL/padR extra columns painted as background (to erase motion trails)
void uiCasper(int frame, int x, int y, bool flip, int padL, int padR, int clipR);
void uiCardCasper(uint32_t frame);
void uiCasperZ(int casperX, uint32_t t);   // rising z's above sleeping Casper   // little hop on the DONE card
// hub features
extern char uiUnread[24];             // non-empty: show an envelope + sender on the clock
extern char uiNext[40];
extern bool uiNextMusic;
void uiDrawFooter(const char *s);
void uiNotice(const char *src, const char *title, const char *text, int icon, uint16_t color);
uint16_t uiColor(const char *s);
extern bool uiLocationSet;
extern uint8_t uiFlags;
extern bool uiBannerOn;
#define UF_H12 1
#define UF_F 2
#define UF_NOFACE 4
int uiBanner(const char *src, const char *text, uint16_t color, int offset);
// reaction images: a downloaded pack when set (main.cpp), else the built-in pixel set
struct EmojiHdr { uint8_t w, h; uint16_t pal[16]; uint32_t off; };
extern bool (*uiPackEntry)(int idx, bool small, EmojiHdr &h);   // small: heart_s (idx 5) / wave_s (idx 0)
extern void (*uiPackRead)(uint32_t off, uint8_t *buf, int n);            // false: weather area asks to set a location
void uiPair(const char *code, const char *where);
void uiMessage2(const char *from, bool partner, const char *text, const char *when);
int  uiReactionIndex(const char *name);   // -1 if unknown
void uiReactionCard(const char *from, bool partner, int idx, const char *when);
uint32_t uiReactionFrame(int idx, uint32_t frame);   // returns ms to next frame
// full-screen status cards
void uiCard(bool needs, const char *project, const char *detail, const char *footer);
// plain message screen (boot / setup / safe mode)
void uiMessage(const char *title, const char *l1, const char *l2, const char *l3, uint16_t accent);

extern int uiLayout;   // 0 = clean, 1 = classic (tall clock + bars)
extern const uint16_t COL_ORANGE, COL_GREEN;
extern uint16_t COL_TEAL, COL_GREY;
void uiSetSoft(bool soft);
