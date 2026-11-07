#include <cstdio>
#include <cstring>
#include "../../src/ui.h"
#include "../../src/gfx.h"
void dump(const char *);
int main() {
  uiLayout = 1;
  uiPair("482913", "claude-desk-hub.up.railway.app"); dump("/tmp/h1.ppm");
  uiMessage2("Maya", true, "see you at 8? bring the cat pics, I need them for my sanity today", "07:52"); dump("/tmp/h2.ppm");
  uiMessage2("Sam", false, "gym later?", "07:53"); dump("/tmp/h3.ppm");
  uiReactionCard("Maya", true, uiReactionIndex("hug"), "07:55"); uiReactionFrame(uiReactionIndex("hug"), 3); dump("/tmp/h4.ppm");
  uiReactionCard("Sam", false, uiReactionIndex("fire"), "07:56"); uiReactionFrame(uiReactionIndex("fire"), 1); dump("/tmp/h5.ppm");
  Weather w; w.ok = true; w.temp = 19; w.tmax = 21; w.tmin = 15; w.hum = 74; w.wind = 12; w.code = 2; w.day = true;
  strcpy(uiUnread, "Maya"); uiClockFull(8, 2, 6, 7, 10, w); uiRobotFrame(ROBOT_IDLE, 0); dump("/tmp/h6.ppm");
}
