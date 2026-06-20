import xapi from 'xapi';

/*
 * Samsung TV control via SmartThings OAuth (no bridge), 1 to 4 displays.
 *
 * For more info go to https://github.com/vtjoeh/samsung_tv_control
 *
 * All configuration is in the DEFAULT_OAUTH and DEFAULT_TVS constants below.
 * The macro builds its own Control Panel: one page per TV, plus an About page.
 * Rotating OAuth token state is auto-saved to a local macro SamsungTV_Store.js
 *
 * Features:
 *  - 8-hour scheduled token refresh (keeps the 29-day chain alive with no button presses).
 *
 *  - Per-display automatic behavior, one action per codec state. Each key below
 *    takes 'on', 'off', 'art', or a schedule object:
 *      standby                   : codec entered Standby (asleep)
 *      halfwake                  : codec entered Halfwake
 *      standbyOff                : codec became fully awake (also the baseline
 *                                  reverted to when a call ends or sharing stops)
 *      call                      : a call started (NumberOfActiveCalls > 0)
 *      contentShareOutsideOfCall : local content sharing started outside a call
 *
 *     'on' powers on and selects primaryHDMI. A schedule shows art inside its
 *    window and powers off outside it. The last applied action is tracked so the
 *    same command is never sent twice in a row.
 */

// ===================== CONFIGURATION =====================
const PANEL_ID    = 'samsung_tv';   // intentionally unprefixed: overwrites any existing samsung_tv panel
const PANEL_NAME  = 'TVs';
const INFO_URL    = 'https://github.com/vtjoeh/samsung_tv_control';
const REFRESH_MS     = 8 * 60 * 60 * 1000;   // scheduled token refresh interval (8 hours)
const KEEPALIVE_MS   = 60 * 60 * 1000;       // hourly status ping to keep TV network stack warm
const SLIDER_FRESH_MS = 2500;                // only trust an on-open volume read this fast (ms)
const STATUS_RETRIES  = 3;                   // attempts for a status read before giving up
const STATUS_RETRY_MS = 1500;                // wait between status retries (ms)
const HTTP_QUEUE_TIMEOUT = 5;                // per-request HttpClient timeout in seconds (default is 30)
const WEBEX_LOG_TIMEOUT  = 2;                // shorter timeout for the non-critical Webex log post

// Manually shorten the codec's Halfwake stage. When the codec enters Halfwake,
// the macro waits HALFWAKE_TIMER seconds and then moves the codec the OPPOSITE
// direction from wherever it came, which in turn moves every TV via the normal
// state engine:
//   Standby -> Halfwake (woke from sleep)  -> after timer: Awake   (Standby.Deactivate)
//   Off     -> Halfwake (heading to sleep) -> after timer: Standby (Standby.Activate)
//   unknown direction (e.g. macro restarted into Halfwake) -> Awake (safest for the user)

const HALFWAKE_TIMER = 3;   // seconds in Halfwake before the macro moves it on. 'off' or 0 disables.

// Presence-based wake. Some devices (notably the Desk Pro on RoomOS 11) do not
// reliably wake on motion after being forced to Standby, because their motion
// wake-up is unreliable or off by default. When WAKE_ON_PRESENCE is true the
// macro watches the room's people sensors while the codec is in Standby and wakes
// it when a person is detected (PeoplePresence == 'Yes' OR PeopleCount >= 1).
// Wake target: Halfwake normally, or fully Awake when HALFWAKE_TIMER is disabled.
// NOTE: For this to work the presence sensors must actually run in Standby. The
// macro enables PeoplePresenceDetector and the ultrasound input at startup, since
// the camera-based detector is off while the display sleeps.
// Default false: cameras like the Quad Camera (Room Kit EQ) wake on motion
// natively and do not need this. Set true only on devices that won't self-wake,
// such as the Desk Pro.
// IMPORTANT: presence-wake ignores native Office Hours. If Time OfficeHours
// OutsideOfficeHours Standby AutoWakeup is set to Disabled (to keep the room
// asleep outside hours), this macro will still wake the device on presence.
const WAKE_ON_PRESENCE   = false;
const PRESENCE_POLL_MS    = 5000;   // how often to poll presence while in Standby (ms)
const PRESENCE_WAKE_COOLDOWN_MS = 15000;  // min gap between presence-driven wakes (ms)

// ---- Device logging (optional, for deployment troubleshooting) ----
// Set to false to disable all Webex logging with no side effects. When false,
// or when BOT_TOKEN / ROOM_ID are blank, logging is skipped silently (events
// still go to the macro console).
const POST_DEVICE_LOG_TO_WEBEX = false;
const WEBEX_BOT_TOKEN = '';
const WEBEX_ROOM_ID   = '';
const WEBEX_URL       = 'https://webexapis.com/v1/messages';

const DEFAULT_OAUTH = {
  client: '',
  secret: '',
  seed:   ''
};

// Optional shared schedule(s) you can reference in any action below.
// Inside the window the display shows art; outside it powers off. Local codec time.
// Two forms are accepted:
//   flat:           { startTime: '08:00', endTime: '16:00' }   same window every day
//   weekday/weekend: as below                                   set a side to null for off
const BUSINESS_HOURS = {
  weekdays: { startTime: '08:00', endTime: '17:00' },   // Mon-Fri
  weekends: null                                        // off all weekend (or { startTime, endTime })
};

// One entry per TV. Add up to 4.
// Each state key takes an action: 'on', 'off', 'art', or a schedule object
// (e.g. BUSINESS_HOURS). 'on' powers on and selects primaryHDMI. A schedule shows
// art inside its window and powers off outside it. Omit a key (or set it to null)
// to take no action for that state.
const DEFAULT_TVS = [
  {
    name:          'Front Display',
    deviceId:      '<tv-device-id>',
    inputs:        ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:   'HDMI1',
    standby:                   'off',  // 'on', 'off', 'art' or BUSINESS_HOURS
    halfwake:                  'on',   // 'on', 'off', 'art' or BUSINESS_HOURS
    standbyOff:                'on',   // 'on', 'off', 'art' or BUSINESS_HOURS
    call:                      'on',   // 'on', 'off', 'art' or BUSINESS_HOURS
    contentShareOutsideOfCall: 'on'    // 'on', 'off', 'art' or BUSINESS_HOURS
  },
  {
    name:          'Left Display',
    deviceId:      '<tv-device-id>',
    inputs:        ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:   'HDMI1',
    standby:                   BUSINESS_HOURS,
    halfwake:                  'art',
    standbyOff:                'art',
    call:                      'on',
    contentShareOutsideOfCall: 'on'
  },
  {
    name:          'Right Display',
    deviceId:      '<tv-device-id>',
    inputs:        ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:   'HDMI1',
    standby:                   'off',
    halfwake:                  'art',
    standbyOff:                'art',
    call:                      'on',
    contentShareOutsideOfCall: 'on'
  }
];
// ========================================================

