#include <cstdio>
#include <cstring>
#include "../../src/ui.h"
#include "../../src/gfx.h"
void dump(const char *);
struct PackEnt { char name[16]; uint8_t w, h; uint16_t _p; uint32_t off; uint16_t pal[16]; };
static PackEnt ent[12]; static int cnt = 0; static FILE *pf;
static const char *ORD[] = {"wave","thumbs","laugh","coffee","fire","heart","hug","kiss","goodnight","missyou"};
bool pe(int idx, bool small, EmojiHdr &h) { char w[16]; snprintf(w, 16, small ? "%s_s" : "%s", ORD[idx]);
  for (int i = 0; i < cnt; i++) if (!strcmp(ent[i].name, w)) { h.w = ent[i].w; h.h = ent[i].h; h.off = ent[i].off; memcpy(h.pal, ent[i].pal, 32); return true; } return false; }
void pr(uint32_t off, uint8_t *b, int n) { fseek(pf, off, SEEK_SET); fread(b, 1, n, pf); }
int main() {
  static_assert(sizeof(PackEnt) == 56, "entry size");
  pf = fopen("../../../hub/packs/twemoji.bin", "rb"); unsigned char h[8]; fread(h, 1, 8, pf);
  if (memcmp(h, "CDPK", 4)) return 1; cnt = h[5]; fread(ent, sizeof(PackEnt), cnt, pf);
  uiPackEntry = pe; uiPackRead = pr;
  uiReactionCard("Sam", false, uiReactionIndex("laugh"), "08:12"); dump("/tmp/pk1.ppm");
  uiMessage2("Maya", true, "pack test", "08:12"); dump("/tmp/pk2.ppm");
  printf("entries %d\n", cnt);
}
