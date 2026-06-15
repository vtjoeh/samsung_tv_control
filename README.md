# Cisco RoomOS Samsung TV Control

A Cisco RoomOS macro that controls 1 to 4 Samsung TVs via the SmartThings cloud API. No bridge, no extra server, and no ongoing maintenance required. The macro builds its own Control Panel with one page per TV (HDMI input switching, volume slider, mute, artwork/ambient mode, and TV power) plus a shared About page holding the GitHub link, last token refresh time, and a Video Device group button (Awake / Halfwake / Standby) that drives both the codec and the TVs together. On panel open the HDMI highlight and volume slider are synced from live TV state. The access token refreshes every 8 hours and rotates the refresh token to a local storage macro, keeping the integration alive indefinitely as long as the codec is online at least once every 29 days.

This integration is primarily useful in two scenarios. First, it enables the Cisco codec to automatically put a Samsung Frame TV into Art Mode when the room goes to half-wake or standby, which is not possible via HDMI CEC since CEC has no opcode for Art Mode. Second, it solves a common problem in rooms where an HDMI distribution amplifier or matrix switch disrupts HDMI CEC signaling, preventing the codec from telling a Samsung TV to sleep or wake via the normal CEC path. Since this integration communicates through the SmartThings cloud rather than over HDMI, it is completely independent of CEC and works regardless of what is in the signal chain.

Each TV in the `DEFAULT_TVS` array has three per-display standby flags: `powerOffOnStandby`, `artModeOnHalfwake`, and `powerOnWhenAwake`. These let you independently control how each display behaves when the codec changes wake state, so a display without art mode support or one you never want to power off can be configured independently. The manual panel buttons always attempt their command regardless of the flags. OAuth credentials and TV device IDs live directly in `SamsungTVControl.js`; do not commit your filled-in copy to a public repo.

<img width="533" height="325" alt="image" src="https://github.com/user-attachments/assets/0350d954-01a1-40bc-bc7f-6d28ba777fe9" />


## Setup

See [SetupSmartTVControl.md](SetupSmartTVControl.md) for full step-by-step instructions covering Mac and Windows. At a high level: install the SmartThings CLI, create an OAuth-In app, do a one-time browser authorization using `https://httpbin.org/get` as the redirect URI, exchange the code for a refresh token, look up your TV device IDs, fill in the placeholder blocks in `SamsungTVControl.js`, enable `HttpClient Mode` on the codec, and load the macro. Add `SamsungTV_Store.js` to your `.gitignore` to avoid accidentally publishing a live token.
