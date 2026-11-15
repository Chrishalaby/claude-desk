#pragma once
#include <stdint.h>

typedef int (*MediaRead)(void *ctx, uint8_t *buf, int n);

struct MediaFrame {
  uint16_t delay;
  uint8_t x, y, w, h;
  uint32_t len;
};

#define MEDIA_RLE 1
#define MEDIA_JPEG 2
#define MEDIA_JPEG_POOL 3500

bool mediaHeader(MediaRead rd, void *ctx, uint16_t *frames, uint8_t *kind);
bool mediaFrameHeader(MediaRead rd, void *ctx, MediaFrame *f);
bool mediaDrawFrame(MediaRead rd, void *ctx, const MediaFrame &f, void (*tick)());
bool mediaDrawJpeg(MediaRead rd, void *ctx, const MediaFrame &f, void (*tick)(), void *pool);
uint32_t mediaCrc(uint32_t crc, const uint8_t *p, int n);