const STORE       = 'SamsungTV_Store';
const TOKEN_URL   = 'https://api.smartthings.com/oauth/token';
const DEVICE_BASE = 'https://api.smartthings.com/v1/devices/';

// Art/Ambient mode capability and command, shared by every art-capable display.
const ART_CAPABILITY = 'samsungvd.ambient';
const ART_COMMAND    = 'setAmbientOn';

let OAUTH = null;
let TVS   = null;
const lastFire     = {};
let lastRefreshMs  = 0;        // when the token was last refreshed
let lastError      = '';       // current comms error note ('' = healthy)
let deviceName     = '';       // cached for log messages
let serialNumber   = '';
let deviceInfoLoaded = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Global HTTP queue ----
// The codec allows only a few concurrent outbound HTTP requests ("No available
// http connections" otherwise). Every outbound request (SmartThings commands,
// status reads, token refreshes, and the Webex log posts) is funneled through
// this queue so exactly one request is in flight at a time. Each task waits for
// the previous one to fully resolve or reject before starting.
let httpChain = Promise.resolve();
function queueHttp(task) {
  const run = httpChain.then(task, task);   // run regardless of prior success/failure
  // keep the chain alive even if a task throws, so one failure can't stall the queue
  httpChain = run.then(() => {}, () => {});
  return run;
}

// ---- Device logging (built in, queued) ----
// qLog() always logs to the macro console. If POST_DEVICE_LOG_TO_WEBEX is true
// and both credentials are set, it also queues a Markdown post to a Webex space.
function logTimeStamp() {
  const t = new Date();
  const pad = n => (n < 10 ? '0' + n : '' + n);
  const tzMatch = t.toString().match(/(GMT|UTC)([\-+]\d{2}:?\d{2})/);
  const tz = tzMatch ? ' ' + tzMatch[0] : '';
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
    ' ' + t.toLocaleTimeString() + tz;
}
async function ensureDeviceInfo() {
  if (deviceInfoLoaded) return;
  try {
    const su = await xapi.Status.SystemUnit.get();
    deviceName   = su.BroadcastName || '';
    serialNumber = (su.Hardware && su.Hardware.Module) ? su.Hardware.Module.SerialNumber : '';
  } catch (e) { /* leave blanks */ }
  deviceInfoLoaded = true;
}
function webexLoggingEnabled() {
  return POST_DEVICE_LOG_TO_WEBEX && WEBEX_BOT_TOKEN && WEBEX_ROOM_ID;
}
function qLog(text) {
  console.log(text);
  if (!webexLoggingEnabled()) return;
  queueHttp(async () => {
    await ensureDeviceInfo();
    const markdown = 'Device: ' + deviceName + ' / ' + serialNumber + ' / ' + logTimeStamp() +
                     '\n```\n' + text + '\n```';
    return xapi.Command.HttpClient.Post({
      Url: WEBEX_URL,
      Header: ['Content-Type: application/json', 'Authorization: Bearer ' + WEBEX_BOT_TOKEN],
      AllowInsecureHTTPS: 'False',
      Timeout: WEBEX_LOG_TIMEOUT,
      ResultBody: 'PlainText'
    }, JSON.stringify({ roomId: WEBEX_ROOM_ID, markdown: markdown }))
      .catch(() => {});   // never let a failed log post surface as an error
  });
}

