#include "../../src/gfx.h"
#include "../../src/media.h"
#include <stdio.h>

extern uint16_t FB[SCR_W * SCR_H];

static int rdFile(void *ctx, uint8_t *buf, int n) { return (int)fread(buf, 1, n, (FILE *)ctx); }

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  FILE *in = fopen(argv[1], "rb");
  FILE *out = fopen(argv[2], "wb");
  if (!in || !out) return 2;
  uint16_t frames;
  if (!mediaHeader(rdFile, in, &frames)) { fprintf(stderr, "bad header\n"); return 1; }
  for (int i = 0; i < frames; i++) {
    MediaFrame f;
    if (!mediaFrameHeader(rdFile, in, &f) || !mediaDrawFrame(rdFile, in, f, nullptr)) { fprintf(stderr, "bad frame %d\n", i); return 1; }
    fwrite(&f.delay, 2, 1, out);
    fwrite(FB, 2, SCR_W * SCR_H, out);
  }
  fclose(out);
  printf("%d frames\n", frames);
  return 0;
}
