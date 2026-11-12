// claude-desk firmware for the GeekMagic SmallTV Ultra (ESP8266 + ST7789 240x240).
//
// Normal mode: clock + weather (Open-Meteo, no key) + animated robot; Claude Code status
//              via GET /state?s=idle|working|needs|done&p=<project>&d=<detail>&f=<footer>
// Setup mode : no Wi-Fi saved / can't connect -> open AP "claude-desk-setup", portal at 192.168.4.1
// Safe mode  : 4 crash-reboots in a row -> only Wi-Fi + /update (or always, in the LOADER build)
//
// Web firmware update is always available at /update.

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPUpdateServer.h>
#include <ESP8266mDNS.h>
#include <DNSServer.h>
#include <ESP8266WiFiMulti.h>
#include <EEPROM.h>
#include <time.h>
#include "gfx.h"
#include "ui.h"
#ifndef LOADER
#include <ESP8266HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFiClientSecureBearSSL.h>
#include <PubSubClient.h>
#include <ESP8266httpUpdate.h>
#include <LittleFS.h>
#include <MD5Builder.h>
#include "media.h"
#endif

#ifndef FW_VERSION
#define FW_VERSION "1.0.1"
#endif
#define PIN_BL 5
#define AP_SSID "claude-desk-setup"

void gfxInit();
void gfxGamma(uint8_t g);
void gfxPanelTune(uint8_t gtab, uint8_t vcom);

ESP8266WebServer server(80);
ESP8266HTTPUpdateServer updater;
DNSServer dns;
ESP8266WiFiMulti wifiMulti;

enum Mode { M_NORMAL, M_SAFE, M_SETUP };
Mode mode = M_NORMAL;
uint32_t restartAt = 0;
uint32_t netOkAt = 0;

// ------------------------------------------------------- crash-loop guard ---
struct RtcBoot { uint32_t magic, count; };
#define RTC_MAGIC 0xC1A0DE51
#define RTC_SLOT 64            // RTC user memory block (well clear of the OTA command area)
RtcBoot rtcBoot;
bool bootCleared = false;

void bootGuard() {
  ESP.rtcUserMemoryRead(RTC_SLOT, (uint32_t *)&rtcBoot, sizeof rtcBoot);
  rst_info *ri = ESP.getResetInfoPtr();
  bool cold = ri->reason == REASON_DEFAULT_RST || ri->reason == REASON_EXT_SYS_RST ||
              ri->reason == REASON_DEEP_SLEEP_AWAKE;
  if (rtcBoot.magic != RTC_MAGIC || cold) { rtcBoot.magic = RTC_MAGIC; rtcBoot.count = 0; }
  rtcBoot.count++;
  ESP.rtcUserMemoryWrite(RTC_SLOT, (uint32_t *)&rtcBoot, sizeof rtcBoot);
}

void bootOk() {
  rtcBoot.count = 0;
  ESP.rtcUserMemoryWrite(RTC_SLOT, (uint32_t *)&rtcBoot, sizeof rtcBoot);
  bootCleared = true;
}

// -------------------------------------------------------------- settings ---
#ifndef LOADER
struct Settings { uint32_t magic; float lat, lon; uint8_t bday, bnight, nstart, nend, layout, gamma; uint16_t pwm; uint8_t soft, gtab, vcom, sharp; };
#define SET_MAGIC 0xDE5C0005
Settings S;

void loadSettings() {
  EEPROM.get(0, S);
  if (S.magic != SET_MAGIC) S = {SET_MAGIC, 0.0f, 0.0f, 25, 10, 22, 7, 1, 1, 1000, 0, 2, 0x28, 1};  // no location yet, layout B
  uiLayout = S.layout ? 1 : 0;
  uiSetSoft(S.soft);
  gSharp = S.sharp;
}

void saveSettings() { EEPROM.put(0, S); EEPROM.commit(); }

// extra settings (own block so older settings survive upgrades)
#define EXT_ADDR 600
#define EXT_MAGIC 0x48554233
struct Ext { uint32_t magic; char host[64]; char secret[44]; uint32_t lastMsg; int32_t tzoff;
             uint8_t casper, locSet, _pad[2]; char pack[16]; uint32_t setRev; };
Ext X;

void saveExt() { EEPROM.put(EXT_ADDR, X); EEPROM.commit(); }

void loadExt() {
  EEPROM.get(EXT_ADDR, X);
  if (X.magic != EXT_MAGIC) {
    memset(&X, 0, sizeof X);
    X.magic = EXT_MAGIC;
    X.locSet = (S.lat != 0.0f || S.lon != 0.0f);   // keep a location set by an older version
    saveExt();
  }
  X.host[63] = X.secret[43] = 0;
  uiLocationSet = X.locSet;
  X.pack[15] = 0;
  if (!X.pack[0]) strcpy(X.pack, "pixel");
}
#endif

#define NAME_ADDR 768
#define NAME_MAGIC 0x484F5354
struct NameStore { uint32_t magic; char host[33]; };
char hostName[33];

bool validHost(const char *h) {
  size_t n = strlen(h);
  if (!n || n > 32 || h[0] == '-' || h[n - 1] == '-') return false;
  for (size_t i = 0; i < n; i++)
    if (!((h[i] >= 'a' && h[i] <= 'z') || (h[i] >= '0' && h[i] <= '9') || h[i] == '-')) return false;
  return true;
}

void defaultHostName(char *out) { snprintf(out, 33, "claude-desk-%06x", ESP.getChipId()); }

void loadHostName() {
  NameStore ns;
  EEPROM.get(NAME_ADDR, ns);
  ns.host[32] = 0;
  if (ns.magic == NAME_MAGIC && validHost(ns.host)) strcpy(hostName, ns.host);
  else defaultHostName(hostName);
}

void startMdns() {
  MDNS.begin(hostName);
  MDNS.addService("http", "tcp", 80);
}

#ifndef LOADER
void setHostName(const char *h) {
  bool custom = h && validHost(h);
  char want[33];
  if (custom) strcpy(want, h); else defaultHostName(want);
  if (!strcmp(want, hostName)) return;
  NameStore ns;
  memset(&ns, 0, sizeof ns);
  if (custom) { ns.magic = NAME_MAGIC; strcpy(ns.host, want); }
  EEPROM.put(NAME_ADDR, ns);
  EEPROM.commit();
  strcpy(hostName, want);
  WiFi.hostname(hostName);
  MDNS.end();
  startMdns();
}
#endif

// ------------------------------------------------------- saved networks ---
// Up to 4 Wi-Fi networks, stored after the settings block. The device joins whichever is in range.
#define NET_MAX 4
#define NET_ADDR 128
#define NET_MAGIC 0x4E455431
struct Net { char ssid[33]; char pass[65]; };
struct NetStore { uint32_t magic; Net n[NET_MAX]; };
NetStore NS;

void saveNets() { EEPROM.put(NET_ADDR, NS); EEPROM.commit(); }

int netCount() { int c = 0; for (int i = 0; i < NET_MAX; i++) if (NS.n[i].ssid[0]) c++; return c; }

void addNet(const String &ssid, const String &pass) {
  int slot = -1;
  for (int i = 0; i < NET_MAX; i++) if (ssid == NS.n[i].ssid) slot = i;            // update existing
  if (slot < 0) for (int i = 0; i < NET_MAX; i++) if (!NS.n[i].ssid[0]) { slot = i; break; }
  if (slot < 0) {                                                                       // full: drop oldest
    for (int i = 0; i < NET_MAX - 1; i++) NS.n[i] = NS.n[i + 1];
    slot = NET_MAX - 1;
  }
  memset(&NS.n[slot], 0, sizeof(Net));
  strncpy(NS.n[slot].ssid, ssid.c_str(), 32);
  strncpy(NS.n[slot].pass, pass.c_str(), 64);
  saveNets();
}

void delNet(int i) {
  if (i < 0 || i >= NET_MAX) return;
  for (int k = i; k < NET_MAX - 1; k++) NS.n[k] = NS.n[k + 1];
  memset(&NS.n[NET_MAX - 1], 0, sizeof(Net));
  saveNets();
}

void loadNets() {
  EEPROM.get(NET_ADDR, NS);
  if (NS.magic != NET_MAGIC) {                       // first boot: adopt the SDK-stored network
    memset(&NS, 0, sizeof NS);
    NS.magic = NET_MAGIC;
    if (WiFi.SSID().length()) addNet(WiFi.SSID(), WiFi.psk()); else saveNets();
  }
  for (int i = 0; i < NET_MAX; i++)
    if (NS.n[i].ssid[0]) wifiMulti.addAP(NS.n[i].ssid, NS.n[i].pass);
}

