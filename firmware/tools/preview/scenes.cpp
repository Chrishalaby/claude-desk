#include <cstdio>
#include "../src/ui.h"
#include "../src/gfx.h"
void dump(const char *);
int main() {
  uiLayout = 1;
  Weather w; w.ok = true; w.temp = 19.2; w.tmax = 21; w.tmin = 15; w.hum = 74; w.wind = 12; w.code = 3; w.day = true;
  int rx = uiSceneRight() - 82;
  // walk-in mid way
  uiClockFull(14, 37, 5, 6, 10, w); uiSceneClear(); uiCasper(CF_WALK1, 20, CASPER_SCENE_Y, false, 4, 0, uiSceneRight()); uiRobotFrame(ROBOT_IDLE, 0); dump("/tmp/s1.ppm");
  // sitting, robot happy
  uiClockFull(14, 38, 5, 6, 10, w); uiSceneClear(); uiCasper(CF_SIT1, rx, CASPER_SCENE_Y, false, 0, 0, uiSceneRight()); uiRobotFrame(ROBOT_HAPPY, 0); dump("/tmp/s2.ppm");
  // nap, robot dozing
  uiClockFull(15, 2, 5, 6, 10, w); uiSceneClear(); uiCasper(CF_SLEEP1, rx, CASPER_SCENE_Y, false, 0, 0, uiSceneRight()); uiRobotFrame(ROBOT_DOZE, 2); dump("/tmp/s3.ppm");
  // night
  Weather n = w; n.day = false; n.code = 0;
  uiClockFull(23, 41, 5, 6, 10, n); uiSceneClear(); uiCasper(CF_SLEEP2, rx, CASPER_SCENE_Y, false, 0, 0, uiSceneRight()); uiRobotFrame(ROBOT_SLEEP, 1); dump("/tmp/s4.ppm");
  // done card with hop
  uiCard(false, "SUPY", "Finished", "14:40"); uiCardCasper(1); dump("/tmp/s5.ppm");
  // walk-out (flipped)
  uiClockFull(14, 39, 5, 6, 10, w); uiSceneClear(); uiCasper(CF_WALK2, 30, CASPER_SCENE_Y, true, 0, 4, uiSceneRight()); uiRobotFrame(ROBOT_IDLE, 0); dump("/tmp/s6.ppm");
}