// ---- Base64 (ASCII only, for client_id:client_secret) ----
function b64(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '', i = 0;
  while (i < str.length) {
    const a = str.charCodeAt(i++);
    const bb = i < str.length ? str.charCodeAt(i++) : NaN;
    const c = i < str.length ? str.charCodeAt(i++) : NaN;
    out += chars.charAt(a >> 2);
    out += chars.charAt(((a & 3) << 4) | (isNaN(bb) ? 0 : bb >> 4));
    out += isNaN(bb) ? '=' : chars.charAt(((bb & 15) << 2) | (isNaN(c) ? 0 : c >> 6));
    out += isNaN(c) ? '=' : chars.charAt(c & 63);
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Load settings from the in-file constants ----
function loadSettings() {
  OAUTH = DEFAULT_OAUTH;
  TVS = DEFAULT_TVS.filter(t => t.deviceId).map(t => ({
    name:          t.name || 'TV',
    deviceId:      t.deviceId,
    inputs:        t.inputs || ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:   t.primaryHDMI || 'HDMI1',
    artCapability: ART_CAPABILITY,
    artCommand:    ART_COMMAND,
    actions: {
      standby:                   t.standby,
      halfwake:                  t.halfwake,
      standbyOff:                t.standbyOff,
      call:                      t.call,
      contentShareOutsideOfCall: t.contentShareOutsideOfCall
    },
    _currentKey:    null,      // which state key is currently governing this TV
    _appliedAction: null       // last concrete action sent ('on'|'off'|'art')
  }));
}

// ---- Token state persistence (local storage macro) ----
// The store file gets a human-readable header comment plus a single JSON line.
// readStore extracts the JSON object regardless of the surrounding comment.
async function readStore() {
  try {
    const res = await xapi.Command.Macros.Macro.Get({ Name: STORE, Content: 'True' });
    const text = res.Macro[0].Content || '';
    // Content is valid JS: `let tokenData = {...};`  Extract the JSON object.
    const match = text.match(/let\s+tokenData\s*=\s*(\{[\s\S]*?\});/);
    return match ? JSON.parse(match[1]) : null;
  } catch (e) { return null; }
}
function fmt(ms) {
  const d = new Date(ms), p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'z';
}
async function writeStore(state) {
  const now     = Date.now();
  const nextRun = now + REFRESH_MS;
  const expires = now + (29 * 24 * 60 * 60 * 1000);
  const header =
    '/* DO NOT DELETE\n' +
    ' *\n' +
    ' * Used by the SamsungTVControl macro. Holds the rotating OAuth token.\n' +
    ' * Leave this macro DISABLED. It is data only and must never be activated.\n' +
    ' * Last update: ' + fmt(now) + '   next update: ' + fmt(nextRun) + '\n' +
    ' * Refresh token expires on: ' + fmt(expires) + ' if the device is offline until then.\n' +
    ' */\n' +
    'let tokenData = ' + JSON.stringify(state) + ';\n';
  await xapi.Command.Macros.Macro.Save({ Name: STORE, Overwrite: 'True' }, header);
}

// ---- OAuth refresh ----
async function refreshAccess(refreshToken) {
  const basic = b64(OAUTH.client + ':' + OAUTH.secret);
  const body  = 'grant_type=refresh_token&client_id=' + OAUTH.client + '&refresh_token=' + refreshToken;
  const res = await queueHttp(() => xapi.Command.HttpClient.Post({
    Url: TOKEN_URL,
    Header: ['Authorization: Basic ' + basic, 'Content-Type: application/x-www-form-urlencoded'],
    AllowInsecureHTTPS: 'False',
    Timeout: HTTP_QUEUE_TIMEOUT,
    ResultBody: 'PlainText'
  }, body));
  const data = JSON.parse(res.Body);
  const state = {
    refresh_token: data.refresh_token,
    access_token:  data.access_token,
    expires_at:    Date.now() + (data.expires_in * 1000) - 60000
  };
  await writeStore(state);
  lastRefreshMs = Date.now();
  updateAbout();
  return state;
}
async function getAccessToken() {
  const state = await readStore();
  if (state && state.access_token && Date.now() < state.expires_at) return state.access_token;
  const seed = (state && state.refresh_token) ? state.refresh_token : OAUTH.seed;
  return (await refreshAccess(seed)).access_token;
}

// ---- Scheduled keep-alive ----
async function keepAliveRefresh() {
  try {
    const store = await readStore();
    const seed  = (store && store.refresh_token) ? store.refresh_token : OAUTH.seed;
    await refreshAccess(seed);
    qLog('Event: Scheduled Token Refresh\r\nStatus: Success\r\nNext refresh in: 8 hours');
  } catch (e) {
    qLog('Event: Scheduled Token Refresh\r\nStatus: FAILED\r\nError: ' + JSON.stringify(e));
  }
}


// ---- Hourly status keep-alive ----
// Polls each TV's status once per hour. The intent is to keep the TV's network
// stack warm overnight so the first morning wake command responds quickly instead
// of waiting for the TV to re-establish its cloud connection from a cold start.
// Results are discarded unless they reveal a comms error.
async function keepAliveStatus() {
  if (!TVS || !TVS.length) return;
  const codecState = await xapi.Status.Standby.State.get().catch(() => 'Unknown');
  for (const tv of TVS) {
    try {
      const main = await getStatus(tv);
      const power   = main.switch && main.switch.switch ? main.switch.switch.value : 'unknown';
      const input   = main.mediaInputSource && main.mediaInputSource.inputSource
                        ? main.mediaInputSource.inputSource.value : 'unknown';
      const vol     = main.audioVolume && main.audioVolume.volume
                        ? main.audioVolume.volume.value : 'unknown';
      const muted   = main.audioMute && main.audioMute.mute
                        ? main.audioMute.mute.value : 'unknown';
      const cap     = tv.artCapability ? main[tv.artCapability] : null;
      const ambient = cap && cap.ambientPower ? cap.ambientPower.value : 'unknown';
      qLog(
        'Event: Hourly Keep-Alive\r\n' +
        'Codec Standby: ' + codecState + '\r\n' +
        'TV: ' + tv.name + '\r\n' +
        'Power: ' + power + '\r\n' +
        'Input: ' + input + '\r\n' +
        'Volume: ' + vol + '\r\n' +
        'Mute: ' + muted + '\r\n' +
        'Art Mode: ' + ambient
      );
      // Re-evaluate any time-based (scheduled) action for this TV's current state.
      // Catches schedule boundaries (e.g. art -> off at the end of the window) that
      // no codec event would otherwise trigger. Skips if the resolved action is
      // unchanged, so it never resends the same command.
      if (tv._currentKey) await applyKey(tv, tv._currentKey);
    } catch (e) {
      qLog('Event: Hourly Keep-Alive\r\nCodec Standby: ' + codecState + '\r\nTV: ' + tv.name + '\r\nStatus: FAILED\r\nError: ' + JSON.stringify(e));
    }
  }
}
// ---- SmartThings HTTP helpers ----
async function rawPost(deviceId, token, commands) {
  return queueHttp(() => xapi.Command.HttpClient.Post({
    Url: DEVICE_BASE + deviceId + '/commands',
    Header: ['Authorization: Bearer ' + token, 'Content-Type: application/json'],
    AllowInsecureHTTPS: 'False',
    Timeout: HTTP_QUEUE_TIMEOUT,
    ResultBody: 'PlainText'
  }, JSON.stringify({ commands })));
}
async function sendTo(tv, parts) {
  const commands = parts.map(p => Object.assign({ component: 'main' }, p));
  const isVolume = parts.length === 1 && parts[0].capability === 'audioVolume' && parts[0].command === 'setVolume';
  const cmdSummary = parts.map(p => (p.capability + '.' + p.command + (p.arguments ? '(' + p.arguments + ')' : ''))).join(', ');
  try {
    const result = await rawPost(tv.deviceId, await getAccessToken(), commands);
    if (!isVolume) qLog('Event: API Command\r\nTV: ' + tv.name + '\r\nCommand: ' + cmdSummary + '\r\nResult: Success');
    return result;
  } catch (e) {
    try {
      const store = await readStore();
      const seed  = (store && store.refresh_token) ? store.refresh_token : OAUTH.seed;
      const fresh = await refreshAccess(seed);
      const result = await rawPost(tv.deviceId, fresh.access_token, commands);
      if (!isVolume) qLog('Event: API Command (token refreshed)\r\nTV: ' + tv.name + '\r\nCommand: ' + cmdSummary + '\r\nResult: Success after retry');
      return result;
    } catch (e2) {
      const msg = 'Event: API Command FAILED\r\nTV: ' + tv.name + '\r\nCommand: ' + cmdSummary + '\r\nError: ' + JSON.stringify(e2);
      console.error(msg);
      qLog(msg);
    }
  }
}
async function getStatus(tv) {
  // Retry transient failures (400/500 are common while a TV is waking up).
  let lastErr;
  for (let attempt = 0; attempt < STATUS_RETRIES; attempt++) {
    try {
      const token = await getAccessToken();
      const res = await queueHttp(() => xapi.Command.HttpClient.Get({
        Url: DEVICE_BASE + tv.deviceId + '/status',
        Header: ['Authorization: Bearer ' + token],
        AllowInsecureHTTPS: 'False',
        Timeout: HTTP_QUEUE_TIMEOUT,
        ResultBody: 'PlainText'
      }));
      const main = JSON.parse(res.Body).components.main;
      commsOk();                 // a good response clears any error note
      return main;
    } catch (e) {
      lastErr = e;
      if (attempt < STATUS_RETRIES - 1) await sleep(STATUS_RETRY_MS);
    }
  }
  commsError('Cannot reach the TV right now. Retrying automatically.');
  throw lastErr;
}

// ---- TV actions ----
async function togglePower(tv) {
  try {
    const main = await getStatus(tv);
    const s = main.switch && main.switch.switch ? main.switch.switch.value : 'off';
    await sendTo(tv, [{ capability: 'switch', command: s === 'on' ? 'off' : 'on' }]);
  } catch (e) {
    const msg = 'Event: Power Toggle FAILED\r\nTV: ' + tv.name + '\r\nError: ' + JSON.stringify(e);
    console.error(msg); qLog(msg);
  }
}
async function toggleMute(tv) {
  try {
    await sendTo(tv, [{ capability: 'audioMute', command: tv._muted ? 'mute' : 'unmute' }]);
  } catch (e) {
    const msg = 'Event: Mute Toggle FAILED\r\nTV: ' + tv.name + '\r\nError: ' + JSON.stringify(e);
    console.error(msg); qLog(msg);
  }
}
function setInput(tv, key)  { return sendTo(tv, [{ capability: 'mediaInputSource', command: 'setInputSource', arguments: [key] }]); }
function setVolume(tv, lvl) { return sendTo(tv, [{ capability: 'audioVolume', command: 'setVolume', arguments: [lvl] }]); }
function powerOn(tv)        { return sendTo(tv, [{ capability: 'switch', command: 'on' }]); }
function powerOff(tv)       { return sendTo(tv, [{ capability: 'switch', command: 'off' }]); }
function artMode(tv) {
  if (!tv.artCapability || !tv.artCommand) {
    const msg = 'Event: Art Mode FAILED\r\nTV: ' + tv.name + '\r\nReason: Not configured';
    console.warn(msg); qLog(msg); return;
  }
  return sendTo(tv, [{ capability: tv.artCapability, command: tv.artCommand, arguments: [] }]);
}

// ---- Automatic state engine ----
// Each codec state maps to a per-TV action ('on', 'off', 'art', or a schedule).
// The engine tracks the last concrete action applied per TV so it never sends the
// same command twice in a row (a repeated command can flash a message on screen).

function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
}

// Current codec-local time as minutes since midnight. Reads the codec clock so it
// honors the device time zone; falls back to the macro runtime clock if needed.
async function getLocalMinutes() {
  try {
    const t = await xapi.Status.Time.SystemTime.get();   // ISO-like local time string
    const m = /T(\d{2}):(\d{2})/.exec(t);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  } catch (e) { /* fall back below */ }
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function inWindow(nowMin, startMin, endMin) {
  if (startMin === null || endMin === null) return false;
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;   // same-day window
  return nowMin >= startMin || nowMin < endMin;                           // overnight window
}

// Codec-local day of week: 0 = Sunday ... 6 = Saturday.
async function getLocalDayOfWeek() {
  try {
    const t = await xapi.Status.Time.SystemTime.get();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)).getDay();
  } catch (e) { /* fall back below */ }
  return new Date().getDay();
}
function isWeekend(dow) { return dow === 0 || dow === 6; }