String jsonStr(const char *s) {
  String o = "\"";
  for (const char *p = s; *p; p++) {
    uint8_t c = (uint8_t)*p;
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}

bool scanBest(int i) {
  String s = WiFi.SSID(i);
  if (!s.length()) return false;
  int n = WiFi.scanComplete();
  for (int k = 0; k < n; k++)
    if (k != i && WiFi.SSID(k) == s && (WiFi.RSSI(k) > WiFi.RSSI(i) || (WiFi.RSSI(k) == WiFi.RSSI(i) && k < i))) return false;
  return true;
}

bool inScan(const char *ssid) {
  int n = WiFi.scanComplete();
  for (int i = 0; i < n; i++) if (WiFi.SSID(i) == ssid) return true;
  return false;
}

#define ROAM_GRACE_MS 8000
#define ROAM_JOIN_MS 15000
#define ROAM_SCAN_EVERY_MS 20000
#define NONET_MS 180000UL
#define BADNET_MS 600000UL

bool internetProbe() {
  WiFiClient c;
  c.setTimeout(3000);
  bool ok = c.connect(IPAddress(1, 1, 1, 1), 443) || c.connect(IPAddress(8, 8, 8, 8), 53);
  c.stop();
  return ok;
}

void wifiRoam() {
  static uint32_t lostAt = 0, joinUntil = 0, nextScan = 0, badUntil = 0;
  static int8_t badNet = -1;
  static bool scanning = false;
  uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (lostAt || !netOkAt) { netOkAt = now | 1; scanning = false; }
    lostAt = joinUntil = 0;
#ifndef LOADER
    if (scanning) {
      int n = WiFi.scanComplete();
      if (n == WIFI_SCAN_RUNNING) return;
      scanning = false;
      String cur = WiFi.SSID();
      int curK = -1;
      bool other = false;
      for (int k = 0; k < NET_MAX; k++) {
        if (!NS.n[k].ssid[0]) continue;
        if (cur == NS.n[k].ssid) { curK = k; continue; }
        for (int i = 0; i < n; i++) if (WiFi.SSID(i) == NS.n[k].ssid) other = true;
      }
      WiFi.scanDelete();
      if (!other) return;
      badNet = curK;
      badUntil = now + BADNET_MS;
      WiFi.disconnect();
      return;
    }
    if (netCount() < 2 || now - netOkAt < NONET_MS) return;
    netOkAt = now | 1;
    if (internetProbe()) return;
    WiFi.scanDelete();
    WiFi.scanNetworks(true);
    scanning = true;
#else
    scanning = false;
#endif
    return;
  }
  if (!lostAt) { lostAt = now | 1; return; }
  if (now - lostAt < ROAM_GRACE_MS) return;
  if (joinUntil && (int32_t)(now - joinUntil) < 0) return;
  if (!scanning) {
    if ((int32_t)(now - nextScan) < 0) return;
    WiFi.scanDelete();
    WiFi.disconnect();
    WiFi.scanNetworks(true);
    scanning = true;
    nextScan = now + ROAM_SCAN_EVERY_MS;
    return;
  }
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  scanning = false;
  int bestK = -1, bestI = -1, bestR = -1000;
  bool avoid = badNet >= 0 && (int32_t)(badUntil - now) > 0;
  for (int pass = 0; pass < 2 && bestK < 0; pass++, avoid = false)
    for (int i = 0; i < n; i++)
      for (int k = 0; k < NET_MAX; k++)
        if (NS.n[k].ssid[0] && !(avoid && k == badNet) && WiFi.SSID(i) == NS.n[k].ssid && WiFi.RSSI(i) > bestR) { bestR = WiFi.RSSI(i); bestK = k; bestI = i; }
  if (bestK >= 0) {
    WiFi.begin(NS.n[bestK].ssid, NS.n[bestK].pass, WiFi.channel(bestI), WiFi.BSSID(bestI));
    joinUntil = now + ROAM_JOIN_MS;
  }
  WiFi.scanDelete();
}

// ------------------------------------------------------------- backlight ---
int curBrightness = -1;
void setBrightness(int pct) {   // panel backlight is active-low
  pct = constrain(pct, 0, 100);
  if (pct == curBrightness) return;
  analogWrite(PIN_BL, 1023 - pct * 1023 / 100);
  curBrightness = pct;
}

// ------------------------------------------------------------------ wifi ---
bool connectWifi(uint32_t timeoutMs) {
  WiFi.persistent(false);                // our own list in EEPROM is the source of truth
  WiFi.mode(WIFI_STA);
  WiFi.hostname(hostName);
  loadNets();
  if (!netCount()) return false;
  char l2[40];
  snprintf(l2, sizeof l2, "%d saved network%s", netCount(), netCount() == 1 ? "" : "s");
  uiMessage("CONNECTING", l2, "claude-desk " FW_VERSION, "", COL_TEAL);
  uint32_t t = millis();
  while (wifiMulti.run(6000) != WL_CONNECTED && millis() - t < timeoutMs) { delay(200); yield(); }
  return WiFi.status() == WL_CONNECTED;
}

void startSetup() {
  mode = M_SETUP;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID);
  delay(100);
  dns.start(53, "*", WiFi.softAPIP());
  uiMessage("SETUP", "Join Wi-Fi", AP_SSID, "then open 192.168.4.1", COL_TEAL);
}

// ------------------------------------------------------------- web: shared ---
static const char HEAD[] PROGMEM =
    "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<style>body{font:15px system-ui;background:#141413;color:#eee;max-width:420px;margin:24px auto;padding:0 16px}"
    "a{color:#d97757}input,select{width:100%;padding:8px;margin:4px 0 12px;box-sizing:border-box;background:#222;color:#eee;border:1px solid #444;border-radius:6px}"
    "button{background:#d97757;color:#141413;border:0;padding:10px 16px;border-radius:6px;font-weight:600}"
    ".m{color:#888}</style>";

void out(const String &s) { if (s.length()) server.sendContent(s); }

void pageStart() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/html", "");
  server.sendContent_P(HEAD);
}

void sendTpl(PGM_P t, String (*val)(const char *)) {
  size_t start = 0, i = 0;
  char c;
  while ((c = pgm_read_byte(t + i))) {
    if (c != '~') { i++; continue; }
    if (i > start) server.sendContent_P(t + start, i - start);
    char key[12];
    size_t k = 0;
    i++;
    while ((c = pgm_read_byte(t + i)) && c != '~') { if (k < sizeof key - 1) key[k++] = c; i++; }
    key[k] = 0;
    if (c) i++;
    out(val(key));
    start = i;
  }
  if (i > start) server.sendContent_P(t + start, i - start);
}

void sendPage(PGM_P t, String (*val)(const char *)) { pageStart(); sendTpl(t, val); }

String htmlEsc(const String &s) {
  String o; o.reserve(s.length());
  for (char c : s) {
    if (c == '<') o += "&lt;"; else if (c == '>') o += "&gt;"; else if (c == '&') o += "&amp;";
    else if (c == '\'') o += "&#39;"; else if (c == '"') o += "&quot;"; else o += c;
  }
  return o;
}

void handleReboot() {
  server.send(200, "text/plain", "rebooting");
  restartAt = millis() + 500;
}

void infoCommon(String &j) {
  j += "\"fw\":\"" FW_VERSION "\",\"mode\":\"";
  j += mode == M_NORMAL ? "normal" : mode == M_SAFE ? "safe" : "setup";
  j += "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"local\":\"" + hostName + ".local\",\"rssi\":" + String(WiFi.RSSI());
  j += ",\"heap\":" + String(ESP.getFreeHeap()) + ",\"maxblk\":" + String(ESP.getMaxFreeBlockSize()) +
       ",\"reset\":\"" + ESP.getResetReason() + "\",\"uptime\":" + String(millis() / 1000);
}

// ----------------------------------------------------------- web: setup AP ---
static const char SETUP_PAGE[] PROGMEM =
    "<h2>claude-desk setup</h2><form action=/save method=post><label>Wi-Fi network</label><select name=ssid>~nets~</select>"
    "<label>Password</label><input name=pass type=password><button>Connect</button></form>"
    "<p class=m>Or type a hidden network name:</p><form action=/save method=post>"
    "<input name=ssid placeholder='exact network name' autocapitalize=none autocorrect=off autocomplete=off spellcheck=false><input name=pass type=password placeholder=password>"
    "<button>Connect</button></form><p><a href=/update>Firmware update</a></p>";

void handleSetupRoot() {
  WiFi.scanNetworks();
  sendPage(SETUP_PAGE, [](const char *) {
    String o;
    for (int i = 0, n = WiFi.scanComplete(); i < n; i++) {
      String s = htmlEsc(WiFi.SSID(i));
      o += "<option value='" + s + "'>" + s + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
    }
    return o;
  });
}

static const char SAVED_PAGE[] PROGMEM =
    "<h2>Saved</h2><p>Connecting to ~ssid~. The screen will show the new IP in a few seconds.</p>";

void handleSave() {
  String ssid = server.arg("ssid"), pass = server.arg("pass");
  if (!ssid.length()) { server.send(400, "text/plain", "missing ssid"); return; }
  sendPage(SAVED_PAGE, [](const char *) { return htmlEsc(server.arg("ssid")); });
  addNet(ssid, pass);                        // added to the saved list, nothing else is forgotten
  restartAt = millis() + 1500;
}

// ------------------------------------------------------- web: safe/loader ---
static const char SAFE_PAGE[] PROGMEM =
#ifdef LOADER
    "<h2>claude-desk loader</h2><p>Upload the full firmware:</p>"
#else
    "<h2>claude-desk safe mode</h2><p>The firmware crashed several times in a row. Upload a fixed build:</p>"
#endif
    "<p><a href=/update>Firmware update</a> &middot; <a href=/reboot>Reboot</a></p><p class=m>fw " FW_VERSION "</p>";

void handleSafeRoot() {
  sendPage(SAFE_PAGE, [](const char *) { return String(); });
}

static const char WIFI_PAGE[] PROGMEM =
    "<h2>Wi-Fi networks</h2><p class=m>Connected to <b>~ssid~</b> as ~ip~ &middot; also <b>~host~.local</b></p>"
    "<p>The device joins whichever saved network is in range.</p><ul>~nets~</ul>"
    "<form action=/wifi method=post><label>Add a network</label><select name=ssid>"
    "<option value=''>Choose a network in range</option>~opts~</select>"
    "<label>Or type a hidden network's exact name</label>"
    "<input name=ssid2 autocapitalize=none autocorrect=off autocomplete=off spellcheck=false>"
    "<label>Password</label><input name=pass type=password><button>Add</button></form><p><a href=/>Back</a></p>";

