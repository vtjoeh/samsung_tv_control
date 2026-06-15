# Samsung TV Control for Cisco RoomOS — Setup Guide

Control 1 to 4 Samsung TVs from a Cisco RoomOS device using the SmartThings cloud API. No bridge or extra server required. The macro builds its own Control Panel, syncs the GUI on open, and integrates with the codec's standby state.

---

## Prerequisites

- A SmartThings account with your Samsung TV(s) already added in the SmartThings mobile app
- A Cisco RoomOS device (RoomOS 11.x)
- The `SamsungTVControl.js` macro file
- A computer (Mac or Windows) to run the one-time setup

---

## Step 1: Install the SmartThings CLI

### macOS

```bash
brew install smartthingscommunity/smartthings/smartthings
```

If Homebrew refuses to load the formula from an untrusted tap, run:

```bash
brew trust --formula smartthingscommunity/smartthings/smartthings
```

Then retry the install. Verify:

```bash
smartthings --version
```

### Windows

1. Go to the CLI releases page: https://github.com/SmartThingsCommunity/smartthings-cli/releases
2. Download the latest `smartthings-windows.msi` (or the standalone `.exe` if you prefer no install).
3. Run the installer, then open a new Command Prompt or PowerShell window.
4. Verify:

```powershell
smartthings --version
```

> If `smartthings` is not recognized, use the full path to the downloaded `.exe`, or add its folder to your PATH.

---

## Step 2: Create the OAuth App

```bash
smartthings apps:create
```

A browser opens to log in with your Samsung account. Approve, then return to the terminal and answer the prompts:

| Prompt | Value |
|---|---|
| What kind of app | OAuth-In App |
| Display Name | CiscoSamsungTV (any name) |
| Description | Cisco RoomOS Samsung TV control |
| Icon Image URL | *(press Enter to skip)* |
| Target URL | `https://httpbin.org/get` |
| Scopes | `r:devices:*` and `x:devices:*` |
| Redirect URI | `https://httpbin.org/get` |

At the end the CLI prints your credentials. **Save both now — they are shown only once.**

```
OAuth Client Id      xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OAuth Client Secret  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> Do not use `https://localhost` as the redirect URI. It causes a 403 error during authorization. Use `https://httpbin.org/get`.

---

## Step 3: Get the Authorization Code

Paste this URL into a browser, replacing `YOUR_CLIENT_ID`:

```
https://api.smartthings.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://httpbin.org/get&scope=r:devices:*+x:devices:*
```

Log in, approve access, and **make sure your TV(s) are selected** on the device consent screen. The browser lands on an httpbin JSON page. Copy the `code` value from the URL bar or the `args` section of the JSON. The code is valid for a few minutes.

---

## Step 4: Exchange the Code for a Refresh Token

### macOS

```bash
curl -X POST "https://api.smartthings.com/oauth/token" \
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&client_id=YOUR_CLIENT_ID&code=YOUR_CODE&redirect_uri=https://httpbin.org/get"
```

### Windows (PowerShell)

```powershell
curl.exe -X POST "https://api.smartthings.com/oauth/token" `
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" `
  -H "Content-Type: application/x-www-form-urlencoded" `
  -d "grant_type=authorization_code&client_id=YOUR_CLIENT_ID&code=YOUR_CODE&redirect_uri=https://httpbin.org/get"
```

The response contains your tokens:

```json
{
  "access_token": "xxxxxxxx-...",
  "refresh_token": "xxxxxxxx-...",
  "expires_in": 86399,
  "scope": "r:devices:* x:devices:*"
}
```

**Save the `refresh_token`.** This is your seed refresh token. Also keep the `access_token` for the next step.

---

## Step 5: Get Your TV Device ID(s)

### macOS

```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  "https://api.smartthings.com/v1/devices"
```

### Windows (PowerShell)

```powershell
curl.exe -H "Authorization: Bearer YOUR_ACCESS_TOKEN" "https://api.smartthings.com/v1/devices"
```

Find each Samsung TV by name in the JSON and copy its `deviceId`. It is a UUID like:

```
8cb41ce6-b21e-beac-6eed-1f790096b898
```

Copy only the UUID. Do not include any part of the URL.

---

## Step 6: Configure the Macro

Open `SamsungTVControl.js` and fill in the two configuration blocks near the top.

### 6a: OAuth credentials

```javascript
const DEFAULT_OAUTH = {
  client: 'YOUR_CLIENT_ID',
  secret: 'YOUR_CLIENT_SECRET',
  seed:   'YOUR_SEED_REFRESH_TOKEN'
};
```

Replace:
- `YOUR_CLIENT_ID` with the OAuth Client Id from Step 2
- `YOUR_CLIENT_SECRET` with the OAuth Client Secret from Step 2
- `YOUR_SEED_REFRESH_TOKEN` with the `refresh_token` from Step 4

### 6b: TV settings

The file ships with three TV entries. Fill in the device IDs you want and delete any entries you do not need.

```javascript
const DEFAULT_TVS = [
  {
    name:              'TV 1',
    deviceId:          'YOUR_TV1_DEVICE_ID',
    inputs:            ['HDMI1', 'HDMI2', 'HDMI3'],
    primaryHDMI:       'HDMI1',
    artCapability:     'samsungvd.ambient',
    artCommand:        'setAmbientOn',
    powerOffOnStandby: true,
    artModeOnHalfwake: true,
    powerOnWhenAwake:  true
  },
  // TV 2 and TV 3 follow the same shape
];
```