// Resolve a config value to a concrete action: 'on' | 'off' | 'art' | null.
// A schedule object may be either form:
//   flat:           { startTime: '08:00', endTime: '16:00' }            same window every day
//   day-type aware: { weekdays: {start,end}, weekends: {start,end} }    set a side to null for off
// Inside the chosen window the action is 'art'; outside it (or with no window
// for that day) it is 'off'.
async function resolveAction(value) {
  if (value === 'on' || value === 'off' || value === 'art') return value;
  if (value && typeof value === 'object') {
    let win = null;
    if (value.startTime && value.endTime) {
      win = value;                                              // flat form
    } else if (value.weekdays || value.weekends) {
      win = isWeekend(await getLocalDayOfWeek()) ? value.weekends : value.weekdays;
    }
    if (!win || !win.startTime || !win.endTime) return 'off';   // no window today -> off
    const now = await getLocalMinutes();
    return inWindow(now, timeToMinutes(win.startTime), timeToMinutes(win.endTime)) ? 'art' : 'off';
  }
  return null;   // unset / unrecognized -> no action
}

// Send a concrete action to the TV (no idempotency check here).
async function sendAction(tv, action) {
  if (action === 'on') {
    await powerOn(tv);
    await setInput(tv, tv.primaryHDMI);
  } else if (action === 'off') {
    await powerOff(tv);
  } else if (action === 'art') {
    await artMode(tv);
  }
}

// Apply the action for a given state key to one TV, skipping if already applied.
async function applyKey(tv, key) {
  tv._currentKey = key;
  const action = await resolveAction(tv.actions[key]);
  if (!action) {
    qLog('Event: Auto Action\r\nTV: ' + tv.name + '\r\nState: ' + key + '\r\nAction: none (unset)');
    return;
  }
  if (action === tv._appliedAction) {
    qLog('Event: Auto Action\r\nTV: ' + tv.name + '\r\nState: ' + key + '\r\nAction: ' + action + ' (already applied, skipped)');
    return;
  }
  try {
    await sendAction(tv, action);
    tv._appliedAction = action;
    qLog('Event: Auto Action\r\nTV: ' + tv.name + '\r\nState: ' + key + '\r\nAction: ' + action);
  } catch (e) {
    const msg = 'Event: Auto Action FAILED\r\nTV: ' + tv.name + '\r\nState: ' + key + '\r\nAction: ' + action + '\r\nError: ' + JSON.stringify(e);
    console.error(msg); qLog(msg);
  }
}

// Apply a state key to every TV.
async function applyKeyAll(key) {
  if (!TVS || !TVS.length) return;
  for (const tv of TVS) await applyKey(tv, key);
}

// Map a codec standby state to the matching config key.
function standbyKeyFor(state) {
  if (state === 'Off')      return 'standbyOff';   // fully awake
  if (state === 'Halfwake') return 'halfwake';
  if (state === 'Standby')  return 'standby';
  return null;                                     // EnteringStandby / transient: ignore
}

