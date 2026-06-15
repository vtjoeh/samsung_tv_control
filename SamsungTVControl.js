import xapi from 'xapi';

/*
 * Samsung TV control via SmartThings OAuth (no bridge), 1 to 4 displays.
 *
 * For more info go to https://github.com/vtjoeh/samsung_tv_control
 *
 * All configuration is in the DEFAULT_OAUTH and DEFAULT_TVS constants below.
 * The macro builds its own Control Panel: one page per TV, plus an About page.
 * Rotating OAuth token state is auto-saved to a local macro (STORE).
 *
 * Features:
 *  - 8-hour scheduled token refresh (keeps the 29-day chain alive with no button presses).
 *  - Mute is a true toggle (local state tracking).
 *  - Volume slider; the slider is positioned from live state on panel open.
 *  - Per-display standby behavior via flags:
 *      powerOffOnStandby : power the TV off when codec enters Standby
 *      artModeOnHalfwake : trigger Art/Ambient mode when codec enters Halfwake
 *      powerOnWhenAwake  : power on (and switch to primaryHDMI when fully awake)
 *  - On macro start the current standby state is read and applied immediately.
 *  - Transient SmartThings errors (common when a TV is waking) are retried.
 *  - About page shows the info link, last token refresh time, and any error note.
 */

// ===================== CONFIGURATION =====================
const PANEL_ID    = 'samsung_tv';
const PANEL_NAME  = 'TVs';
const INFO_URL    = 'https://github.com/vtjoeh/samsung_tv_control';
const REFRESH_MS     = 8 * 60 * 60 * 1000;   // scheduled token refresh interval (8 hours)
const SLIDER_FRESH_MS = 2500;                // only trust an on-open volume read this fast (ms)
const STATUS_RETRIES  = 3;                   // attempts for a status read before giving up
const STATUS_RETRY_MS = 1500;                // wait between status retries (ms)

const DEFAULT_OAUTH = {
  client: 'YOUR_CLIENT_ID',
  secret: 'YOUR_CLIENT_SECRET',
  seed:   'YOUR_SEED_REFRESH_TOKEN'
};

// One entry per TV. Add or remove entries; up to 4 are supported.
// A TV with a blank deviceId is skipped and gets no panel page.
const DEFAULT_TVS = [
  {
    name:              'TV 1',
    deviceId:          'YOUR_TV1_DEVICE_ID',
    inputs:            ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:       'HDMI1',
    artCapability:     'samsungvd.ambient',   // '' to disable the art button
    artCommand:        'setAmbientOn',
    powerOffOnStandby: true,
    artModeOnHalfwake: false,
    powerOnWhenAwake:  true
  },
  {
    name:              'TV 2',
    deviceId:          'YOUR_TV2_DEVICE_ID',
    inputs:            ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:       'HDMI1',
    artCapability:     'samsungvd.ambient',
    artCommand:        'setAmbientOn',
    powerOffOnStandby: false,
    artModeOnHalfwake: true,
    powerOnWhenAwake:  true
  },
  {
    name:              'TV 3',
    deviceId:          'YOUR_TV3_DEVICE_ID',
    inputs:            ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:       'HDMI1',
    artCapability:     'samsungvd.ambient',
    artCommand:        'setAmbientOn',
    powerOffOnStandby: false,
    artModeOnHalfwake: true,
    powerOnWhenAwake:  true
  }
];
// ========================================================

const STORE       = 'SamsungTV_Store';
const TOKEN_URL   = 'https://api.smartthings.com/oauth/token';
const DEVICE_BASE = 'https://api.smartthings.com/v1/devices/';

let OAUTH = null;
let TVS   = null;
const lastFire     = {};
let lastRefreshMs  = 0;        // when the token was last refreshed
let lastError      = '';       // current comms error note ('' = healthy)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    name:              t.name || 'TV',
    deviceId:          t.deviceId,
    inputs:            t.inputs || ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:       t.primaryHDMI || 'HDMI1',
    artCapability:     t.artCapability || '',
    artCommand:        t.artCommand || '',
    powerOffOnStandby: t.powerOffOnStandby !== false,
    artModeOnHalfwake: t.artModeOnHalfwake !== false,
    powerOnWhenAwake:  t.powerOnWhenAwake  !== false
  }));
}