String wifiVal(const char *k) {
  if (!strcmp(k, "ssid")) return htmlEsc(WiFi.SSID());
  if (!strcmp(k, "ip")) return WiFi.localIP().toString();
  if (!strcmp(k, "host")) return hostName;
  String o;
  if (!strcmp(k, "opts")) {
    for (int i = 0, n = WiFi.scanComplete(); i < n; i++) {
      if (!scanBest(i)) continue;
      String s = htmlEsc(WiFi.SSID(i));
      o += F("<option value='"); o += s; o += F("'>"); o += s; o += F(" ("); o += WiFi.RSSI(i); o += F(" dBm)</option>");
    }
    return o;
  }
  for (int i = 0; i < NET_MAX; i++) {
    if (!NS.n[i].ssid[0]) continue;
    o += F("<li>"); o += htmlEsc(NS.n[i].ssid);
    o += inScan(NS.n[i].ssid) ? F(" &middot; in range") : F(" &middot; <b>not in range</b>");
    o += F(" &middot; <a href='/wifi?del="); o += i; o += F("'>remove</a></li>");
  }
  return o;
}

void handleWifi() {
  if (server.hasArg("del")) { delNet(server.arg("del").toInt()); server.sendHeader("Location", "/wifi"); server.send(303); return; }
  String ssid = server.arg("ssid").length() ? server.arg("ssid") : server.arg("ssid2");
  if (ssid.length()) {
    addNet(ssid, server.arg("pass"));
    wifiMulti.addAP(ssid.c_str(), server.arg("pass").c_str());
    server.sendHeader("Location", "/wifi"); server.send(303); return;
  }
  WiFi.scanDelete();
  WiFi.scanNetworks();
  sendPage(WIFI_PAGE, wifiVal);
  WiFi.scanDelete();
}

void handleInfoBasic() {
  String j = "{";
  infoCommon(j);
  j += "}";
  server.send(200, "application/json", j);
}

// ============================================================ normal mode ===
#ifndef LOADER
enum View { V_CLOCK, V_NEEDS, V_DONE, V_MSG, V_PAIR, V_NOTE, V_DRAW, V_MEDIA };
bool settingsDirty = true;   // report settings to the hub
View view = V_CLOCK;
bool dirty = true, timeValid = false;
RobotMode robot = ROBOT_IDLE;
String cardP, cardD, cardF;
uint32_t doneUntil = 0, lastStateMs = 0, nextWeather = 0, nextFrame = 0, frameNo = 0, nextBrt = 0;
int lastMin = -1, lastDay = -1;
Weather W;

// ---- Casper scenes + robot moods
#define DOZE_AFTER_MS (15UL * 60 * 1000)
#define NAP_MS        (3UL * 60 * 1000)
enum Scene { SC_NONE, SC_WALKIN, SC_SIT, SC_NAP, SC_WALKOUT, SC_NIGHT };
Scene scene = SC_NONE;
bool sceneNap = false, dozeNapDone = false, isNight = false;
int sceneX = -80;
uint32_t sceneUntil = 0, nextSceneFrame = 0, sceneFrame = 0, nextWalkBy = 0;
RobotMode lastRobotMode = ROBOT_IDLE;

int casperRestX() { return uiSceneRight() - 82; }

void endScene() {
  scene = SC_NONE;
  uiSceneClear();
  uiWeather(W);
}

void startScene(bool nap) {
  uiSceneClear();
  scene = SC_WALKIN; sceneNap = nap; sceneX = -80; nextSceneFrame = 0;
}

void startNight() {
  uiSceneClear();
  scene = SC_NIGHT; sceneX = casperRestX(); nextSceneFrame = 0; sceneFrame = 0;
}

void tickScene() {
  if (scene == SC_NONE || (int32_t)(millis() - nextSceneFrame) < 0) return;
  int clip = uiSceneRight();
  sceneFrame++;
  switch (scene) {
    case SC_WALKIN:
      sceneX += 4;
      if (sceneX >= casperRestX()) {
        sceneX = casperRestX();
        scene = sceneNap ? SC_NAP : SC_SIT;
        sceneFrame = 0;
        sceneUntil = millis() + (sceneNap ? NAP_MS : 7000);
        nextSceneFrame = millis();
        return;
      }
      uiCasper(sceneFrame & 1 ? CF_WALK1 : CF_WALK2, sceneX, CASPER_SCENE_Y, false, 4, 0, clip);
      nextSceneFrame = millis() + 110;
      break;
    case SC_SIT:
      uiCasper(sceneFrame & 1 ? CF_SIT1 : CF_SIT2, sceneX, CASPER_SCENE_Y, false, 0, 0, clip);
      nextSceneFrame = millis() + 350;
      if ((int32_t)(millis() - sceneUntil) >= 0) scene = SC_WALKOUT;
      break;
    case SC_NAP:
    case SC_NIGHT: {
      static uint32_t zt = 0;
      if (sceneFrame % 12 == 1) uiCasper((sceneFrame / 12) & 1 ? CF_SLEEP1 : CF_SLEEP2, sceneX, CASPER_SCENE_Y, false, 0, 0, clip);
      uiCasperZ(sceneX, zt++);
      nextSceneFrame = millis() + 120;
      if (scene == SC_NAP && (int32_t)(millis() - sceneUntil) >= 0) { uiSceneClear(); scene = SC_WALKOUT; }
      break;
    }
    case SC_WALKOUT:
      sceneX -= 4;
      if (sceneX <= -80) { endScene(); return; }
      uiCasper(sceneFrame & 1 ? CF_WALK1 : CF_WALK2, sceneX, CASPER_SCENE_Y, true, 0, 4, clip);
      nextSceneFrame = millis() + 110;
      break;
    default: break;
  }
}

void handleCasper() {   // manual trigger for testing: /casper?do=walk|nap|night|off
  String d = server.arg("do");
  if (view != V_CLOCK || !timeValid) { server.send(409, "text/plain", "clock not showing"); return; }
  if (scene != SC_NONE) endScene();
  if (d == "walk") startScene(false);
  else if (d == "nap") startScene(true);
  else if (d == "night") startNight();
  server.send(200, "text/plain", "OK");
}

bool fetchWeather() {
  if (!X.locSet) return false;
  char url[320];
  snprintf_P(url, sizeof url,
             PSTR("http://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f"
                  "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
                  "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1"),
             S.lat, S.lon);
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(6000);
  http.useHTTP10(true);    // no chunked encoding
  if (!http.begin(client, url)) return false;
  bool ok = false;
  if (http.GET() == 200) {
    String body = http.getString();
    JsonDocument doc;
    if (!deserializeJson(doc, body) && doc["current"]["temperature_2m"].is<float>()) {
      JsonObject c = doc["current"];
      W.temp = c["temperature_2m"];
      W.hum = c["relative_humidity_2m"] | 0;
      W.code = c["weather_code"] | -1;
      W.wind = c["wind_speed_10m"] | 0.0f;
      W.day = (c["is_day"] | 1) == 1;
      W.tmax = doc["daily"]["temperature_2m_max"][0] | W.temp;
      W.tmin = doc["daily"]["temperature_2m_min"][0] | W.temp;
      W.ok = true;
      ok = true;
      int32_t off = doc["utc_offset_seconds"] | X.tzoff;   // timezone follows the location (DST included)
      if (off != X.tzoff) { X.tzoff = off; saveExt(); configTime(X.tzoff, 0, "pool.ntp.org", "time.google.com"); }
    }
  }
  http.end();
  return ok;
}

// Claude status from the local /state endpoint or from the hub (MQTT)
bool applyState(const String &s, const String &p, const String &d, const String &f) {
  lastStateMs = millis();
  bool busyCard = view == V_MSG || view == V_PAIR;   // a message/pairing card is up
  if (s == "idle" || s == "working") {
    robot = s == "working" ? ROBOT_WORKING : ROBOT_IDLE;
    if (view == V_NEEDS || view == V_DONE) { view = V_CLOCK; dirty = true; }
  } else if (s == "needs" || s == "done") {
    View nv = s == "needs" ? V_NEEDS : V_DONE;
    if (nv == V_DONE && busyCard) { robot = ROBOT_IDLE; return true; }   // don't cover a message with DONE
    if (nv != view || p != cardP || d != cardD || f != cardF) {
      cardP = p; cardD = d; cardF = f; view = nv; dirty = true;
    }
    if (nv == V_DONE) doneUntil = millis() + 15000;   // falls back to clock on its own
    robot = ROBOT_IDLE;
  } else {
    return false;
  }
  return true;
}

void handleState() {
  if (!applyState(server.arg("s"), server.arg("p"), server.arg("d"), server.arg("f"))) {
    server.send(400, "text/plain", "s must be idle|working|needs|done");
    return;
  }
  server.send(200, "text/plain", "OK");
}

// ===================================================================== hub ===
// One HTTPS hello at boot (secret, pairing, MQTT endpoint + broker key), then one MQTT/TLS link.
enum HubState { HUB_OFF, HUB_HELLO, HUB_MQTT, HUB_FORGOTTEN };
HubState hubState = HUB_OFF;
char chipId[16];
String mqttHost, pubkeyPem, pairCode, hubOwner;
uint16_t mqttPort = 0;
bool hubPaired = false;
uint32_t nextHello = 0, nextMqtt = 0, mqttBackoff = 5000, nextStatus = 0, pairUntil = 0, msgUntil = 0, unreadUntil = 0;
BearSSL::WiFiClientSecure *mqttNet = nullptr;
BearSSL::PublicKey *brokerKey = nullptr;
PubSubClient mqtt;
String pendingPack, pendingPackUrl, pendingPackMd5, pendingOtaUrl, otaResult;
// current message
String mFrom, mText, mWhen;
String nTitle, nText, nSrc, nxText;
int nIcon = -1;
uint16_t nColor = 0;
uint32_t noteUntil = 0, nxAt = 0, drawUntil = 0;
bool nxLeft = false, nxMusic = false, wifiScanForHub = false, wifiReport = false;
uint16_t drawId = 0;
String drawFrom;
bool mPartner = false;
int mReact = -1;

String hubBase() {   // "https://host" from whatever the user typed
  String h = X.host;
  h.trim();
  if (h.startsWith("https://")) h = h.substring(8);
  if (h.startsWith("http://")) h = h.substring(7);
  while (h.endsWith("/")) h.remove(h.length() - 1);
  return h;
}