// Resolve HALFWAKE_TIMER to a positive number of seconds, or null if disabled.
// Disabled when the value is 'off', 0, negative, or any non-numeric value.
function halfwakeTimerSeconds() {
  const n = Number(HALFWAKE_TIMER);
  if (!isFinite(n) || n <= 0) return null;   // 'off', 0, negatives, NaN -> disabled
  return n;
}

// ---- Codec event handlers ----
let _inCall = false;

// ---- Manual Halfwake shortening ----
// Pending one-shot timer that forces the codec from Halfwake to Standby, and the
// standby state the codec was in just before the current one (so we can log which
// direction we came from: Standby->Halfwake vs Off->Halfwake).
let _halfwakeTimer = null;
let _prevStandbyState = null;

function cancelHalfwakeTimer(reason) {
  if (_halfwakeTimer) {
    clearTimeout(_halfwakeTimer);
    _halfwakeTimer = null;
    qLog('Event: Halfwake Timer Cancelled\r\nReason: ' + reason);
  }
}

// Called when the codec enters Halfwake. After HALFWAKE_TIMER seconds, if the
// codec is still in Halfwake and not in a call, move it the OPPOSITE direction
// from wherever it came:
//   came from Standby -> Standby.Deactivate() (fully Awake / state 'Off')
//   came from Off     -> Standby.Activate()   (Standby / asleep)
// The codec's own Standby state change then flows through onStandbyState and
// moves the TVs. The manual Halfwake button is intentionally NOT special: it
// enters Halfwake like any other path and is handled the same way here.
function scheduleHalfwakeTimeout(cameFrom) {
  const secs = halfwakeTimerSeconds();
  if (secs === null) return;            // disabled: leave RoomOS Halfwake timing alone
  cancelHalfwakeTimer('superseded by new Halfwake entry');

  // Decide the destination from the prior state. 'toAwake' means Deactivate.
  let toAwake;
  if (cameFrom === 'Standby')      toAwake = true;    // was asleep -> finish waking
  else if (cameFrom === 'Off')     toAwake = false;   // was awake  -> go to sleep
  else                             toAwake = true;     // unknown -> wake fully (safest for the user)

  const plan = toAwake
    ? ((cameFrom || 'unknown') + ' -> Halfwake -> forcing Awake (Standby.Deactivate)')
    : ((cameFrom || 'unknown') + ' -> Halfwake -> forcing Standby (Standby.Activate)');
  qLog('Event: Halfwake Timer Started\r\nFrom: ' + (cameFrom || 'unknown') +
       '\r\nDelay: ' + secs + 's\r\nPlan: ' + plan);

  _halfwakeTimer = setTimeout(async () => {
    _halfwakeTimer = null;
    if (_inCall) { qLog('Event: Halfwake Timer Fired\r\nSkipped: a call is active'); return; }
    let state = 'Halfwake';
    try { state = await xapi.Status.Standby.State.get(); } catch (e) { /* assume still Halfwake */ }
    if (state !== 'Halfwake') {
      qLog('Event: Halfwake Timer Fired\r\nSkipped: codec already in ' + state);
      return;
    }
    try {
      if (toAwake) {
        qLog('Event: Halfwake Timer Fired\r\nAction: Command.Standby.Deactivate (forcing Awake)');
        await xapi.Command.Standby.Deactivate();   // codec -> Off (awake), TVs follow via onStandbyState
      } else {
        qLog('Event: Halfwake Timer Fired\r\nAction: Command.Standby.Activate (forcing Standby)');
        await xapi.Command.Standby.Activate();      // codec -> Standby, TVs follow via onStandbyState
        // Desk Pro and similar default WakeupOnMotionDetection to Off after RoomOS 11,
        // which leaves the device unable to auto-wake. Re-arm it so motion can wake it.
        try {
          await xapi.Config.Standby.WakeupOnMotionDetection.set('On');
          qLog('Event: Halfwake Timer Fired\r\nWakeupOnMotionDetection set On (so the device can wake again)');
        } catch (e2) {
          qLog('Event: Halfwake Timer Fired\r\nWakeupOnMotionDetection set FAILED\r\nError: ' + JSON.stringify(e2));
        }
      }
    } catch (e) {
      qLog('Event: Halfwake Timer Fired\r\nStandby command FAILED\r\nError: ' + JSON.stringify(e));
    }
  }, secs * 1000);
}

// ---- Presence-based wake (for devices that won't wake on motion) ----
// While the codec sits in Standby, watch the people sensors and wake the device
// when someone is detected. Wake to Halfwake normally; wake fully to Awake when
// the Halfwake timer is disabled (HALFWAKE_TIMER 0/off), since there is then no
// shortening stage to carry it forward.
let _presencePoll   = null;   // interval handle while polling in Standby
let _lastPresenceWakeMs = 0;  // cooldown anchor so we don't spam wake commands

// Make sure the presence sensors are actually running, including while asleep.
async function enablePresenceSensors() {
  if (!WAKE_ON_PRESENCE) return;
  try { await xapi.Config.RoomAnalytics.PeoplePresenceDetector.set('On'); } catch (e) { /* best effort */ }
  // The camera-based head detector is off in Standby; ultrasound can still run, so
  // turn it on to give presence a chance to register while the display sleeps.
  try { await xapi.Config.RoomAnalytics.PeoplePresence.Input.Ultrasound.set('On'); } catch (e) { /* best effort */ }
}

// Read the two sensors and return true if a person appears to be present.
async function personPresent() {
  let presence = 'No', count = 0;
  try { presence = await xapi.Status.RoomAnalytics.PeoplePresence.get(); } catch (e) { /* sensor off */ }
  try { count = Number(await xapi.Status.RoomAnalytics.PeopleCount.Current.get()); } catch (e) { count = 0; }
  if (!isFinite(count)) count = 0;
  return presence === 'Yes' || count >= 1;
}