Replace `YOUR_TV1_DEVICE_ID` (and `YOUR_TV2_DEVICE_ID`, `YOUR_TV3_DEVICE_ID`) with the device IDs from Step 5. A TV with a blank `deviceId` is skipped and gets no panel page.

### Per-TV settings reference

| Field | Purpose |
|---|---|
| `name` | Page title shown on the panel tab |
| `deviceId` | SmartThings device UUID (blank = disabled) |
| `inputs` | HDMI buttons shown, in order |
| `primaryHDMI` | Input selected when the codec wakes fully |
| `artCapability` / `artCommand` | Art/Ambient mode command (`''` disables the art button) |
| `powerOffOnStandby` | `true` = power the TV off when the codec sleeps |
| `artModeOnHalfwake` | `true` = trigger art mode when the codec half-wakes |
| `powerOnWhenAwake` | `true` = power on (and select primaryHDMI) when the codec wakes |

> The flags only affect automatic standby behavior. The manual panel buttons always attempt their command regardless of the flags.

---

## Step 7: Enable HttpClient on the Device

In the device web UI (`https://DEVICE-IP`) or Control Hub, set:

| Setting | Value |
|---|---|
| `HttpClient Mode` | On |
| `HttpClient AllowInsecureHTTPS` | False |

The macro also sets `HttpClient Mode` to On at startup, but enabling it here first avoids a first-run failure.

---

## Step 8: Load the Macro

You can load the macro locally on the device or centrally through Control Hub.

**Local (device web interface):**

1. Open the device web UI at `https://DEVICE-IP` (or `https://localhost` when connected directly to the device).
2. Go to **Macro Editor -> Import from file** (or New) -> load `SamsungTVControl.js` -> Save -> Activate.

**Control Hub (`https://admin.webex.com`):**

1. Sign in at `https://admin.webex.com`.
2. Go to **Management -> Devices** and select the device.
3. Open **Macros** (or **Configurations -> Macros**, depending on your view).
4. Add a new macro, paste or upload `SamsungTVControl.js`, Save, and Activate. Control Hub pushes it to the device.

**Then, for either method:**

5. Leave the auto-created `SamsungTV_Store` macro **disabled**. It is data only, holds the rotating token, and must never be activated or deleted while the integration is running.
6. Open the **Control Panel** on the Navigator or Touch controller -> **TVs** -> test each page.

> You do not need to reboot the codec to apply changes. Just restart the macro: toggle it off and back on in the Macro Editor, or press Save. The macro rebuilds its panel and re-reads its token on every restart.

---

## Multiple Room Deployments

Use the **same OAuth Client ID and Client Secret in every room**. You do not create a separate OAuth app per room. The only value that must be unique per codec is the refresh token (`seed`), because refresh tokens are single-holder: if two codecs share one refresh token, they invalidate each other on rotation.

For each room:

1. Repeat only **Step 3** (browser authorization) and **Step 4** (token exchange) to mint a unique refresh token.
2. Put that token in that room's `DEFAULT_OAUTH.seed`, keeping `client` and `secret` identical across all rooms.
3. Use the correct `deviceId` for that room's TV(s).

Notes:
- If all TVs are in one Samsung account and location, a single authorization sees every TV, so you reuse the relevant `deviceId` per room. If TVs span different Samsung accounts, authorize once per account.
- SmartThings rate-limits token requests to 120 per hour per client ID, which is ample for the 8-hour refresh cycle across many rooms.

---

## How It Works

- **Tokens.** The macro refreshes the access token every 8 hours and persists the rotating refresh token to the `SamsungTV_Store` macro. As long as the device is online at least once every 29 days, it runs indefinitely with no user interaction.
- **GUI sync.** When you open the panel or switch TV tabs, the macro reads the TV once and sets the HDMI highlight (and the volume slider if the read returns quickly). The status line shows static config info (`Primary` input and whether `Art` is supported).
- **Resilience.** Transient SmartThings errors, common when a TV is just waking, are retried automatically. The About page shows the last token refresh time and any current error note, which clears once communication recovers.
- **Standby.** When the codec changes wake state, the macro applies each TV's flags: power off on standby, art on half-wake, power on and primary input when awake. The Video Device buttons (Awake / Halfwake / Standby) on the About page drive the codec, which then cascades to the TVs.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| 403 during Step 3 authorize | Redirect URI was `https://localhost`. Recreate the app with `https://httpbin.org/get`. |
| `invalid_grant` on a manual refresh | The seed was already rotated by the macro. The live token now lives in `SamsungTV_Store`. Do not clear that macro. |
| Commands return 403 `Not authorized` | The device ID is wrong, or the TV was not selected during authorization. Re-run Step 5 and confirm the exact `deviceId`. |
| 401 on a command | The access token expired. The macro auto-refreshes; if testing by hand, refresh first. |
| "No available http connections" at boot | Transient startup race. It self-recovers on the next action. |

---

## Re-Authorizing (rare)

If the device is offline for more than 29 days, the refresh token chain lapses. To recover:

1. Repeat Steps 3 and 4 to get a new seed refresh token.
2. Update `seed` in `DEFAULT_OAUTH`.
3. In the Macro Editor, set the `SamsungTV_Store` content to `{}` and save.
4. Reboot the device.