bool hubHello() {
  String host = hubBase();
  if (!host.length()) return false;
  BearSSL::WiFiClientSecure c;
  c.setInsecure();                       // the broker key we get back is pinned for MQTT
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(c, "https://" + host + "/api/device/hello")) return false;
  http.addHeader("Content-Type", "application/json");
  String body = String("{\"chip\":\"") + chipId + "\",\"fw\":\"" FW_VERSION "\",\"secret\":\"" + X.secret + "\"}";
  int code = http.POST(body);
  if (code == 403) { http.end(); hubState = HUB_FORGOTTEN; return false; }
  if (code != 200) { http.end(); return false; }
  String r = http.getString();
  http.end();
  JsonDocument d;
  if (deserializeJson(d, r)) return false;
  const char *sec = d["secret"] | "";
  if (sec[0]) { strncpy(X.secret, sec, 43); X.secret[43] = 0; saveExt(); }
  mqttHost = (const char *)(d["mqtt"]["host"] | "");
  mqttPort = d["mqtt"]["port"] | 0;
  pubkeyPem = (const char *)(d["mqtt"]["pubkey"] | "");
  hubPaired = d["paired"] | false;
  pairCode = (const char *)(d["pairCode"] | "");
  hubOwner = (const char *)(d["owner"] | "");
  return mqttHost.length() && mqttPort;
}

String hhmm(uint32_t t) {
  time_t tt = t ? (time_t)t : time(nullptr);
  struct tm m;
  localtime_r(&tt, &m);
  char b[8];
  snprintf(b, sizeof b, "%02d:%02d", m.tm_hour, m.tm_min);
  return b;
}

void applySet(JsonDocument &d);

void refreshNext() {
  char s[40] = "";
  time_t now = time(nullptr);
  if (nxText.length() && now > 1600000000) {
    if (nxMusic) {
      snprintf(s, sizeof s, "%s", nxText.c_str());
    } else if (nxLeft) {
      long mins = ((long)nxAt - (long)now + 59) / 60;
      if (mins >= 60) snprintf_P(s, sizeof s, PSTR("%s \xC2\xB7 %ldh %02ldm"), nxText.c_str(), mins / 60, mins % 60);
      else if (mins > 0) snprintf_P(s, sizeof s, PSTR("%s \xC2\xB7 %ld min"), nxText.c_str(), mins);
      else nxText = "";
    } else if ((long)nxAt > (long)now - 60) {
      struct tm m;
      time_t a = nxAt;
      localtime_r(&a, &m);
      snprintf_P(s, sizeof s, PSTR("%s %02d:%02d"), nxText.c_str(), m.tm_hour, m.tm_min);
    } else nxText = "";
  }
  uiNextMusic = nxMusic && s[0];
  if (!strcmp(s, uiNext)) return;
  strcpy(uiNext, s);
  if (view == V_CLOCK && timeValid && !dirty) {
    struct tm t;
    time_t n = now;
    localtime_r(&n, &t);
    uiClockDate(t.tm_wday, t.tm_mday, t.tm_mon, W);
  }
}

static const uint8_t DRAW_RGB[] PROGMEM = {255, 255, 255, 0, 0, 0, 240, 90, 80, 255, 140, 66, 255, 208, 62, 110, 200, 120,
                                           60, 200, 180, 100, 160, 255, 180, 130, 255, 255, 150, 172, 160, 100, 60, 154, 152, 144};
#define DRAW_COLORS 12

uint16_t drawColor(uint8_t i) {
  if (i >= DRAW_COLORS) i = 0;
  return c565(pgm_read_byte(DRAW_RGB + i * 3), pgm_read_byte(DRAW_RGB + i * 3 + 1), pgm_read_byte(DRAW_RGB + i * 3 + 2));
}

void onDraw(const uint8_t *p, unsigned int len) {
  if (len < 3) return;
  uint8_t op = p[0];
  uint16_t id = (p[1] << 8) | p[2];
  if (op == 1) {
    if (view == V_NEEDS || view == V_PAIR || view == V_MSG) { drawId = 0; return; }
    drawId = id;
    drawFrom = "";
    for (unsigned i = 0; len > 3 && i < p[3] && 4 + i < len; i++) drawFrom += (char)p[4 + i];
    view = V_DRAW;
    dirty = false;
    if (scene != SC_NONE) scene = SC_NONE;
    gFill(0, 0, SCR_W, SCR_H, 0);
    drawUntil = millis() + 120000UL;
    if (drawFrom != F("you")) {
      strncpy(uiUnread, drawFrom.c_str(), sizeof uiUnread - 1);
      uiUnread[sizeof uiUnread - 1] = 0;
      unreadUntil = millis() + 3UL * 3600 * 1000;
    }
    return;
  }
  if (op == 5) {
    if (view == V_DRAW || view == V_MEDIA) { view = V_CLOCK; dirty = true; }
    drawId = 0;
    return;
  }
  if (!drawId || id != drawId || view != V_DRAW) return;
  drawUntil = millis() + 120000UL;
  if (op == 4) { gFill(0, 0, SCR_W, SCR_H, 0); return; }
  if (op == 3) {
    uiDrawFooter((drawFrom == F("you") ? hhmm(0) : "from " + drawFrom + " \xC2\xB7 " + hhmm(0)).c_str());
    uint16_t s = len >= 5 ? (p[3] << 8) | p[4] : 60;
    drawUntil = millis() + (s ? 1000UL * constrain(s, 10, 3600) : 0x7FFFFFFFUL);
    return;
  }
  if (op != 2) return;
  uint16_t c = drawColor(0);
  int w = 3, px = -1, py = -1;
  for (unsigned i = 3; i < len;) {
    if (p[i] == 0xFE) {
      if (i + 1 >= len) break;
      gFill(0, 0, SCR_W, SCR_H, drawColor(p[i + 1]));
      px = py = -1;
      i += 2;
      continue;
    }
    if (p[i] == 0xFF) {
      if (i + 2 >= len) break;
      c = drawColor(p[i + 1]);
      w = constrain(p[i + 2], 1, 24);
      px = py = -1;
      i += 3;
      continue;
    }
    if (i + 1 >= len) break;
    int x = p[i], y = p[i + 1];
    i += 2;
    gLine(px < 0 ? x : px, py < 0 ? y : py, x, y, w, c);
    px = x;
    py = y;
  }
}

File mdFile;
uint16_t mdSeq = 0, mdSecs = 60, mdFrames = 0, mdFrameNo = 0;
uint32_t mdSize = 0, mdGot = 0, mdCrc = 0, mdCalc = 0, mdNext = 0, mdUntil = 0;
bool mdPlaying = false;

static int mdRead(void *ctx, uint8_t *buf, int n) { return ((File *)ctx)->read(buf, n); }
static void mdTick() { yield(); }

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

void mediaClose() {
  if (mdFile) mdFile.close();
  mdPlaying = false;
}

void mediaAck(PGM_P err) {
  char e[8] = "", b[56];
  if (err) strncpy_P(e, err, sizeof e - 1);
  if (err) snprintf_P(b, sizeof b, PSTR("{\"id\":%u,\"ok\":false,\"e\":\"%s\"}"), mdSeq, e);
  else snprintf_P(b, sizeof b, PSTR("{\"id\":%u,\"ok\":true}"), mdSeq);
  mqtt.publish((String(F("desk/")) + chipId + F("/up/media")).c_str(), b);
}

bool mediaStart() {
  if (view == V_NEEDS || view == V_PAIR || view == V_MSG) return false;
  mdFile = LittleFS.open(F("/m.bin"), "r");
  if (!mdFile || !mediaHeader(mdRead, &mdFile, &mdFrames)) { mediaClose(); return false; }
  mdPlaying = true;
  mdFrameNo = 0;
  mdNext = millis();
  mdUntil = millis() + (mdSecs ? 1000UL * mdSecs : 0x7FFFFFFFUL);
  view = V_MEDIA;
  dirty = false;
  if (scene != SC_NONE) scene = SC_NONE;
  if (drawFrom.length() && drawFrom != F("you")) {
    strncpy(uiUnread, drawFrom.c_str(), sizeof uiUnread - 1);
    uiUnread[sizeof uiUnread - 1] = 0;
    unreadUntil = millis() + 3UL * 3600 * 1000;
  }
  return true;
}

void mediaFrame() {
  if (!mdPlaying || (int32_t)(millis() - mdNext) < 0) return;
  if (mdFrameNo >= mdFrames) { mdFile.seek(8); mdFrameNo = 0; }
  MediaFrame f;
  if (!mediaFrameHeader(mdRead, &mdFile, &f) || !mediaDrawFrame(mdRead, &mdFile, f, mdTick)) {
    mediaClose();
    view = V_CLOCK;
    dirty = true;
    return;
  }
  mdFrameNo++;
  mdNext = millis() + f.delay;
  if (mdFrames == 1) {
    mediaClose();
    if (drawFrom.length() && drawFrom != F("you")) uiDrawFooter(("from " + drawFrom + " \xC2\xB7 " + hhmm(0)).c_str());
  }
}