// Wake the codec from Standby because presence was detected. Honors the cooldown,
// only acts while actually in Standby and not in a call.
async function presenceWake(source) {
  if (!WAKE_ON_PRESENCE) return;
  if (_inCall) return;
  const now = Date.now();
  if (now - _lastPresenceWakeMs < PRESENCE_WAKE_COOLDOWN_MS) return;   // too soon since last wake
  let state = 'Standby';
  try { state = await xapi.Status.Standby.State.get(); } catch (e) { /* assume Standby */ }
  if (state !== 'Standby') return;   // only wake from full Standby
  _lastPresenceWakeMs = now;
  const toHalfwake = halfwakeTimerSeconds() !== null;   // timer enabled -> Halfwake, else full Awake
  try {
    if (toHalfwake) {
      qLog('Event: Presence Wake\r\nSource: ' + source + '\r\nAction: Command.Standby.Halfwake');
      await xapi.Command.Standby.Halfwake();
    } else {
      qLog('Event: Presence Wake\r\nSource: ' + source + '\r\nAction: Command.Standby.Deactivate (Halfwake timer disabled)');
      await xapi.Command.Standby.Deactivate();
    }
  } catch (e) {
    qLog('Event: Presence Wake FAILED\r\nSource: ' + source + '\r\nError: ' + JSON.stringify(e));
  }
}

// Poll presence on an interval, but only while in Standby. This catches the case
// where presence was already 'Yes' before the device slept, so no change event
// fires. Started by startPresencePolling, stopped when the codec leaves Standby.
async function presencePollTick() {
  if (!WAKE_ON_PRESENCE || _inCall) return;
  let state = 'Standby';
  try { state = await xapi.Status.Standby.State.get(); } catch (e) { /* assume Standby */ }
  if (state !== 'Standby') { stopPresencePolling('left Standby'); return; }
  if (await personPresent()) await presenceWake('poll');
}
function startPresencePolling() {
  if (!WAKE_ON_PRESENCE || _presencePoll) return;
  _presencePoll = setInterval(() => { presencePollTick().catch(() => {}); }, PRESENCE_POLL_MS);
  qLog('Event: Presence Polling Started\r\nInterval: ' + (PRESENCE_POLL_MS / 1000) + 's');
}
function stopPresencePolling(reason) {
  if (_presencePoll) {
    clearInterval(_presencePoll);
    _presencePoll = null;
    qLog('Event: Presence Polling Stopped\r\nReason: ' + reason);
  }
}

// True if PC/content is currently being presented to the room (in or out of call).
// Checks LocalInstance first, then Presentation Mode as a fallback. Verify which
// one your unit populates with: xStatus Conference Presentation
async function isSharingLocally() {
  try {
    const inst = await xapi.Status.Conference.Presentation.LocalInstance.get();
    if (Array.isArray(inst) && inst.length > 0) return true;
  } catch (e) { /* try next */ }
  try {
    const mode = await xapi.Status.Conference.Presentation.Mode.get();
    if (mode && mode !== 'Off') return true;
  } catch (e) { /* treat as not sharing */ }
  return false;
}

// Resolve the single governing state key from the current codec context.
// Priority: active call > local content share > standby state.
async function resolveContextKey() {
  const calls = await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get().catch(() => 0);
  if (Number(calls) > 0) return 'call';
  if (await isSharingLocally()) return 'contentShareOutsideOfCall';
  const state = await xapi.Status.Standby.State.get().catch(() => 'Off');
  return standbyKeyFor(state) || 'standbyOff';
}

// Read the current context and apply the matching action to every TV. Used at
// startup and whenever a call or local share ends, so the display always lands on
// the correct state regardless of which event (or restart) got us here.
async function applyContext(reason) {
  const key = await resolveContextKey();
  qLog('Event: ' + reason + '\r\nResolved context -> ' + key);
  await applyKeyAll(key);
}

async function onStandbyState(state) {
  qLog('Event: Standby State Change\r\nNew state: ' + state);
  const cameFrom = _prevStandbyState;
  _prevStandbyState = state;

  // Manage the manual Halfwake-shortening timer. Entering Halfwake (and not in a
  // call) arms the one-shot; any other state change clears a pending one so it
  // can only fire while the codec actually sits in Halfwake.
  if (state === 'Halfwake') {
    if (_inCall) cancelHalfwakeTimer('call active at Halfwake');
    else         scheduleHalfwakeTimeout(cameFrom);
  } else {
    cancelHalfwakeTimer('left Halfwake (now ' + state + ')');
  }

  // Presence-based wake: poll only while fully in Standby. Start on entry, stop
  // on any other state. A person detected while polling wakes the device.
  if (state === 'Standby' && !_inCall) startPresencePolling();
  else                                 stopPresencePolling('state is ' + state);

  if (_inCall) return;                  // a call overrides standby-driven actions
  const key = standbyKeyFor(state);
  if (key) await applyKeyAll(key);
}

async function onCallCount(n) {
  const inCall = Number(n) > 0;
  if (inCall === _inCall) return;       // no change
  _inCall = inCall;
  if (inCall) {
    cancelHalfwakeTimer('call started');
    stopPresencePolling('call started');
    qLog('Event: Call Started\r\nActive calls: ' + n);
    await applyKeyAll('call');
  } else {
    await applyContext('Call Ended');   // share check first, else standby state
  }
}

async function onPreviewStarted() {
  const calls = await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get().catch(() => 0);
  if (Number(calls) > 0) { qLog('Event: Presentation Preview Started\r\nIn a call, ignored'); return; }
  qLog('Event: Presentation Preview Started (outside call)');
  await applyKeyAll('contentShareOutsideOfCall');
}

async function onPreviewStopped() {
  const calls = await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get().catch(() => 0);
  if (Number(calls) > 0) { qLog('Event: Presentation Preview Stopped\r\nIn a call, ignored'); return; }
  await applyContext('Presentation Preview Stopped');
}

// ---- GUI helpers ----
function setWidget(id, value) {
  return xapi.Command.UserInterface.Extensions.Widget.SetValue({ WidgetId: id, Value: String(value) })
    .catch(() => {});
}
function unsetWidget(id) {
  return xapi.Command.UserInterface.Extensions.Widget.UnsetValue({ WidgetId: id }).catch(() => {});
}

// About-page line: last token refresh time, and an error note when comms fail.
function updateAbout() {
  const refreshed = lastRefreshMs ? fmt(lastRefreshMs) : 'not yet';
  const text = lastError
    ? ('Last token refresh: ' + refreshed + '\n' + lastError)
    : ('Last token refresh: ' + refreshed + '\nStatus: OK');
  setWidget('stc_about_status', text);
}
function commsError(msg) {
  if (lastError !== msg) {
    lastError = msg;
    updateAbout();
    qLog('Event: Communications Error\r\n' + msg);
  }
}
function commsOk() {
  if (lastError) { lastError = ''; updateAbout(); }   // clear note once comms recover
}

