f# Cisco RoomOS Samsung TV Control

A Cisco RoomOS macro that controls 1 to 4 Samsung TVs via the SmartThings cloud API. No bridge, no extra server, and no ongoing maintenance required. The macro builds its own Control Panel with one page per TV. 

This integration is primarily useful in two scenarios: 
- It enables the Cisco codec to automatically put a Samsung Frame TV into Art Mode when the room goes to half-wake or standby, which is not possible via HDMI CEC since CEC has no opcode for Art Mode. 
- It solves a common problem in rooms where an HDMI distribution amplifier or matrix switch disrupts HDMI CEC signaling, preventing the codec from telling a Samsung TV to sleep or wake via the normal CEC path. 

Each TV in the `DEFAULT_TVS` array has five per-display state keys that map a codec state to an action: 
- `standby`, 
- `halfwake` 
- `standbyOff` (fully awake, also the post-call baseline) 
- `call`, and 
- `contentShareOutsideOfCall`. 
Each key below takes `'on'`, `'off'`, `'art'`, or a schedule object `BUSINES_HOURS`. 

Options: 
- `HALFWAKE_TIMER` manually shortens the Halfwake stage: after the set number of seconds the macro moves the codec the opposite direction from wherever it came (woke from Standby -> fully Awake; heading to sleep from Awake -> Standby), or set it to `'off'`/`0` to leave RoomOS timing untouched. 
- `WAKE_ON_PRESENCE` (default off) is a Desk Pro workaround that wakes the device from Standby on people-sensor detection, for devices that do not reliably wake on motion; camera-based rooms such as a Room Kit EQ with the Quad Camera wake natively and do not need it. Note that presence-wake ignores native Office Hours, so if `Time OfficeHours OutsideOfficeHours Standby AutoWakeup` is set to Disabled, the macro will still wake the device on presence.

OAuth credentials and TV device IDs live directly in `SamsungTVControl.js`; do not commit your filled-in copy to a public repo. The access token refreshes every 8 hours and rotates the refresh token to a local storage macro, keeping the integration alive indefinitely as long as the codec is online at least once every 29 days.

<img width="1060" height="650" alt="screenShot" src="https://github.com/user-attachments/assets/d7564728-40b3-4957-a93c-e8b4991c10d5" />

## Setup

See [SetupSmartTVControl.md](SetupSmartTVControl.md) for full step-by-step instructions covering Mac and Windows. At a high level: install the SmartThings CLI, create an OAuth-In app, do a one-time browser authorization using `https://httpbin.org/get` as the redirect URI, exchange the code for a refresh token, look up your TV device IDs, fill in the placeholder blocks in `SamsungTVControl.js`, enable `HttpClient Mode` on the codec, and load the macro. Add `SamsungTV_Store.js` to your `.gitignore` to avoid accidentally publishing a live token.