void onMedia(const uint8_t *p, unsigned int len) {
  if (len < 3) return;
  uint8_t op = p[0];
  uint16_t seq = (p[1] << 8) | p[2];
  if (op == 4) {
    mediaClose();
    if (view == V_MEDIA) { view = V_CLOCK; dirty = true; }
    return;
  }
  if (op == 1) {
    if (len < 14) return;
    mediaClose();
    mdSeq = seq;
    mdSize = be32(p + 3);
    mdCrc = be32(p + 7);
    mdSecs = (p[11] << 8) | p[12];
    if (mdSecs) mdSecs = constrain(mdSecs, 10, 3600);
    drawFrom = "";
    for (unsigned i = 0; i < p[13] && 14 + i < len; i++) drawFrom += (char)p[14 + i];
    mdGot = mdCalc = 0;
    LittleFS.remove(F("/m.bin"));
    FSInfo fi;
    if (!LittleFS.info(fi) || fi.totalBytes - fi.usedBytes < mdSize + 16384) { mdSize = 0; mediaAck(PSTR("space")); return; }
    mdFile = LittleFS.open(F("/m.bin"), "w");
    if (!mdFile) mediaAck(PSTR("fs"));
    return;
  }
  if (seq != mdSeq || !mdFile || mdPlaying) return;
  if (op == 2 && len >= 7) {
    size_t n = len - 7;
    if (be32(p + 3) != mdGot || mdGot + n > mdSize || mdFile.write(p + 7, n) != n) { mediaClose(); mediaAck(PSTR("order")); return; }
    mdCalc = mediaCrc(mdCalc, p + 7, n);
    mdGot += n;
  } else if (op == 3) {
    mdFile.close();
    if (mdGot != mdSize || mdCalc != mdCrc) { mediaAck(PSTR("crc")); return; }
    mediaAck(nullptr);
    mediaStart();
  }
}

void onMqtt(char *topic, byte *payload, unsigned int len) {
  String t = topic;
  int slash = t.lastIndexOf('/');
  String leaf = t.substring(slash + 1);
  if (t.indexOf("/up/") >= 0) return;
  if (leaf == F("draw")) { onDraw(payload, len); return; }
  if (leaf == F("media")) { onMedia(payload, len); return; }
  if (leaf == "next" && !len) { nxText = ""; refreshNext(); return; }
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  if (leaf == "claude") {
    applyState(d["s"] | "", d["p"] | "", d["d"] | "", d["f"] | "");
  } else if (leaf == "cfg") {
    bool was = hubPaired;
    hubPaired = d["paired"] | false;
    hubOwner = (const char *)(d["owner"] | "");
    const char *hn = d["host"] | "";
    if (!hubPaired) setHostName(nullptr);
    else if (hn[0]) setHostName(hn);
    String code = (const char *)(d["pairCode"] | "");
    if (!hubPaired && code.length() && (code != pairCode || view != V_PAIR)) {
      pairCode = code;
      pairUntil = millis() + 10UL * 60 * 1000;
      if (view != V_NEEDS) { view = V_PAIR; dirty = true; }
    }
    if (hubPaired && !was && view == V_PAIR) { view = V_CLOCK; dirty = true; }
  } else if (leaf == "set") {
    applySet(d);
  } else if (leaf == "cmd") {
    String c = (const char *)(d["cmd"] | "");
    if (c == "reboot") restartAt = millis() + 500;
    else if (c == "ota") pendingOtaUrl = (const char *)(d["url"] | "");
    else if (c == F("seen")) { if (uiUnread[0]) { uiUnread[0] = 0; if (view == V_CLOCK) dirty = true; } }
    else if (c == F("wifi_scan")) { WiFi.scanDelete(); WiFi.scanNetworks(true); wifiScanForHub = true; }
    else if (c == F("wifi_add")) {
      String s = (const char *)(d[F("ssid")] | ""), p = (const char *)(d[F("pass")] | "");
      if (s.length() && s.length() <= 32 && p.length() <= 64) { addNet(s, p); wifiMulti.addAP(s.c_str(), p.c_str()); }
      wifiReport = true;
    } else if (c == F("wifi_del")) {
      const char *s = d[F("ssid")] | "";
      for (int i = 0; i < NET_MAX; i++) if (NS.n[i].ssid[0] && !strcmp(NS.n[i].ssid, s)) { delNet(i); break; }
      wifiReport = true;
    }
  } else if (leaf == F("card")) {
    String ti = (const char *)(d[F("title")] | ""), tx = (const char *)(d[F("text")] | "");
    if (!ti.length() && !tx.length()) return;
    if (view != V_CLOCK && view != V_DONE && view != V_NOTE) return;
    nTitle = ti; nText = tx;
    nSrc = (const char *)(d[F("src")] | "");
    nIcon = uiReactionIndex(d[F("icon")] | "");
    nColor = uiColor(d[F("color")] | "");
    noteUntil = millis() + 1000UL * constrain((int)(d[F("secs")] | 15), 3, 300);
    view = V_NOTE; dirty = true;
    if (scene != SC_NONE) scene = SC_NONE;
  } else if (leaf == F("next")) {
    nxText = (const char *)(d[F("text")] | "");
    nxAt = d[F("at")] | 0;
    nxLeft = d[F("left")] | false;
    nxMusic = String((const char *)(d[F("k")] | "")) == F("music");
    refreshNext();
  } else if (leaf == "msg") {
    uint32_t id = d["id"] | 0;
    if (!id || id <= X.lastMsg) return;          // already shown (retained copy after reconnect)
    X.lastMsg = id;
    saveExt();
    mFrom = (const char *)(d["name"] | (d["from"] | "someone"));
    mPartner = String((const char *)(d["rel"] | "")) == "partner";
    mText = (const char *)(d["text"] | "");
    mWhen = hhmm(d["t"] | 0);
    mReact = String((const char *)(d["kind"] | "")) == "reaction" ? uiReactionIndex(d["reaction"] | "") : -1;
    if (mReact < 0 && !mText.length()) return;
    strncpy(uiUnread, mFrom.c_str(), sizeof uiUnread - 1);
    uiUnread[sizeof uiUnread - 1] = 0;
    unreadUntil = millis() + 3UL * 3600 * 1000;
    msgUntil = millis() + 3UL * 60 * 1000;
    if (view != V_NEEDS) { view = V_MSG; dirty = true; }
    if (scene != SC_NONE) scene = SC_NONE;
  }
}

// ---- packs: downloaded reaction sets in LittleFS (/packs/<id>.bin, format in docs/PROTOCOL.md §9)
struct PackEnt { char name[16]; uint8_t w, h; uint16_t _p; uint32_t off; uint16_t pal[16]; };
PackEnt packEnt[12];
int packCount = 0;
File packFile;
static const char *const PACK_ORDER[] = {"wave", "thumbs", "laugh", "coffee", "fire", "heart", "hug", "kiss", "goodnight", "missyou"};

bool packEntry(int idx, bool small, EmojiHdr &h) {
  if (!packCount || idx < 0 || idx > 9) return false;
  char want[16];
  snprintf(want, sizeof want, small ? "%s_s" : "%s", PACK_ORDER[idx]);
  for (int i = 0; i < packCount; i++)
    if (!strcmp(packEnt[i].name, want)) {
      h.w = packEnt[i].w; h.h = packEnt[i].h; h.off = packEnt[i].off;
      memcpy(h.pal, packEnt[i].pal, sizeof h.pal);
      return true;
    }
  return false;
}

void packRead(uint32_t off, uint8_t *buf, int n) {
  if (!packFile || !packFile.seek(off) || packFile.read(buf, n) != (size_t)n) memset(buf, 0, n);
}

void loadPack() {
  packCount = 0;
  if (packFile) packFile.close();
  uiPackEntry = nullptr; uiPackRead = nullptr;
  if (!strcmp(X.pack, "pixel")) return;
  packFile = LittleFS.open(String("/packs/") + X.pack + ".bin", "r");
  if (!packFile) return;
  uint8_t hdr[8];
  if (packFile.read(hdr, 8) != 8 || memcmp(hdr, "CDPK", 4) || hdr[4] != 1) { packFile.close(); return; }
  int n = hdr[5] > 12 ? 12 : hdr[5];
  if (packFile.read((uint8_t *)packEnt, n * sizeof(PackEnt)) != n * sizeof(PackEnt)) { packFile.close(); return; }
  for (int i = 0; i < n; i++) packEnt[i].name[15] = 0;
  packCount = n;
  uiPackEntry = packEntry; uiPackRead = packRead;
}

String installedPacks() {
  String j = "[\"pixel\"";
  Dir d = LittleFS.openDir("/packs");
  while (d.next()) {
    String n = d.fileName();
    if (n.endsWith(".bin")) j += ",\"" + n.substring(0, n.length() - 4) + "\"";
  }
  return j + "]";
}

void hubWifi(bool withScan) {
  String j = F("{\"saved\":[");
  bool first = true;
  for (int i = 0; i < NET_MAX; i++)
    if (NS.n[i].ssid[0]) { if (!first) j += ','; j += jsonStr(NS.n[i].ssid); first = false; }
  j += F("],\"current\":");
  j += jsonStr(WiFi.SSID().c_str());
  j += F(",\"rssi\":");
  j += WiFi.RSSI();
  int n = withScan ? WiFi.scanComplete() : -1;
  if (n >= 0) {
    j += F(",\"visible\":[");
    first = true;
    for (int i = 0; i < n && j.length() < 820; i++) {
      if (!scanBest(i)) continue;
      if (!first) j += ',';
      first = false;
      j += F("{\"s\":");
      j += jsonStr(WiFi.SSID(i).c_str());
      j += F(",\"r\":");
      j += WiFi.RSSI(i);
      j += F(",\"o\":");
      j += WiFi.encryptionType(i) == ENC_TYPE_NONE ? '1' : '0';
      j += '}';
    }
    j += ']';
    WiFi.scanDelete();
  }
  j += '}';
  mqtt.publish((String("desk/") + chipId + "/up/wifi").c_str(), j.c_str());
}

void hubSettings() {   // up/settings
  String j = "{\"rev\":" + String(X.setRev) + ",\"layout\":" + String(S.layout) + ",\"soft\":" + String(S.soft) +
             ",\"casper\":" + String(X.casper) + ",\"pack\":\"" + X.pack + "\",\"bday\":" + String(S.bday) +
             ",\"bnight\":" + String(S.bnight) + ",\"nstart\":" + String(S.nstart) + ",\"nend\":" + String(S.nend) +
             ",\"lat\":" + String(S.lat, 4) + ",\"lon\":" + String(S.lon, 4) + ",\"packs\":" + installedPacks() + "}";
  mqtt.publish((String("desk/") + chipId + "/up/settings").c_str(), j.c_str());
}

