# Multi Game Presence

A small, dependency-free Discord desktop console script that cycles through Discord's official **detectable games** list and shows a different "Playing" status over time.

> **Disclaimer:** This project is for educational and testing purposes only. It modifies Discord's internal client state and may violate Discord's Terms of Service. Use it on an account you can afford to lose. Badge progress is **not guaranteed**. This project is not affiliated with, endorsed by, or supported by Discord.

## Features

- Fetches Discord's public detectable games list from `/api/v9/applications/detectable`.
- Picks games you have not used yet, so the status has real variety.
- Injects a synthetic game into `RunningGameStore` with a real `application_id` and icon.
- Dispatches `RUNNING_GAMES_CHANGE` and `LOCAL_ACTIVITY_UPDATE` through the Flux dispatcher.
- Restores every patched method when stopped.
- No token, cookie, `localStorage`, or webhook access. The only network call is the same-origin detectable games GET.

## Requirements

- Discord **desktop** (stable or PTB), not the web client.
- DevTools console access (`Ctrl + Shift + I`).
- Optional: Vencord. The script tries `Vencord.Webpack` first, then falls back to `webpackChunkdiscord_app`.

## Usage

1. Open Discord desktop and log in.
2. Press `Ctrl + Shift + I` and open the **Console** tab.
3. Paste the contents of [`multi-game-presence.js`](./multi-game-presence.js) and press Enter.
4. Wait for `[MGP] Playing: ...`.
5. Stop and restore the client:

```js
window.__multiGamePresence.stop()
```

## API

```js
window.__multiGamePresence.stop()                  // stop and restore
window.__multiGamePresence.current                 // current fake game name
window.__multiGamePresence.remaining               // unique games left before reshuffle
window.__multiGamePresence.next()                  // switch now
window.__multiGamePresence.pauseSwitching()        // keep the current game (good for hours)
window.__multiGamePresence.resumeSwitching()       // resume auto-switch
window.__multiGamePresence.setIntervalMinutes(8, 15)
window.__multiGamePresence.ignoreRealGame(/obs/i)  // ignore another app Discord detects as a game
```

Default switch interval is **23–38 minutes**.

## How it works

1. Discord exposes its public detectable games list. Each entry has an app id, name, icon hash, and executables.
2. The script picks a game the current session has not used.
3. It patches `RunningGameStore` so `getRunningGames()` includes a synthetic game object with that app's id.
4. It dispatches the same Flux actions Discord uses when a game is detected.
5. Discord's heartbeat manager reads the patched store and may send `running_game_heartbeat` events.

No Discord token is read or sent anywhere.

## Important notes

- **Synthetic PID:** the fake game uses a random PID that does not correspond to a real process. Discord may try to attach its overlay, clips, or stream preview to that PID. Errors such as `Game not found` or `stream preview 404` are expected. Do not run this while screen sharing or streaming.
- **Real games win:** if Discord detects a real game, the script hides the fake game. `DeepSeek Harness` is ignored by default because Discord often detects it as a game; add other apps with `ignoreRealGame()`.
- **Dispatcher error:** if you see `Requested message dispatch does not have a value...`, the script is using an older dispatcher finder. This version requires a Flux dispatcher with `_actionHandlers`.
- **Settings:** for the status to be visible, enable **Share my activity** in Discord's Activity Privacy settings and keep the game enabled in **Registered Games**.

## Badge caveat

`Games played` / `Universalist` and game-hours badges are server-side. This script feeds the same store that Discord's heartbeat manager reads, so hours may accumulate, but **nothing is guaranteed**. To check:

1. Open DevTools → **Network**.
2. Filter `science`.
3. Wait 5–6 minutes.
4. Look for `running_game_heartbeat` with status `204` and `duration_tracked_ms > 0`.

Badge updates can take 1–2 days.

## Privacy

- The script does not read your token, cookies, or `localStorage`.
- Do not commit `.env` files, tokens, cookies, `cf_clearance`, webhook URLs, or console logs to this repository. Logs can contain guild IDs, channel IDs, and user IDs.
- If you accidentally publish a token, revoke it immediately in Discord settings and rewrite the Git history.

## License

MIT. See [`LICENSE`](./LICENSE). The license does not grant permission to violate Discord's Terms of Service.
