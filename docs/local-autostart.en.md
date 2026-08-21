# macOS Login Autostart

The installed Heartbeat application opens `http://127.0.0.1:27101/`. The production service uses that same port, so it is available directly after login.

The launch agent is `~/Library/LaunchAgents/com.heartbeat-management.plist`:

- starts at login and restarts after an unexpected exit;
- runs the built `dist/server/index.js`, with no development server dependency;
- listens only on the local loopback address;
- writes logs to `~/Library/Logs/heartbeat-management/`.

After changing code, run `npm run build` in the project, then run:

```sh
launchctl kickstart -k gui/$(id -u)/com.heartbeat-management
```

To stop the autostart service:

```sh
launchctl bootout gui/$(id -u)/com.heartbeat-management
```