void applySet(JsonDocument &d) {
  uint32_t rev = d["rev"] | 0;
  if (!rev || rev <= X.setRev) return;     // older than what we have (e.g. retained copy after a local edit)
  X.setRev = rev;
  if (d["layout"].is<int>()) { S.layout = d["layout"] ? 1 : 0; uiLayout = S.layout; }
  if (d["soft"].is<int>()) { S.soft = d["soft"] ? 1 : 0; uiSetSoft(S.soft); }
  if (d["casper"].is<int>()) X.casper = d["casper"] ? 1 : 0;
  if (d["bday"].is<int>()) S.bday = constrain((int)d["bday"], 0, 100);
  if (d["bnight"].is<int>()) S.bnight = constrain((int)d["bnight"], 0, 100);
  if (d["nstart"].is<int>()) S.nstart = constrain((int)d["nstart"], 0, 23);
  if (d["nend"].is<int>()) S.nend = constrain((int)d["nend"], 0, 23);
  if (d["lat"].is<float>() && d["lon"].is<float>()) {
    float la = d["lat"], lo = d["lon"];
    if (la != S.lat || lo != S.lon) { S.lat = la; S.lon = lo; X.locSet = (la != 0.0f || lo != 0.0f); uiLocationSet = X.locSet; W.ok = false; nextWeather = 0; }
  }
  const char *pk = d["pack"] | "";
  if (pk[0] && strcmp(pk, X.pack)) {
    if (!strcmp(pk, "pixel")) { strcpy(X.pack, "pixel"); loadPack(); }
    else if (LittleFS.exists(String("/packs/") + pk + ".bin")) { strncpy(X.pack, pk, 15); X.pack[15] = 0; loadPack(); }
    else { pendingPack = pk; pendingPackUrl = (const char *)(d["packUrl"] | ""); pendingPackMd5 = (const char *)(d["packMd5"] | ""); }
  }
  saveSettings();
  saveExt();
  nextBrt = 0;
  dirty = true;
  settingsDirty = true;
}

void mqttStop() { mqtt.disconnect(); if (mqttNet) mqttNet->stop(); }

bool downloadPack() {   // MQTT is stopped by the caller (one TLS session at a time)
  uiMessage("DOWNLOADING", "reaction pack", pendingPack.c_str(), "", COL_TEAL);
  BearSSL::WiFiClientSecure c;
  c.setInsecure();
  HTTPClient http;
  http.setTimeout(15000);
  bool ok = false;
  if (http.begin(c, pendingPackUrl) && http.GET() == 200) {
    LittleFS.mkdir("/packs");
    File f = LittleFS.open("/packs/tmp.bin", "w");
    MD5Builder md5; md5.begin();
    WiFiClient *st = http.getStreamPtr();
    int left = http.getSize();
    uint8_t buf[512];
    uint32_t t0 = millis();
    while (f && http.connected() && (left > 0 || left == -1) && millis() - t0 < 30000) {
      size_t a = st->available();
      if (!a) { delay(5); continue; }
      int n = st->readBytes(buf, a > sizeof buf ? sizeof buf : a);
      f.write(buf, n); md5.add(buf, n);
      if (left > 0) left -= n;
    }
    if (f) f.close();
    md5.calculate();
    ok = left == 0 && (!pendingPackMd5.length() || md5.toString() == pendingPackMd5);
  }
  http.end();
  if (ok) {
    Dir d = LittleFS.openDir("/packs");             // keep only the pack in use
    while (d.next()) if (d.fileName() != "tmp.bin") LittleFS.remove("/packs/" + d.fileName());
    LittleFS.rename("/packs/tmp.bin", "/packs/" + pendingPack + ".bin");
    strncpy(X.pack, pendingPack.c_str(), 15); X.pack[15] = 0;
    saveExt();
    loadPack();
  } else {
    LittleFS.remove("/packs/tmp.bin");
  }
  pendingPack = "";
  settingsDirty = true;
  dirty = true;
  return ok;
}

void doOta() {
  uiMessage("UPDATING", "installing new firmware", "don't unplug", "", COL_ORANGE);
  BearSSL::WiFiClientSecure c;
  c.setInsecure();
  ESPhttpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return r = ESPhttpUpdate.update(c, pendingOtaUrl, FW_VERSION);   // reboots on success
  otaResult = r == HTTP_UPDATE_NO_UPDATES ? "ok: already up to date" : "failed: " + ESPhttpUpdate.getLastErrorString();
  pendingOtaUrl = "";
  dirty = true;
}

#define PEND_SLOT 80
#define PEND_MAGIC 0x50454E44
struct Pending { uint32_t magic; uint8_t kind, _pad[3]; char pack[16]; char md5[36]; char url[128]; };

void queueDownload(uint8_t kind, const String &url) {
  Pending p;
  memset(&p, 0, sizeof p);
  p.magic = PEND_MAGIC;
  p.kind = kind;
  strncpy(p.url, url.c_str(), sizeof p.url - 1);
  strncpy(p.pack, pendingPack.c_str(), sizeof p.pack - 1);
  strncpy(p.md5, pendingPackMd5.c_str(), sizeof p.md5 - 1);
  ESP.rtcUserMemoryWrite(PEND_SLOT, (uint32_t *)&p, sizeof p);
}

void runPendingDownload() {
  Pending p;
  ESP.rtcUserMemoryRead(PEND_SLOT, (uint32_t *)&p, sizeof p);
  if (p.magic != PEND_MAGIC) return;
  uint32_t zero = 0;
  ESP.rtcUserMemoryWrite(PEND_SLOT, &zero, sizeof zero);
  p.url[sizeof p.url - 1] = p.pack[sizeof p.pack - 1] = p.md5[sizeof p.md5 - 1] = 0;
  if (p.kind == 1) { pendingOtaUrl = p.url; doOta(); }
  else if (p.kind == 2) { pendingPack = p.pack; pendingPackUrl = p.url; pendingPackMd5 = p.md5; downloadPack(); }
}

void hubStatus() {
  char b[320];
  snprintf_P(b, sizeof b, PSTR("{\"fw\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"heap\":%u,\"maxblk\":%u,\"reset\":\"%s\",\"up\":%lu%s%s%s}"),
             FW_VERSION, WiFi.localIP().toString().c_str(), WiFi.RSSI(), ESP.getFreeHeap(), ESP.getMaxFreeBlockSize(),
             ESP.getResetReason().c_str(), millis() / 1000,
             otaResult.length() ? ",\"ota\":\"" : "", otaResult.c_str(), otaResult.length() ? "\"" : "");
  mqtt.publish((String("desk/") + chipId + "/up/status").c_str(), b);
}

void hubLoop() {
  if (restartAt || !X.host[0] || hubState == HUB_FORGOTTEN || WiFi.status() != WL_CONNECTED) return;
  if (hubState == HUB_OFF || hubState == HUB_HELLO) {
    if ((int32_t)(millis() - nextHello) < 0) return;
    if (!hubHello()) { nextHello = millis() + 60000; hubState = HUB_HELLO; return; }
    if (!mqttNet) {
      mqttNet = new BearSSL::WiFiClientSecure();
      mqttNet->setBufferSizes(2048, 512);
      if (pubkeyPem.length()) { brokerKey = new BearSSL::PublicKey(pubkeyPem.c_str()); mqttNet->setKnownKey(brokerKey); }
      else mqttNet->setInsecure();
      mqtt.setClient(*mqttNet);
      mqtt.setBufferSize(1024);
      mqtt.setKeepAlive(60);
      mqtt.setSocketTimeout(10);
      mqtt.setCallback(onMqtt);
    }
    mqtt.setServer(mqttHost.c_str(), mqttPort);
    if (!hubPaired && pairCode.length()) { pairUntil = millis() + 10UL * 60 * 1000; view = V_PAIR; dirty = true; }
    hubState = HUB_MQTT;
    nextMqtt = 0;
  }
  if (pendingOtaUrl.length() || (pendingPack.length() && pendingPackUrl.length())) {
    bool ota = pendingOtaUrl.length();
    const String &url = ota ? pendingOtaUrl : pendingPackUrl;
    mqttStop();                               // free the TLS session's RAM for the download
    if (url.length() < sizeof(Pending::url)) {
      queueDownload(ota ? 1 : 2, url);
      uiMessage(ota ? "UPDATING" : "DOWNLOADING", "restarting to make room", "", "", COL_TEAL);
      restartAt = millis() + 300;
      return;
    }
    if (ota) doOta(); else downloadPack();
    nextMqtt = 0; nextStatus = 0;
    return;
  }
  if (mqtt.connected()) {
    netOkAt = millis() | 1;
    mqtt.loop();
    if ((int32_t)(millis() - nextStatus) >= 0) { hubStatus(); nextStatus = millis() + 10UL * 60 * 1000; }
    if (settingsDirty) { hubSettings(); settingsDirty = false; }
    if (wifiScanForHub && WiFi.scanComplete() >= 0) { wifiScanForHub = false; wifiReport = false; hubWifi(true); }
    else if (wifiReport && !wifiScanForHub) { wifiReport = false; hubWifi(false); }
    return;
  }
  if ((int32_t)(millis() - nextMqtt) < 0) return;
  if (mqtt.connect(chipId, chipId, X.secret)) {
    mqtt.subscribe((String("desk/") + chipId + "/#").c_str(), 1);
    mqttBackoff = 5000;
    nextStatus = 0;
    settingsDirty = true;
    wifiReport = true;
  } else {
    int st = mqtt.state();
    if (st == MQTT_CONNECT_BAD_CREDENTIALS || st == MQTT_CONNECT_UNAUTHORIZED) {
      hubState = HUB_OFF;                    // desk was forgotten on the hub: hello again (re-registers)
      nextHello = millis() + 3000;
      return;
    }
    nextMqtt = millis() + mqttBackoff;
    mqttBackoff = min<uint32_t>(mqttBackoff * 2, 120000);
  }
}