// ---- Token state persistence (local storage macro) ----
// The store file gets a human-readable header comment plus a single JSON line.
// readStore extracts the JSON object regardless of the surrounding comment.
async function readStore() {
  try {
    const res = await xapi.Command.Macros.Macro.Get({ Name: STORE, Content: 'True' });
    const text = res.Macro[0].Content || '';
    const match = text.match(/\{[\s\S]*\}/);   // grab the JSON object, ignoring any comment
    return match ? JSON.parse(match[0]) : null;
  } catch (e) { return null; }
}
function fmt(ms) {
  // Compact UTC stamp like 2026-06-15 03:00:00z
  const d = new Date(ms);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'z';
}
async function writeStore(state) {
  const now     = Date.now();
  const nextRun = now + REFRESH_MS;
  const expires = now + (29 * 24 * 60 * 60 * 1000);   // refresh token ~29 day lifetime
  const header =
    '/* DO NOT DELETE\n' +
    ' *\n' +
    ' * Used by the SamsungTVControl macro. Holds the rotating OAuth token.\n' +
    ' * Leave this macro DISABLED. It is data only and must never be activated.\n' +
    ' * Last update: ' + fmt(now) + '   next update: ' + fmt(nextRun) + '\n' +
    ' * Refresh token expires on: ' + fmt(expires) + ' if the device is offline until then.\n' +
    ' */\n';
  await xapi.Command.Macros.Macro.Save({ Name: STORE, Overwrite: 'True' }, header + JSON.stringify(state));
}

// ---- OAuth refresh ----
async function refreshAccess(refreshToken) {
  const basic = b64(OAUTH.client + ':' + OAUTH.secret);
  const body  = 'grant_type=refresh_token&client_id=' + OAUTH.client + '&refresh_token=' + refreshToken;
  const res = await xapi.Command.HttpClient.Post({
    Url: TOKEN_URL,
    Header: ['Authorization: Basic ' + basic, 'Content-Type: application/x-www-form-urlencoded'],
    AllowInsecureHTTPS: 'False',
    ResultBody: 'PlainText'
  }, body);
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
    console.log('Scheduled token refresh complete.');
  } catch (e) {
    console.error('Scheduled refresh failed: ' + JSON.stringify(e));
  }
}

