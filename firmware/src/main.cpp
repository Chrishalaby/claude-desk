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
#endif

#ifndef FW_VERSION
#define FW_VERSION "1.0.1"
#endif
#define PIN_BL 5
#define HOSTNAME "claude-desk"
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
#define EXT_MAGIC 0x48554232
struct Ext { uint32_t magic; char host[64]; char secret[44]; uint32_t lastMsg; int32_t tzoff;
             uint8_t casper, locSet, emoji, _pad; };
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
  uiEmojiSet = X.emoji;
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
  WiFi.hostname(HOSTNAME);
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
  j += "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"rssi\":" + String(WiFi.RSSI());
  j += ",\"heap\":" + String(ESP.getFreeHeap()) + ",\"uptime\":" + String(millis() / 1000);
}

// ----------------------------------------------------------- web: setup AP ---
void handleSetupRoot() {
  int n = WiFi.scanNetworks();
  String h = FPSTR(HEAD);
  h += "<h2>claude-desk setup</h2><form action=/save method=post><label>Wi-Fi network</label><select name=ssid>";
  for (int i = 0; i < n; i++) {
    String s = htmlEsc(WiFi.SSID(i));
    h += "<option value='" + s + "'>" + s + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  h += "</select><label>Password</label><input name=pass type=password><button>Connect</button></form>"
       "<p class=m>Or type a hidden network name:</p><form action=/save method=post>"
       "<input name=ssid placeholder='network name'><input name=pass type=password placeholder=password>"
       "<button>Connect</button></form><p><a href=/update>Firmware update</a></p>";
  server.send(200, "text/html", h);
}

void handleSave() {
  String ssid = server.arg("ssid"), pass = server.arg("pass");
  if (!ssid.length()) { server.send(400, "text/plain", "missing ssid"); return; }
  server.send(200, "text/html", String(FPSTR(HEAD)) + "<h2>Saved</h2><p>Connecting to " + htmlEsc(ssid) +
                                    ". The screen will show the new IP in a few seconds.</p>");
  addNet(ssid, pass);                        // added to the saved list, nothing else is forgotten
  restartAt = millis() + 1500;
}

// ------------------------------------------------------- web: safe/loader ---
void handleSafeRoot() {
  String h = FPSTR(HEAD);
#ifdef LOADER
  h += "<h2>claude-desk loader</h2><p>Upload the full firmware:</p>";
#else
  h += "<h2>claude-desk safe mode</h2><p>The firmware crashed several times in a row. Upload a fixed build:</p>";
#endif
  h += "<p><a href=/update>Firmware update</a> &middot; <a href=/reboot>Reboot</a></p><p class=m>fw " FW_VERSION "</p>";
  server.send(200, "text/html", h);
}

void handleWifi() {
  if (server.hasArg("del")) { delNet(server.arg("del").toInt()); server.sendHeader("Location", "/wifi"); server.send(303); return; }
  if (server.hasArg("ssid") && server.arg("ssid").length()) {
    addNet(server.arg("ssid"), server.arg("pass"));
    wifiMulti.addAP(server.arg("ssid").c_str(), server.arg("pass").c_str());
    server.sendHeader("Location", "/wifi"); server.send(303); return;
  }
  String h = FPSTR(HEAD);
  h += "<h2>Wi-Fi networks</h2><p class=m>Connected to <b>" + htmlEsc(WiFi.SSID()) + "</b> as " + WiFi.localIP().toString() +
       " &middot; also <b>" HOSTNAME ".local</b></p><p>The device joins whichever saved network is in range.</p><ul>";
  for (int i = 0; i < NET_MAX; i++)
    if (NS.n[i].ssid[0]) h += "<li>" + htmlEsc(NS.n[i].ssid) + " &middot; <a href='/wifi?del=" + String(i) + "'>remove</a></li>";
  h += "</ul><form action=/wifi method=post><label>Add network (name)</label><input name=ssid>"
       "<label>Password</label><input name=pass type=password><button>Add</button></form><p><a href=/>Back</a></p>";
  server.send(200, "text/html", h);
}

void handleInfoBasic() {
  String j = "{";
  infoCommon(j);
  j += "}";
  server.send(200, "application/json", j);
}

// ============================================================ normal mode ===
#ifndef LOADER
enum View { V_CLOCK, V_NEEDS, V_DONE, V_MSG, V_PAIR };
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
  snprintf(url, sizeof url,
           "http://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f"
           "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
           "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1",
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
// current message
String mFrom, mText, mWhen;
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

void onMqtt(char *topic, byte *payload, unsigned int len) {
  String t = topic;
  int slash = t.lastIndexOf('/');
  String leaf = t.substring(slash + 1);
  if (t.indexOf("/up/") >= 0) return;
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  if (leaf == "claude") {
    applyState(d["s"] | "", d["p"] | "", d["d"] | "", d["f"] | "");
  } else if (leaf == "cfg") {
    bool was = hubPaired;
    hubPaired = d["paired"] | false;
    hubOwner = (const char *)(d["owner"] | "");
    String code = (const char *)(d["pairCode"] | "");
    if (!hubPaired && code.length() && (code != pairCode || view != V_PAIR)) {
      pairCode = code;
      pairUntil = millis() + 10UL * 60 * 1000;
      if (view != V_NEEDS) { view = V_PAIR; dirty = true; }
    }
    if (hubPaired && !was && view == V_PAIR) { view = V_CLOCK; dirty = true; }
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

void hubStatus() {
  char b[160];
  snprintf(b, sizeof b, "{\"fw\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"heap\":%u,\"up\":%lu}", FW_VERSION,
           WiFi.localIP().toString().c_str(), WiFi.RSSI(), ESP.getFreeHeap(), millis() / 1000);
  mqtt.publish((String("desk/") + chipId + "/up/status").c_str(), b);
}

void hubLoop() {
  if (!X.host[0] || hubState == HUB_FORGOTTEN || WiFi.status() != WL_CONNECTED) return;
  if (hubState == HUB_OFF || hubState == HUB_HELLO) {
    if ((int32_t)(millis() - nextHello) < 0) return;
    if (!hubHello()) { nextHello = millis() + 60000; hubState = HUB_HELLO; return; }
    if (!mqttNet) {
      mqttNet = new BearSSL::WiFiClientSecure();
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
  if (mqtt.connected()) {
    mqtt.loop();
    if ((int32_t)(millis() - nextStatus) >= 0) { hubStatus(); nextStatus = millis() + 10UL * 60 * 1000; }
    return;
  }
  if ((int32_t)(millis() - nextMqtt) < 0) return;
  if (mqtt.connect(chipId, chipId, X.secret)) {
    mqtt.subscribe((String("desk/") + chipId + "/#").c_str(), 1);
    mqttBackoff = 5000;
    nextStatus = 0;
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

String emojiOptions() {
  String o;
  for (int i = 0; uiEmojiSetName(i); i++)
    o += "<option value=" + String(i) + (X.emoji == i ? " selected>" : ">") + uiEmojiSetName(i) + "</option>";
  return o;
}

void handleRoot() {
  String h = FPSTR(HEAD);
  h += "<h2>claude-desk</h2><p class=m>fw " FW_VERSION " &middot; " + WiFi.localIP().toString() + " &middot; ";
  h += W.ok ? String(W.temp, 1) + "&deg;C" : String("weather pending");
  h += "</p><h3>Location</h3><input id=q placeholder='Search a city'><div id=r class=m></div>"
       "<form action=/set><label>Latitude</label><input id=lat name=lat value='" + String(S.lat, 4) +
       "'><label>Longitude</label><input id=lon name=lon value='" + String(S.lon, 4) +
       "'><label>Brightness, day (%)</label><input name=bday type=number min=0 max=100 value=" + String(S.bday) +
       "><label>Brightness, night (%)</label><input name=bnight type=number min=0 max=100 value=" + String(S.bnight) +
       "><label>Night starts (hour)</label><input name=ns type=number min=0 max=23 value=" + String(S.nstart) +
       "><label>Night ends (hour)</label><input name=ne type=number min=0 max=23 value=" + String(S.nend) +
       "><label>Layout</label><select name=layout><option value=1" + String(S.layout ? " selected" : "") +
       ">B: tall clock</option><option value=0" + String(S.layout ? "" : " selected") + ">A: clean</option></select>"
       "<label>Colours</label><select name=soft><option value=1" + String(S.soft ? " selected" : "") +
       ">Soft</option><option value=0" + String(S.soft ? "" : " selected") + ">Vivid</option></select>"
       "<label><input type=checkbox name=casper value=1 style='width:auto'" + String(X.casper ? " checked" : "") +
       "> Casper the dog visits</label><input type=hidden name=casper0 value=1>"
       "<label>Reaction style</label><select name=emoji>" + emojiOptions() + "</select>"
       "<h3>Friends hub</h3><label>Hub address</label><input name=hub placeholder='your-hub.up.railway.app' value='" +
       htmlEsc(X.host) + "'><p class=m>Status: " + htmlEsc(hubStateText()) + (hubOwner.length() ? " &middot; owner " + htmlEsc(hubOwner) : String("")) +
       " &middot; id " + chipId + "</p>"
       "<button>Save</button></form><p><a href=/wifi>Wi-Fi networks</a> &middot; <a href=/update>Firmware update</a> &middot; <a href=/reboot>Reboot</a> &middot; <a href=/info>Info</a></p>"
       "<script>let t;q.oninput=()=>{clearTimeout(t);t=setTimeout(async()=>{if(q.value.length<2)return;"
       "let j=await(await fetch('https://geocoding-api.open-meteo.com/v1/search?count=5&name='+encodeURIComponent(q.value))).json();"
       "r.innerHTML='';(j.results||[]).forEach(c=>{let a=document.createElement('a');a.href='#';a.style.display='block';"
       "a.textContent=c.name+', '+(c.admin1||'')+' '+(c.country||'');a.onclick=e=>{e.preventDefault();lat.value=c.latitude.toFixed(4);"
       "lon.value=c.longitude.toFixed(4);r.textContent='Picked '+a.textContent+' - press Save';};r.appendChild(a);});},400);};</script>";
  server.send(200, "text/html", h);
}

void handleSet() {
  if (server.hasArg("lat")) S.lat = server.arg("lat").toFloat();
  if (server.hasArg("lon")) S.lon = server.arg("lon").toFloat();
  if (server.hasArg("lat") || server.hasArg("lon")) { X.locSet = (S.lat != 0.0f || S.lon != 0.0f); uiLocationSet = X.locSet; W.ok = false; dirty = true; }
  if (server.hasArg("casper0")) { X.casper = server.hasArg("casper") ? 1 : 0; dirty = true; }
  else if (server.hasArg("casper")) { X.casper = server.arg("casper").toInt() ? 1 : 0; dirty = true; }
  if (server.hasArg("emoji")) { X.emoji = constrain(server.arg("emoji").toInt(), 0, 3); uiEmojiSet = X.emoji; }
  if (server.hasArg("hub")) {
    String hb = server.arg("hub"); hb.trim();
    if (hb != X.host) {                       // new hub: start fresh there, reboot to connect
      strncpy(X.host, hb.c_str(), 63); X.host[63] = 0;
      X.secret[0] = 0; X.lastMsg = 0;
      restartAt = millis() + 1500;
    }
  }
  saveExt();
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

void loopNormal() {
  struct tm t;
  bool tv = nowTm(t);
  if (tv != timeValid) { timeValid = tv; dirty = true; }
  hubLoop();
  if (uiUnread[0] && (int32_t)(millis() - unreadUntil) >= 0) { uiUnread[0] = 0; if (view == V_CLOCK) dirty = true; }
  if (view == V_MSG && (int32_t)(millis() - msgUntil) >= 0) { view = V_CLOCK; dirty = true; }
  if (view == V_PAIR && (hubPaired || (int32_t)(millis() - pairUntil) >= 0)) { view = V_CLOCK; dirty = true; }

  if (WiFi.status() == WL_CONNECTED && (int32_t)(millis() - nextWeather) >= 0) {
    bool ok = fetchWeather();
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
        uiMessage("CLAUDE DESK", WiFi.localIP().toString().c_str(), "syncing time...", "", COL_TEAL);
        dirty = false;
      }
      return;
    }
    if (dirty) {
      uiClockFull(t.tm_hour, t.tm_min, t.tm_wday, t.tm_mday, t.tm_mon, W);
      lastMin = t.tm_min; lastDay = t.tm_mday; nextFrame = 0; dirty = false;
      scene = SC_NONE;
      if (!nextWalkBy) nextWalkBy = millis() + random(20, 40) * 60000UL;
    } else {
      if (t.tm_min != lastMin) { uiClockTime(t.tm_hour, t.tm_min); lastMin = t.tm_min; }
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
  gfxInit();

#ifdef LOADER
  mode = M_SAFE;
#else
  mode = rtcBoot.count >= 4 ? M_SAFE : M_NORMAL;
  if (mode == M_NORMAL) {
    loadSettings();
    loadExt();
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
  if (mode != M_SETUP) {
    MDNS.begin(HOSTNAME);
    MDNS.addService("http", "tcp", 80);
  }
  server.begin();
}

void loop() {
  server.handleClient();
  if (mode == M_SETUP) {
    dns.processNextRequest();
    // credentials were fine after all (e.g. router was rebooting): go back to normal
    static uint32_t connectedSince = 0, nextTry = 20000;
    if (WiFi.status() != WL_CONNECTED && netCount() && (int32_t)(millis() - nextTry) >= 0) {
      wifiMulti.run(3000);                   // a saved network may have come back
      nextTry = millis() + 20000;
    }
    if (WiFi.status() == WL_CONNECTED) {
      if (!connectedSince) connectedSince = millis();
      else if (millis() - connectedSince > 5000 && !restartAt) restartAt = millis() + 500;
    } else connectedSince = 0;
  } else {
    MDNS.update();
    static uint32_t nextTry = 0;             // lost Wi-Fi: hop to any saved network in range
    if (WiFi.status() != WL_CONNECTED && (int32_t)(millis() - nextTry) >= 0) {
      wifiMulti.run(3000);
      nextTry = millis() + 15000;
      if (WiFi.status() == WL_CONNECTED) { MDNS.end(); MDNS.begin(HOSTNAME); MDNS.addService("http", "tcp", 80); }
    }
  }
  if (!bootCleared && millis() > 60000) bootOk();
  if (restartAt && (int32_t)(millis() - restartAt) >= 0) { delay(100); ESP.restart(); }
#ifndef LOADER
  if (mode == M_NORMAL) loopNormal();
#endif
  delay(5);
}
