#include "media.h"
#include "gfx.h"
extern "C" {
#include "tjpgd.h"
}

static bool readAll(MediaRead rd, void *ctx, uint8_t *buf, int n) {
  while (n > 0) {
    int got = rd(ctx, buf, n);
    if (got <= 0) return false;
    buf += got;
    n -= got;
  }
  return true;
}

bool mediaHeader(MediaRead rd, void *ctx, uint16_t *frames, uint8_t *kind) {
  uint8_t h[8];
  if (!readAll(rd, ctx, h, 8) || h[0] != 'D' || h[1] != 'K' || h[2] != 'M' || (h[3] != '1' && h[3] != '2')) return false;
  *kind = h[3] == '2' ? MEDIA_JPEG : MEDIA_RLE;
  *frames = h[4] | (h[5] << 8);
  return *frames > 0;
}

bool mediaFrameHeader(MediaRead rd, void *ctx, MediaFrame *f) {
  uint8_t h[10];
  if (!readAll(rd, ctx, h, 10)) return false;
  f->delay = h[0] | (h[1] << 8);
  f->x = h[2];
  f->y = h[3];
  f->w = h[4];
  f->h = h[5];
  f->len = (uint32_t)h[6] | ((uint32_t)h[7] << 8) | ((uint32_t)h[8] << 16) | ((uint32_t)h[9] << 24);
  return f->x + f->w <= SCR_W && f->y + f->h <= SCR_H;
}

struct Reader {
  MediaRead rd;
  void *ctx;
  uint32_t left;
  uint8_t buf[64];
  int pos, have;
  bool get(uint8_t &b) {
    if (pos == have) {
      if (!left) return false;
      int n = rd(ctx, buf, left < sizeof buf ? (int)left : (int)sizeof buf);
      if (n <= 0) return false;
      have = n;
      pos = 0;
      left -= n;
    }
    b = buf[pos++];
    return true;
  }
  bool color(uint16_t &c) {
    uint8_t lo, hi;
    if (!get(lo) || !get(hi)) return false;
    c = lo | (hi << 8);
    return true;
  }
};

struct Painter {
  const MediaFrame &f;
  int cx, cy, seg, k;
  void flush() {
    if (k) gRow(f.x + seg, f.y + cy, k, gRowBuf);
    k = 0;
    seg = cx;
  }
  void put(uint16_t c) {
    gRowBuf[k++] = c;
    if (++cx == f.w) {
      flush();
      cx = 0;
      cy++;
      seg = 0;
    }
  }
  void skip(uint32_t n) {
    flush();
    cx += n % f.w;
    cy += n / f.w;
    if (cx >= f.w) { cx -= f.w; cy++; }
    seg = cx;
  }
};

bool mediaDrawFrame(MediaRead rd, void *ctx, const MediaFrame &f, void (*tick)()) {
  Reader r{rd, ctx, f.len, {}, 0, 0};
  if (!f.w || !f.h) {
    uint8_t b;
    while (r.get(b)) {}
    return true;
  }
  Painter p{f, 0, 0, 0, 0};
  uint32_t total = (uint32_t)f.w * f.h, done = 0;
  while (done < total) {
    uint8_t t;
    if (!r.get(t)) return false;
    uint8_t kind = t >> 6;
    uint32_t n;
    if (kind == 3) {
      uint8_t lo;
      if (!r.get(lo)) return false;
      kind = (t >> 4) & 3;
      n = ((uint32_t)(t & 0x0F) << 8 | lo) + 1;
      if (kind == 3) return false;
    } else {
      n = (t & 0x3F) + 1;
    }
    if (done + n > total) return false;
    if (kind == 0) {
      p.skip(n);
    } else if (kind == 1) {
      uint16_t c;
      if (!r.color(c)) return false;
      for (uint32_t i = 0; i < n; i++) p.put(c);
    } else {
      for (uint32_t i = 0; i < n; i++) {
        uint16_t c;
        if (!r.color(c)) return false;
        p.put(c);
      }
    }
    done += n;
    if (tick && (done & 0x0FFF) < n) tick();
  }
  p.flush();
  uint8_t b;
  while (r.get(b)) {}
  return true;
}

struct JpegIo {
  MediaRead rd;
  void *ctx;
  uint32_t left;
  void (*tick)();
  uint8_t x, y;
};

static size_t jpegIn(JDEC *jd, uint8_t *buf, size_t n) {
  JpegIo *io = (JpegIo *)jd->device;
  if (n > io->left) n = io->left;
  size_t done = 0;
  uint8_t skip[32];
  while (done < n) {
    size_t want = n - done;
    if (!buf && want > sizeof skip) want = sizeof skip;
    int got = io->rd(io->ctx, buf ? buf + done : skip, (int)want);
    if (got <= 0) break;
    done += got;
  }
  io->left -= done;
  return done;
}

static int jpegOut(JDEC *jd, void *bitmap, JRECT *r) {
  JpegIo *io = (JpegIo *)jd->device;
  gBlock(io->x + r->left, io->y + r->top, r->right - r->left + 1, r->bottom - r->top + 1, (const uint16_t *)bitmap);
  if (io->tick && !r->left) io->tick();
  return 1;
}

bool mediaDrawJpeg(MediaRead rd, void *ctx, const MediaFrame &f, void (*tick)(), void *pool) {
  JpegIo io{rd, ctx, f.len, tick, f.x, f.y};
  JDEC jd;
  jd.swap = 0;
  bool ok = pool && jd_prepare(&jd, jpegIn, pool, MEDIA_JPEG_POOL, &io) == JDR_OK &&
            f.x + jd.width <= SCR_W && f.y + jd.height <= SCR_H && jd_decomp(&jd, jpegOut, 0) == JDR_OK;
  while (io.left && jpegIn(&jd, nullptr, io.left)) {}
  return ok && !io.left;
}

uint32_t mediaCrc(uint32_t crc, const uint8_t *p, int n) {
  crc = ~crc;
  while (n--) {
    crc ^= *p++;
    for (int i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1)));
  }
  return ~crc;
}