// ---- SmartThings HTTP helpers ----
async function rawPost(deviceId, token, commands) {
  return xapi.Command.HttpClient.Post({
    Url: DEVICE_BASE + deviceId + '/commands',
    Header: ['Authorization: Bearer ' + token, 'Content-Type: application/json'],
    AllowInsecureHTTPS: 'False',
    ResultBody: 'PlainText'
  }, JSON.stringify({ commands }));
}
async function sendTo(tv, parts) {
  const commands = parts.map(p => Object.assign({ component: 'main' }, p));
  try {
    return await rawPost(tv.deviceId, await getAccessToken(), commands);
  } catch (e) {
    try {
      const store = await readStore();
      const seed  = (store && store.refresh_token) ? store.refresh_token : OAUTH.seed;
      const fresh = await refreshAccess(seed);
      return await rawPost(tv.deviceId, fresh.access_token, commands);
    } catch (e2) { console.error('Samsung command failed: ' + JSON.stringify(e2)); }
  }
}
async function getStatus(tv) {
  // Retry transient failures (400/500 are common while a TV is waking up).
  let lastErr;
  for (let attempt = 0; attempt < STATUS_RETRIES; attempt++) {
    try {
      const token = await getAccessToken();
      const res = await xapi.Command.HttpClient.Get({
        Url: DEVICE_BASE + tv.deviceId + '/status',
        Header: ['Authorization: Bearer ' + token],
        AllowInsecureHTTPS: 'False',
        ResultBody: 'PlainText'
      });
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
  } catch (e) { console.error('power toggle failed: ' + JSON.stringify(e)); }
}
async function toggleMute(tv) {
  try {
    tv._muted = !tv._muted;
    await sendTo(tv, [{ capability: 'audioMute', command: tv._muted ? 'mute' : 'unmute' }]);
  } catch (e) { console.error('mute toggle failed: ' + JSON.stringify(e)); }
}
function setInput(tv, key)  { return sendTo(tv, [{ capability: 'mediaInputSource', command: 'setInputSource', arguments: [key] }]); }
function setVolume(tv, lvl) { return sendTo(tv, [{ capability: 'audioVolume', command: 'setVolume', arguments: [lvl] }]); }
function powerOn(tv)        { return sendTo(tv, [{ capability: 'switch', command: 'on' }]); }
function powerOff(tv)       { return sendTo(tv, [{ capability: 'switch', command: 'off' }]); }
function artMode(tv) {
  if (!tv.artCapability || !tv.artCommand) { console.warn('Art mode not configured for ' + tv.name); return; }
  return sendTo(tv, [{ capability: tv.artCapability, command: tv.artCommand, arguments: [] }]);
}

// ---- Standby integration (per-display flags gate automatic behavior only) ----
async function applyStandbyState(state) {
  console.log('Standby state: ' + state);
  if (!TVS || !TVS.length) return;
  for (const tv of TVS) {
    try {
      if (state === 'Off') {                 // fully awake
        if (tv.powerOnWhenAwake) {
          await powerOn(tv);
          await setInput(tv, tv.primaryHDMI);
        }
      } else if (state === 'Halfwake') {     // partial wake: power on only, plus art if enabled
        if (tv.powerOnWhenAwake) await powerOn(tv);
        if (tv.artModeOnHalfwake) await artMode(tv);
      } else if (state === 'Standby') {      // asleep
        if (tv.powerOffOnStandby) await powerOff(tv);
      }
    } catch (e) {
      console.error('standby apply failed for ' + tv.name + ': ' + JSON.stringify(e));
    }
  }
}

// ---- GUI helpers ----
function setWidget(id, value) {
  return xapi.Command.UserInterface.Extensions.Widget.SetValue({ WidgetId: id, Value: String(value) })
    .catch(() => {});
}
// About-page line: last token refresh time, and an error note when comms fail.
function updateAbout() {
  const refreshed = lastRefreshMs ? fmt(lastRefreshMs) : 'not yet';
  const text = lastError
    ? ('Last token refresh: ' + refreshed + '\n' + lastError)
    : ('Last token refresh: ' + refreshed + '\nStatus: OK');
  setWidget('about_status', text);
}
function commsError(msg) {
  if (lastError !== msg) { lastError = msg; updateAbout(); }
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
  setWidget('tv' + i + '_status', 'Primary: ' + tv.primaryHDMI + '    Art: ' + art);
  const openedAt = Date.now();
  try {
    const main  = await getStatus(tv);
    const fresh = (Date.now() - openedAt) < SLIDER_FRESH_MS;   // was the read fast enough to trust?
    const input = main.mediaInputSource && main.mediaInputSource.inputSource
                    ? main.mediaInputSource.inputSource.value : null;
    const vol   = main.audioVolume && main.audioVolume.volume ? main.audioVolume.volume.value : null;
    const muted = main.audioMute && main.audioMute.mute ? main.audioMute.mute.value : null;
    if (input)                  setWidget('tv' + i + '_hdmi', input);
    if (vol !== null && fresh)  setWidget('tv' + i + '_volume', Math.round(vol / 100 * 255));
    if (muted)                  tv._muted = (muted === 'muted');
  } catch (e) {
    console.error('open sync failed for TV ' + i + ': ' + JSON.stringify(e));
  }
}

// ---- Build Control Panel ----
function tvPageXml(tv, i) {
  const values = tv.inputs.map((key, idx) =>
    '<Value><Key>' + esc(key) + '</Key><Name>' + esc(String(idx + 1)) + '</Name></Value>').join('');
  return '' +
    '<Page><Name>' + esc(tv.name) + '</Name><PageId>tv_page_' + i + '</PageId>' +
      '<Row><Name>HDMI Input</Name><Widget>' +
        '<WidgetId>tv' + i + '_hdmi</WidgetId><Type>GroupButton</Type><Options>size=4</Options>' +
        '<ValueSpace>' + values + '</ValueSpace>' +
      '</Widget></Row>' +
      '<Row><Name>Artwork Mode (if supported)</Name><Widget>' +
        '<WidgetId>tv' + i + '_art</WidgetId><Name>Artwork Mode</Name><Type>Button</Type><Options>size=4</Options>' +
      '</Widget></Row>' +
      '<Row><Name>TV Volume</Name>' +
        '<Widget><WidgetId>tv' + i + '_volume</WidgetId><Type>Slider</Type><Options>size=3</Options></Widget>' +
        '<Widget><WidgetId>tv' + i + '_mute</WidgetId><Name>Mute</Name><Type>Button</Type><Options>size=1</Options></Widget>' +
      '</Row>' +
      '<Row><Name>TV Power</Name>' +
        '<Widget><WidgetId>tv' + i + '_spacer2</WidgetId><Type>Spacer</Type><Options>size=3</Options></Widget>' +
        '<Widget><WidgetId>tv' + i + '_power</WidgetId><Type>Button</Type><Options>size=1;icon=power</Options></Widget>' +
      '</Row>' +
      '<Row><Name>Status</Name><Widget>' +
        '<WidgetId>tv' + i + '_status</WidgetId><Name> </Name><Type>Text</Type><Options>size=4;fontSize=small;align=center</Options>' +
      '</Widget></Row>' +
    '</Page>';
}
function aboutPageXml() {
  return '' +
    '<Page><Name>About</Name><PageId>tv_page_about</PageId>' +
      '<Row><Name>For more info</Name><Widget>' +
        '<WidgetId>about_info</WidgetId><Name>' + esc(INFO_URL) + '</Name><Type>Text</Type><Options>size=4;fontSize=normal;align=center</Options>' +
      '</Widget></Row>' +
      '<Row><Name>Video Device</Name><Widget>' +
        '<WidgetId>codec_state</WidgetId><Type>GroupButton</Type><Options>size=4</Options>' +
        '<ValueSpace>' +
          '<Value><Key>awake</Key><Name>Awake</Name></Value>' +
          '<Value><Key>halfwake</Key><Name>Halfwake</Name></Value>' +
          '<Value><Key>standby</Key><Name>Standby</Name></Value>' +
        '</ValueSpace>' +
      '</Widget></Row>' +
      '<Row><Name>Status</Name><Widget>' +
        '<WidgetId>about_status</WidgetId><Name> </Name><Type>Text</Type><Options>size=4;fontSize=small;align=center</Options>' +
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
  // Shared codec control on the About page
  if (e.WidgetId === 'codec_state' && (e.Type === 'released' || e.Type === 'clicked')) {
    if (!debounced(e.WidgetId + e.Value)) return;
    if (e.Value === 'awake')         await xapi.Command.Standby.Deactivate();
    else if (e.Value === 'halfwake') await xapi.Command.Standby.Halfwake();
    else if (e.Value === 'standby')  await xapi.Command.Standby.Activate();
    return;
  }

  const m = /^tv(\d+)_(\w+)$/.exec(e.WidgetId);
  if (!m) return;
  const i  = parseInt(m[1], 10);
  const tv = TVS[i - 1];
  if (!tv) return;
  const action = m[2];

  if (action === 'hdmi' && (e.Type === 'released' || e.Type === 'clicked')) {
    if (debounced(e.WidgetId + e.Value)) await setInput(tv, e.Value);
  } else if (action === 'volume' && e.Type === 'changed') {
    await setVolume(tv, Math.round((parseInt(e.Value, 10) / 255) * 100));
  } else if (action === 'mute' && e.Type === 'clicked') {
    await toggleMute(tv);
  } else if (action === 'power' && e.Type === 'clicked') {
    await togglePower(tv);
  } else if (action === 'art' && e.Type === 'clicked') {
    await artMode(tv);
  }
});

// ---- Sync GUI on page open / tab switch ----
xapi.Event.UserInterface.Extensions.Page.Action.on((e) => {
  if (e.Type === 'Opened') {
    if (e.PageId === 'tv_page_about') { updateAbout(); return; }
    const m = /^tv_page_(\d+)$/.exec(e.PageId || '');
    if (m) syncOnOpen(parseInt(m[1], 10));
  }
});

// ---- Standby state change listener ----
xapi.Status.Standby.State.on(async (value) => {
  await applyStandbyState(value);
});

// ---- Startup ----
async function init() {
  try {
    await xapi.Config.HttpClient.Mode.set('On');
    loadSettings();
    await buildPanel();
    await getAccessToken();                     // refresh only if the stored token is near expiry
    setInterval(keepAliveRefresh, REFRESH_MS);  // forced rotation only on the 8-hour timer

    const standbyState = await xapi.Status.Standby.State.get();
    await applyStandbyState(standbyState);

    console.log('Samsung TV control macro started with ' + TVS.length + ' TV(s).');
  } catch (e) {
    console.error('Init failed: ' + JSON.stringify(e));
  }
}
init();
