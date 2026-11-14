#include <qrcode.h>
#include <string.h>
#include "qr.h"
#include "gfx.h"
#include "fonts.h"

#define QR_VERSION 3
#define QR_MAX 53

bool uiQrScreen(uint16_t color, const char *data, const char *line1, const char *line2, bool bigLine) {
  if (strlen(data) > QR_MAX) return false;
  QRCode qr;
  uint8_t buf[qrcode_getBufferSize(QR_VERSION)];
  if (qrcode_initText(&qr, buf, QR_VERSION, ECC_LOW, data) != 0) return false;
  const int s = 6, q = 12, n = qr.size, side = n * s + 2 * q, x0 = (SCR_W - side) / 2, y0 = 2;
  gFill(0, 0, SCR_W, SCR_H, 0);
  gFill(x0, y0, side, side, 0xFFFF);
  for (int y = 0; y < n; y++) {
    for (int x = 0; x < n;) {
      if (!qrcode_getModule(&qr, x, y)) { x++; continue; }
      int run = 1;
      while (x + run < n && qrcode_getModule(&qr, x + run, y)) run++;
      gFill(x0 + q + x * s, y0 + q + y * s, run * s, s, 0);
      x += run;
    }
  }
  tBox(bigLine ? F_M : F_S, line1, 0, SCR_W, bigLine ? 219 : 217, AL_CENTER, 0xFFFF, 0);
  tBox(F_S, line2, 0, SCR_W, 237, AL_CENTER, color, 0);
  return true;
}