// One-time sync on panel open / page change: position the HDMI highlight, and
// set the volume slider only if status returns quickly (a slow cold-start read
// is discarded so the slider never snaps 15-30s after the page is opened).
async function syncOnOpen(i) {
  const tv = TVS[i - 1];
  if (!tv) return;
  const art = (tv.artCapability && tv.artCommand) ? 'Supported' : 'None';
  setWidget('stc_tv' + i + '_status', 'Primary: ' + tv.primaryHDMI + '    Art: ' + art);
  const openedAt = Date.now();
  try {
    const main  = await getStatus(tv);
    const fresh = (Date.now() - openedAt) < SLIDER_FRESH_MS;   // was the read fast enough to trust?
    const vol   = main.audioVolume && main.audioVolume.volume ? main.audioVolume.volume.value : null;
    const muted = main.audioMute && main.audioMute.mute ? main.audioMute.mute.value : null;
    if (vol !== null && fresh)  setWidget('stc_tv' + i + '_volume', Math.round(vol / 100 * 255));
    if (muted)                  tv._muted = (muted === 'muted');
  } catch (e) {
    const msg = 'Event: Panel Open Sync FAILED\r\nTV index: ' + i + '\r\nError: ' + JSON.stringify(e);
    console.error(msg);
    qLog(msg);
  }
}

// ---- Build Control Panel ----
function tvPageXml(tv, i) {
  const values = tv.inputs.map((key, idx) =>
    '<Value><Key>' + esc(key) + '</Key><Name>' + esc(String(idx + 1)) + '</Name></Value>').join('');
  return '' +
    '<Page><Name>' + esc(tv.name) + '</Name><PageId>stc_tv_page_' + i + '</PageId>' +
      '<Row><Name>HDMI Input</Name><Widget>' +
        '<WidgetId>stc_tv' + i + '_hdmi</WidgetId><Type>GroupButton</Type><Options>size=4</Options>' +
        '<ValueSpace>' + values + '</ValueSpace>' +
      '</Widget></Row>' +
      '<Row><Name>Artwork Mode (if supported)</Name><Widget>' +
        '<WidgetId>stc_tv' + i + '_art</WidgetId><Name>Artwork Mode</Name><Type>Button</Type><Options>size=4</Options>' +
      '</Widget></Row>' +
      '<Row><Name>TV Volume</Name>' +
        '<Widget><WidgetId>stc_tv' + i + '_volume</WidgetId><Type>Slider</Type><Options>size=3</Options></Widget>' +
        '<Widget><WidgetId>stc_tv' + i + '_mute</WidgetId><Name>Mute</Name><Type>Button</Type><Options>size=1</Options></Widget>' +
      '</Row>' +
      '<Row><Name>TV Power</Name>' +
        '<Widget><WidgetId>stc_tv' + i + '_spacer2</WidgetId><Type>Spacer</Type><Options>size=3</Options></Widget>' +
        '<Widget><WidgetId>stc_tv' + i + '_power</WidgetId><Type>Button</Type><Options>size=1;icon=power</Options></Widget>' +
      '</Row>' +
      '<Row><Name>Status</Name><Widget>' +
        '<WidgetId>stc_tv' + i + '_status</WidgetId><Name> </Name><Type>Text</Type><Options>size=4;fontSize=small;align=center</Options>' +
      '</Widget></Row>' +
    '</Page>';
}
function aboutPageXml() {
  return '' +
    '<Page><Name>About</Name><PageId>stc_tv_page_about</PageId>' +
      '<Row><Name>For more info</Name><Widget>' +
        '<WidgetId>stc_about_info</WidgetId><Name>' + esc(INFO_URL) + '</Name><Type>Text</Type><Options>size=4;fontSize=normal;align=center</Options>' +
      '</Widget></Row>' +
      '<Row><Name>Re-sync Displays</Name><Widget>' +
        '<WidgetId>stc_resync</WidgetId><Name>Re-sync Displays</Name><Type>Button</Type><Options>size=4</Options>' +
      '</Widget></Row>' +
      '<Row><Name>Video Device Action</Name><Widget>' +
        '<WidgetId>stc_codec_state</WidgetId><Type>GroupButton</Type><Options>size=4</Options>' +
        '<ValueSpace>' +
          '<Value><Key>awake</Key><Name>Awake</Name></Value>' +
          '<Value><Key>halfwake</Key><Name>Halfwake</Name></Value>' +
          '<Value><Key>standby</Key><Name>Standby</Name></Value>' +
        '</ValueSpace>' +
      '</Widget></Row>' +
      '<Row><Name>Simulate (setup only)</Name><Widget>' +
        '<WidgetId>stc_simulate</WidgetId><Type>GroupButton</Type><Options>size=4</Options>' +
        '<ValueSpace>' +
          '<Value><Key>sim_pc</Key><Name>Simulate PC select</Name></Value>' +
          '<Value><Key>sim_call</Key><Name>Simulate Call</Name></Value>' +
        '</ValueSpace>' +
      '</Widget></Row>' +
      '<Row><Name>Status</Name><Widget>' +
        '<WidgetId>stc_about_status</WidgetId><Name> </Name><Type>Text</Type><Options>size=4;fontSize=small;align=center</Options>' +
      '</Widget></Row>' +
    '</Page>';
}
async function buildPanel() {
  if (!TVS.length) { console.warn('No TVs configured.'); return; }
  const pages = TVS.map((tv, idx) => tvPageXml(tv, idx + 1)).join('') + aboutPageXml();
  const xml =
    '<Extensions><Panel>' +
      '<Order>1</Order>' +
      '<Location>ControlPanel</Location>' +
      '<Icon>Tv</Icon>' +
      '<Color>#07C1E4</Color>' +
      '<Name>' + esc(PANEL_NAME) + '</Name>' +
      '<ActivityType>Custom</ActivityType>' +
      pages +
    '</Panel></Extensions>';
  await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: PANEL_ID }, xml);
}

// ---- Widget events ----
function debounced(id) {
  const now = Date.now();
  if (lastFire[id] && now - lastFire[id] < 400) return false;
  lastFire[id] = now;
  return true;
}