const char *hubStateText() {
  if (!X.host[0]) return "not set";
  switch (hubState) {
    case HUB_FORGOTTEN: return "this desk was removed on the hub - clear the hub address and set it again";
    case HUB_HELLO: return "can't reach the hub (retrying)";
    case HUB_MQTT: return mqtt.connected() ? (hubPaired ? "connected" : "connected, waiting for pairing") : "connecting...";
    default: return "starting";
  }
}

static const char ROOT_PAGE[] PROGMEM =
    "<h2>claude-desk</h2><p class=m>fw " FW_VERSION " &middot; ~host~.local &middot; ~ip~ &middot; ~temp~</p>"
    "<h3>Location</h3><input id=q placeholder='Search a city'><div id=r class=m></div>"
    "<form action=/set><label>Latitude</label><input id=lat name=lat value='~lat~'>"
    "<label>Longitude</label><input id=lon name=lon value='~lon~'>"
    "<label>Brightness, day (%)</label><input name=bday type=number min=0 max=100 value=~bday~>"
    "<label>Brightness, night (%)</label><input name=bnight type=number min=0 max=100 value=~bnight~>"
    "<label>Night starts (hour)</label><input name=ns type=number min=0 max=23 value=~ns~>"
    "<label>Night ends (hour)</label><input name=ne type=number min=0 max=23 value=~ne~>"
    "<label>Layout</label><select name=layout><option value=1~layB~>B: tall clock</option><option value=0~layA~>A: clean</option></select>"
    "<label>Colours</label><select name=soft><option value=1~soft1~>Soft</option><option value=0~soft0~>Vivid</option></select>"
    "<label><input type=checkbox name=casper value=1 style='width:auto'~casper~> Casper the dog visits</label>"
    "<input type=hidden name=casper0 value=1>"
    "<p class=m>Reaction style: <b>~pack~</b> (change it in the hub app)</p>"
    "<h3>Friends hub</h3><label>Hub address</label><input name=hub placeholder='your-hub.up.railway.app' value='~hub~'>"
    "<p class=m>Status: ~status~ &middot; id ~chip~</p>"
    "<button>Save</button></form><p><a href=/wifi>Wi-Fi networks</a> &middot; <a href=/update>Firmware update</a> &middot; "
    "<a href=/reboot>Reboot</a> &middot; <a href=/info>Info</a></p>"
    "<script>let t;q.oninput=()=>{clearTimeout(t);t=setTimeout(async()=>{if(q.value.length<2)return;"
    "let j=await(await fetch('https://geocoding-api.open-meteo.com/v1/search?count=5&name='+encodeURIComponent(q.value))).json();"
    "r.innerHTML='';(j.results||[]).forEach(c=>{let a=document.createElement('a');a.href='#';a.style.display='block';"
    "a.textContent=c.name+', '+(c.admin1||'')+' '+(c.country||'');a.onclick=e=>{e.preventDefault();lat.value=c.latitude.toFixed(4);"
    "lon.value=c.longitude.toFixed(4);r.textContent='Picked '+a.textContent+' - press Save';};r.appendChild(a);});},400);};</script>";

String rootVal(const char *k) {
  const char *sel = " selected";
  if (!strcmp(k, "host")) return hostName;
  if (!strcmp(k, "ip")) return WiFi.localIP().toString();
  if (!strcmp(k, "temp")) return W.ok ? String(W.temp, 1) + "&deg;C" : String("weather pending");
  if (!strcmp(k, "lat")) return String(S.lat, 4);
  if (!strcmp(k, "lon")) return String(S.lon, 4);
  if (!strcmp(k, "bday")) return String(S.bday);
  if (!strcmp(k, "bnight")) return String(S.bnight);
  if (!strcmp(k, "ns")) return String(S.nstart);
  if (!strcmp(k, "ne")) return String(S.nend);
  if (!strcmp(k, "layB")) return S.layout ? sel : "";
  if (!strcmp(k, "layA")) return S.layout ? "" : sel;
  if (!strcmp(k, "soft1")) return S.soft ? sel : "";
  if (!strcmp(k, "soft0")) return S.soft ? "" : sel;
  if (!strcmp(k, "casper")) return X.casper ? " checked" : "";
  if (!strcmp(k, "pack")) return htmlEsc(X.pack);
  if (!strcmp(k, "hub")) return htmlEsc(X.host);
  if (!strcmp(k, "status")) return htmlEsc(hubStateText()) + (hubOwner.length() ? " &middot; owner " + htmlEsc(hubOwner) : String());
  if (!strcmp(k, "chip")) return chipId;
  return String();
}

void handleRoot() { sendPage(ROOT_PAGE, rootVal); }

void handleSet() {
  if (server.hasArg("lat")) S.lat = server.arg("lat").toFloat();
  if (server.hasArg("lon")) S.lon = server.arg("lon").toFloat();
  if (server.hasArg("lat") || server.hasArg("lon")) { X.locSet = (S.lat != 0.0f || S.lon != 0.0f); uiLocationSet = X.locSet; W.ok = false; dirty = true; }
  if (server.hasArg("casper0")) { X.casper = server.hasArg("casper") ? 1 : 0; dirty = true; }
  else if (server.hasArg("casper")) { X.casper = server.arg("casper").toInt() ? 1 : 0; dirty = true; }
  if (server.hasArg("hub")) {
    String hb = server.arg("hub"); hb.trim();
    if (hb != X.host) {                       // new hub: start fresh there, reboot to connect
      strncpy(X.host, hb.c_str(), 63); X.host[63] = 0;
      X.secret[0] = 0; X.lastMsg = 0;
      restartAt = millis() + 1500;
    }
  }
  saveExt();
  settingsDirty = true;
  if (server.hasArg("bday")) S.bday = constrain(server.arg("bday").toInt(), 0, 100);
  if (server.hasArg("bnight")) S.bnight = constrain(server.arg("bnight").toInt(), 0, 100);
  if (server.hasArg("ns")) S.nstart = constrain(server.arg("ns").toInt(), 0, 23);
  if (server.hasArg("ne")) S.nend = constrain(server.arg("ne").toInt(), 0, 23);
  if (server.hasArg("sharp")) { S.sharp = server.arg("sharp").toInt() ? 1 : 0; gSharp = S.sharp; dirty = true; }
  if (server.hasArg("gtab") || server.hasArg("vcom")) {
    if (server.hasArg("gtab")) S.gtab = constrain(server.arg("gtab").toInt(), 0, 2);
    if (server.hasArg("vcom")) S.vcom = constrain((int)strtol(server.arg("vcom").c_str(), nullptr, 0), 0, 0x3F);
    gfxPanelTune(S.gtab, S.vcom);
  }
  if (server.hasArg("soft")) { S.soft = server.arg("soft").toInt() ? 1 : 0; uiSetSoft(S.soft); dirty = true; }
  if (server.hasArg("gamma")) { S.gamma = constrain(server.arg("gamma").toInt(), 1, 4); gfxGamma(S.gamma); }
  if (server.hasArg("pwm")) {
    S.pwm = constrain(server.arg("pwm").toInt(), 100, 40000);
    analogWriteFreq(S.pwm); int b = curBrightness < 0 ? S.bday : curBrightness; curBrightness = -1; setBrightness(b);
  }
  if (server.hasArg("layout")) { S.layout = server.arg("layout").toInt() ? 1 : 0; uiLayout = S.layout; dirty = true; }
  saveSettings();
  nextWeather = 0; nextBrt = 0;
  server.sendHeader("Location", "/");
  server.send(303);
}

void handleInfo() {
  String j = "{";
  infoCommon(j);
  j += ",\"soft\":" + String(S.soft) + ",\"sharp\":" + String(S.sharp) + ",\"gtab\":" + String(S.gtab) + ",\"vcom\":" + String(S.vcom);
  j += ",\"pwm\":" + String(S.pwm) + ",\"gamma\":" + String(S.gamma) + ",\"brt\":" + String(curBrightness);
  j += ",\"hub\":\"" + String(hubStateText()) + "\",\"paired\":" + String(hubPaired ? 1 : 0) + ",\"chip\":\"" + chipId + "\"";
  j += ",\"scene\":" + String((int)scene) + ",\"night\":" + String(isNight ? 1 : 0);
  j += ",\"view\":" + String((int)view) + ",\"robot\":" + String((int)robot);
  j += ",\"weather\":{\"ok\":" + String(W.ok ? "true" : "false") + ",\"temp\":" + String(W.temp, 1) +
       ",\"hum\":" + String(W.hum) + ",\"code\":" + String(W.code) + "}}";
  server.send(200, "application/json", j);
}

bool nowTm(struct tm &t) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false;
  localtime_r(&now, &t);
  return true;
}

#define LOW_MEM_BLOCK 3000
#define LOW_MEM_FOR_MS (2UL * 60 * 1000)
#define LOW_MEM_MIN_UPTIME_MS (30UL * 60 * 1000)

void lowMemoryGuard() {
  static uint32_t lowSince = 0, nextCheck = 0;
  if ((int32_t)(millis() - nextCheck) < 0) return;
  nextCheck = millis() + 10000;
  if (ESP.getMaxFreeBlockSize() >= LOW_MEM_BLOCK) { lowSince = 0; return; }
  if (!lowSince) lowSince = millis() | 1;
  if (millis() - lowSince > LOW_MEM_FOR_MS && millis() > LOW_MEM_MIN_UPTIME_MS && !restartAt) restartAt = millis() + 100;
}

