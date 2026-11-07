#include <cstdio>
#include "../../src/ui.h"
#include "../../src/gfx.h"
void dump(const char *);
int main() {
  for (int s = 0; s < 4; s++) { uiEmojiSet = s; uiReactionCard("Maya", true, uiReactionIndex("hug"), "08:05"); uiReactionFrame(uiReactionIndex("hug"), 0);
    char p[32]; snprintf(p, 32, "/tmp/set%d.ppm", s); dump(p); }
}