xapi.Event.UserInterface.Extensions.Widget.Action.on(async (e) => {
  // Video Device Action group: drives the real codec. The resulting standby event
  // flows back through onStandbyState, which reflects the state on the buttons.
  if (e.WidgetId === 'stc_codec_state' && (e.Type === 'released' || e.Type === 'clicked')) {
    if (!debounced(e.WidgetId + e.Value)) return;
    qLog('Event: Button Press\r\nWidget: Video Device Action\r\nValue: ' + e.Value);
    if (e.Value === 'awake')         await xapi.Command.Standby.Deactivate();
    else if (e.Value === 'halfwake') await xapi.Command.Standby.Halfwake();
    else if (e.Value === 'standby')  await xapi.Command.Standby.Activate();
    unsetWidget('stc_codec_state');   // momentary: never holds a selection
    return;
  }

  // Simulate group: setup-only. Sends the display commands for a context without
  // an actual call or PC share. Does not touch the codec.
  if (e.WidgetId === 'stc_simulate' && (e.Type === 'released' || e.Type === 'clicked')) {
    if (!debounced(e.WidgetId + e.Value)) return;
    if (e.Value === 'sim_pc') {
      qLog('Event: Button Press\r\nWidget: Simulate PC select');
      await applyKeyAll('contentShareOutsideOfCall');
    } else if (e.Value === 'sim_call') {
      qLog('Event: Button Press\r\nWidget: Simulate Call');
      await applyKeyAll('call');
    }
    unsetWidget('stc_simulate');      // momentary: never holds a selection
    return;
  }

  // Re-sync Displays: ignore the Simulate buttons, read the real codec context, and
  // force the displays to match (clears tracked state so commands always re-send).
  if (e.WidgetId === 'stc_resync' && e.Type === 'clicked') {
    if (!debounced(e.WidgetId)) return;
    qLog('Event: Button Press\r\nWidget: Re-sync Displays');
    for (const tv of TVS) tv._appliedAction = null;
    await applyContext('Re-sync Displays');
    return;
  }

  const m = /^stc_tv(\d+)_(\w+)$/.exec(e.WidgetId);
  if (!m) return;
  const i  = parseInt(m[1], 10);
  const tv = TVS[i - 1];
  if (!tv) return;
  const action = m[2];

  if (action === 'hdmi' && (e.Type === 'released' || e.Type === 'clicked')) {
    if (debounced(e.WidgetId + e.Value)) {
      qLog('Event: Button Press\r\nTV: ' + tv.name + '\r\nAction: HDMI Input\r\nInput: ' + e.Value);
      await setInput(tv, e.Value);
      unsetWidget(e.WidgetId);   // momentary: never holds a selection
    }
  } else if (action === 'volume' && e.Type === 'changed') {
    await setVolume(tv, Math.round((parseInt(e.Value, 10) / 255) * 100));
  } else if (action === 'mute' && e.Type === 'clicked') {
    tv._muted = !tv._muted;
    qLog('Event: Button Press\r\nTV: ' + tv.name + '\r\nAction: Mute\r\nMute state: ' + (tv._muted ? 'Muted' : 'Unmuted'));
    await toggleMute(tv);
  } else if (action === 'power' && e.Type === 'clicked') {
    qLog('Event: Button Press\r\nTV: ' + tv.name + '\r\nAction: Power Toggle');
    await togglePower(tv);
  } else if (action === 'art' && e.Type === 'clicked') {
    qLog('Event: Button Press\r\nTV: ' + tv.name + '\r\nAction: Art Mode');
    await artMode(tv);
  }
});

// ---- Sync GUI on page open / tab switch ----
xapi.Event.UserInterface.Extensions.Page.Action.on((e) => {
  if (e.Type === 'Opened') {
    if (e.PageId === 'stc_tv_page_about') { updateAbout(); return; }
    const m = /^stc_tv_page_(\d+)$/.exec(e.PageId || '');
    if (m) syncOnOpen(parseInt(m[1], 10));
  }
});

// ---- Codec state change listeners ----
xapi.Status.Standby.State.on(async (value) => { await onStandbyState(value); });
xapi.Status.SystemUnit.State.NumberOfActiveCalls.on(async (n) => { await onCallCount(n); });
xapi.Event.PresentationPreviewStarted.on(async () => { await onPreviewStarted(); });
xapi.Event.PresentationPreviewStopped.on(async () => { await onPreviewStopped(); });

// Presence sensors: wake from Standby when a person is detected. These fire on
// change; the Standby poll covers the already-present-before-sleep case.
xapi.Status.RoomAnalytics.PeoplePresence.on(async (value) => {
  if (WAKE_ON_PRESENCE && value === 'Yes') await presenceWake('PeoplePresence');
});
xapi.Status.RoomAnalytics.PeopleCount.Current.on(async (value) => {
  if (WAKE_ON_PRESENCE && Number(value) >= 1) await presenceWake('PeopleCount');
});

// ---- Startup ----
async function init() {
  try {
    await xapi.Config.HttpClient.Mode.set('On');
    loadSettings();
    await enablePresenceSensors();              // make sure presence sensors run, even in Standby
    await buildPanel();
    await getAccessToken();                     // refresh only if the stored token is near expiry
    setInterval(keepAliveRefresh, REFRESH_MS);   // forced rotation only on the 8-hour timer
    setInterval(keepAliveStatus,   KEEPALIVE_MS); // hourly ping to keep TV network stack warm

    const standbyState = await xapi.Status.Standby.State.get();
    const callCount    = await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get().catch(() => 0);
    _inCall = Number(callCount) > 0;            // seed the in-call guard used by onStandbyState
    _prevStandbyState = standbyState;           // seed prior-state tracking for the Halfwake timer
    await applyContext('Macro Started');        // call > share > standby, in priority order

    // If the macro (re)started while the codec is already sitting in Halfwake, the
    // prior direction is unknown. Arm the timer anyway so it doesn't hang in
    // Halfwake; with no known direction it resolves to Awake (the safe default).
    if (standbyState === 'Halfwake' && !_inCall) {
      qLog('Event: Macro Started\r\nBooted into Halfwake -> arming timer (direction unknown -> Awake)');
      scheduleHalfwakeTimeout(null);
    }

    // If booted into Standby, begin watching presence so the device can wake.
    if (standbyState === 'Standby' && !_inCall) startPresencePolling();

    const msg = 'Event: Macro Started\r\nTV count: ' + TVS.length + '\r\nInitial standby state: ' + standbyState + '\r\nIn call: ' + _inCall;
    console.log(msg);
    qLog(msg);
  } catch (e) {
    const msg = 'Event: Macro Start FAILED\r\nError: ' + JSON.stringify(e);
    console.error(msg);
    qLog(msg);
  }
}
init();