void loopNormal() {
  struct tm t;
  bool tv = nowTm(t);
  if (tv != timeValid) { timeValid = tv; dirty = true; }
  lowMemoryGuard();
  hubLoop();
  if (uiUnread[0] && (int32_t)(millis() - unreadUntil) >= 0) { uiUnread[0] = 0; if (view == V_CLOCK) dirty = true; }
  if (view == V_MSG && (int32_t)(millis() - msgUntil) >= 0) { view = V_CLOCK; dirty = true; }
  if (view == V_NOTE && (int32_t)(millis() - noteUntil) >= 0) { view = V_CLOCK; dirty = true; }
  if (view == V_DRAW && (int32_t)(millis() - drawUntil) >= 0) { view = V_CLOCK; dirty = true; }
  if (view == V_MEDIA && (int32_t)(millis() - mdUntil) >= 0) { mediaClose(); view = V_CLOCK; dirty = true; }
  if (view != V_MEDIA && mdPlaying) mediaClose();
  if (view == V_PAIR && (hubPaired || (int32_t)(millis() - pairUntil) >= 0)) { view = V_CLOCK; dirty = true; }

  if (WiFi.status() == WL_CONNECTED && (int32_t)(millis() - nextWeather) >= 0) {
    bool ok = fetchWeather();
    if (ok) netOkAt = millis() | 1;
    nextWeather = millis() + (ok ? 15UL * 60 * 1000 : 60UL * 1000);
    if (ok && view == V_CLOCK && timeValid && !dirty) {
      if (scene == SC_NONE) uiWeather(W);
      uiClockDate(t.tm_wday, t.tm_mday, t.tm_mon, W);
    }
  }

  // card timeouts / stale states
  if (view == V_DONE && (int32_t)(millis() - doneUntil) >= 0) { view = V_CLOCK; dirty = true; }
  if (view == V_NEEDS && millis() - lastStateMs > 2UL * 3600 * 1000) { view = V_CLOCK; dirty = true; }
  if (robot == ROBOT_WORKING && millis() - lastStateMs > 30UL * 60 * 1000) robot = ROBOT_IDLE;

  if (tv) isNight = S.nstart > S.nend ? (t.tm_hour >= S.nstart || t.tm_hour < S.nend)
                                     : (t.tm_hour >= S.nstart && t.tm_hour < S.nend);
  if (tv && (int32_t)(millis() - nextBrt) >= 0) {
    setBrightness(isNight ? S.bnight : S.bday);
    nextBrt = millis() + 30000;
  }

  if (view == V_CLOCK) {
    if (!timeValid) {
      if (dirty) {
        uiMessage("CLAUDE DESK", WiFi.localIP().toString().c_str(), "syncing time...", (String(hostName) + ".local").c_str(), COL_TEAL);
        dirty = false;
      }
      return;
    }
    if (dirty) {
      refreshNext();
      uiClockFull(t.tm_hour, t.tm_min, t.tm_wday, t.tm_mday, t.tm_mon, W);
      lastMin = t.tm_min; lastDay = t.tm_mday; nextFrame = 0; dirty = false;
      scene = SC_NONE;
      if (!nextWalkBy) nextWalkBy = millis() + random(20, 40) * 60000UL;
    } else {
      if (t.tm_min != lastMin) { uiClockTime(t.tm_hour, t.tm_min); lastMin = t.tm_min; refreshNext(); }
      if (t.tm_mday != lastDay) { uiClockDate(t.tm_wday, t.tm_mday, t.tm_mon, W); lastDay = t.tm_mday; }
    }

    // moods + Casper
    bool working = robot == ROBOT_WORKING;
    bool dozing = !working && !isNight && millis() - lastStateMs > DOZE_AFTER_MS && millis() > DOZE_AFTER_MS;
    if (working) {
      if (scene != SC_NONE) endScene();
    } else if (!X.casper) {
      if (scene != SC_NONE) endScene();
    } else if (isNight) {
      if (scene != SC_NIGHT) { if (scene != SC_NONE) endScene(); startNight(); }
    } else {
      if (scene == SC_NIGHT) endScene();
      if (scene == SC_NONE) {
        if (dozing && !dozeNapDone) { startScene(true); dozeNapDone = true; }
        else if ((int32_t)(millis() - nextWalkBy) >= 0) {
          startScene(false);
          nextWalkBy = millis() + random(40, 80) * 60000UL;
        }
      }
    }
    if (!dozing) dozeNapDone = false;
    tickScene();

    RobotMode rm = working ? ROBOT_WORKING : isNight ? ROBOT_SLEEP : scene == SC_SIT ? ROBOT_HAPPY
                 : dozing ? ROBOT_DOZE : ROBOT_IDLE;
    if (rm != lastRobotMode) { lastRobotMode = rm; nextFrame = 0; }
    if ((int32_t)(millis() - nextFrame) >= 0) nextFrame = millis() + uiRobotFrame(rm, frameNo++);
  } else if (view == V_MSG) {
    if (dirty) {
      if (mReact >= 0) uiReactionCard(mFrom.c_str(), mPartner, mReact, mWhen.c_str());
      else uiMessage2(mFrom.c_str(), mPartner, mText.c_str(), mWhen.c_str());
      dirty = false; nextFrame = 0;
    }
    if (mReact >= 0 && (int32_t)(millis() - nextFrame) >= 0) nextFrame = millis() + uiReactionFrame(mReact, frameNo++);
  } else if (view == V_DRAW) {
    dirty = false;
  } else if (view == V_MEDIA) {
    dirty = false;
    mediaFrame();
  } else if (view == V_NOTE) {
    if (dirty) { uiNotice(nSrc.c_str(), nTitle.c_str(), nText.c_str(), nIcon, nColor); dirty = false; nextFrame = 0; }
    if (nIcon >= 0 && (int32_t)(millis() - nextFrame) >= 0) nextFrame = millis() + uiReactionFrame(nIcon, frameNo++);
  } else if (view == V_PAIR) {
    if (dirty) { uiPair(pairCode.c_str(), hubBase().c_str()); dirty = false; }
  } else {
    if (dirty) {
      uiCard(view == V_NEEDS, cardP.c_str(), cardD.c_str(), cardF.c_str());
      dirty = false; nextFrame = 0;
    }
    if (view == V_DONE && X.casper && (int32_t)(millis() - nextFrame) >= 0) {
      uiCardCasper(frameNo++);
      nextFrame = millis() + 260;
    }
  }
}
#endif  // !LOADER

// ================================================================== setup ===
void setup() {
  bootGuard();
#ifndef LOADER
  snprintf(chipId, sizeof chipId, "esp-%06x", ESP.getChipId());
#endif
  pinMode(PIN_BL, OUTPUT);
  analogWriteRange(1023);
  analogWriteFreq(1000);
  setBrightness(0);
  EEPROM.begin(1024);
  loadHostName();
  gfxInit();

#ifdef LOADER
  mode = M_SAFE;
#else
  mode = rtcBoot.count >= 4 ? M_SAFE : M_NORMAL;
  if (mode == M_NORMAL) {
    loadSettings();
    loadExt();
    LittleFSConfig fsc; fsc.setAutoFormat(true); LittleFS.setConfig(fsc);
    if (LittleFS.begin()) loadPack();
    analogWriteFreq(S.pwm);
    gfxGamma(S.gamma);
    gfxPanelTune(S.gtab, S.vcom);
  }
#endif

  uiMessage(mode == M_SAFE ?
#ifdef LOADER
            "LOADER"
#else
            "SAFE MODE"
#endif
            : "CLAUDE DESK", "starting...", "", "", mode == M_SAFE ? COL_ORANGE : COL_TEAL);
#ifndef LOADER
  setBrightness(mode == M_NORMAL ? S.bday : 50);
#else
  setBrightness(50);
#endif

  bool online = connectWifi(25000);
  if (!online) startSetup();
#ifndef LOADER
  if (online && mode == M_NORMAL) runPendingDownload();
#endif

  updater.setup(&server, "/update");
  server.on("/reboot", handleReboot);

  if (mode == M_SETUP) {
    server.on("/", handleSetupRoot);
    server.on("/save", handleSave);
    server.on("/info", handleInfoBasic);
    server.onNotFound([] {
      server.sendHeader("Location", "http://192.168.4.1/");
      server.send(302);
    });
  } else if (mode == M_SAFE) {
    server.on("/", handleSafeRoot);
    server.on("/wifi", handleWifi);
    server.on("/info", handleInfoBasic);
    String ip = WiFi.localIP().toString();
    uiMessage(
#ifdef LOADER
        "LOADER",
#else
        "SAFE MODE",
#endif
        ip.c_str(), "Upload firmware at /update", "", COL_ORANGE);
  }
#ifndef LOADER
  else {
    server.on("/", handleRoot);
    server.on("/state", handleState);
    server.on("/set", handleSet);
    server.on("/info", handleInfo);
    server.on("/casper", handleCasper);
    server.on("/wifi", handleWifi);
    configTime(X.tzoff, 0, "pool.ntp.org", "time.google.com");
    dirty = true;
  }
#endif
  if (mode != M_SETUP) startMdns();
  server.begin();
}

void loop() {
  server.handleClient();
  if (mode == M_SETUP) {
    dns.processNextRequest();
    // credentials were fine after all (e.g. router was rebooting): go back to normal
    static uint32_t connectedSince = 0;
    if (netCount()) wifiRoam();
    if (WiFi.status() == WL_CONNECTED) {
      if (!connectedSince) connectedSince = millis();
      else if (millis() - connectedSince > 5000 && !restartAt) restartAt = millis() + 500;
    } else connectedSince = 0;
  } else {
    MDNS.update();
    static bool wasUp = true;
    wifiRoam();
    bool up = WiFi.status() == WL_CONNECTED;
    if (up && !wasUp) { MDNS.end(); startMdns(); }
    wasUp = up;
  }
  if (!bootCleared && millis() > 60000) bootOk();
  if (restartAt && (int32_t)(millis() - restartAt) >= 0) { delay(100); ESP.restart(); }
#ifndef LOADER
  if (mode == M_NORMAL) loopNormal();
#endif
  delay(5);
}
