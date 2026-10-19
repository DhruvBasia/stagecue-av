# StageCue AV: notes for Claude Code

StageCue AV is a Windows desktop app (Electron 31 + React 18 + TypeScript + Zustand + Tailwind) that runs a live event. It has two windows: an operator window on the laptop and a stage output window on the HDMI projector. An optional **relay** (`relay/`, plain Node + `ws`) gives crew phones a permanent link over any network. The app is **not** a web service; only the relay is deployed to a server.

## Setting StageCue up for someone (typical request)

Work through these in order, and verify each step before moving on.

1. **App on their Windows laptop**, choosing one route:
   - *Installer:* download `StageCue-AV-Setup-<version>.exe` from this repo's GitHub Releases (`gh release download --repo DhruvBasia/stagecue-av --pattern "*.exe"`). The person runs it. It is unsigned, so SmartScreen shows "More info → Run anyway". It is a per-user install that needs no admin rights.
   - *From source:* `npm install`, then `npm run dev` to try it or `npm run build` to produce `release/<version>/StageCue-AV-Setup-<version>.exe`.
2. **Crew phones on any network (default mode):** the laptop needs `cloudflared`. The person should approve the install: `winget install --id Cloudflare.cloudflared`. Then in the app: Settings → Crew remote ON → Connection: *Internet* + *Cloudflare tunnel* → wait for **ONLINE**. The address changes on every app start.
3. **Optional permanent link (relay on Render):** see *Relay* below. In the app: Connection → *My relay server* → relay URL + host key.

## Relay (Render)

- `render.yaml` at the repo root is a Render Blueprint. It creates the free web service **stagecue-relay** from `relay/` (`node server.js`, health check `/healthz`, and a generated `RELAY_HOST_KEY`).
- One-click deploy: `https://render.com/deploy?repo=https://github.com/DhruvBasia/stagecue-av`. The person must sign in to Render and grant it access to the repo themselves. The repo is private, so their GitHub account needs collaborator access. Ask before clicking **Deploy Blueprint**.
- A brand-new service can answer `404` with header `x-render-routing: no-server` for a minute or two after "Your service is live". Poll `/healthz` until it returns `200`.
- **The host key is the person's secret.** Don't reveal, print or copy it yourself. Ask the person to copy it from Render → stagecue-relay → Environment and paste it into StageCue (Settings → Connection → *Host key*). To run the full relay check, they set it in an env var themselves.
- **Verify a deployed relay** (any machine with Node 18+ and this repo's deps):
  ```bash
  node relay/check.js https://<service>.onrender.com
  ```
  Without a key this checks health, the offline page and stranger refusal. With `STAGECUE_RELAY_HOST_KEY` set in the person's own shell, it also runs a full laptop ⇄ relay ⇄ phone round trip. Exit code 0 means everything passed.
- On the free plan the relay sleeps after about 15 min idle and takes about 60 s to wake. The app reconnects by itself, showing RECONNECTING in Settings.

## Commands

| | |
| --- | --- |
| `npm run typecheck` | Strict TS for main/preload (`tsconfig.node.json`) and renderer (`tsconfig.json`) |
| `npm test` | Vitest unit suite: 143 tests, including relay and tunnel tests against a local relay |
| `npm run test:e2e` | Builds, then runs 16 Playwright tests that drive the real two-window app (opens windows) |
| `$env:STAGECUE_E2E_EXECUTABLE="<path>\StageCue AV.exe"; npx playwright test` | Same suite against an **installed** build, with throwaway app data |
| `$env:STAGECUE_E2E_REAL_TUNNEL="1"` | Adds the opt-in test through a real Cloudflare tunnel (needs cloudflared + internet) |
| `npm run build` | Typecheck, then bundle, then the NSIS installer in `release/<version>/` |

Before calling a setup "working", run the typecheck, `npm test`, `npm run test:e2e`, and `relay/check.js` against any deployed relay.

## Windows gotchas (already solved; don't re-debug)

- PowerShell may block `npm.ps1`, so use `npm.cmd …`.
- npm 11 install scripts are opt-in. `package.json` has `allowScripts` for electron and esbuild. If Electron is missing, run `npm approve-scripts electron esbuild` then `npm rebuild`.
- `build.win.signAndEditExecutable: false` avoids the winCodeSign "Cannot create symbolic link" failure without Developer Mode.
- PowerPoint import exports through a temp folder because COM `SaveAs` into AppData fails with `E_FAIL` (`src/main/presentationConverter.ts`).
- In Node scripts, set `process.exitCode` rather than calling `process.exit()` while fetch sockets are open, because Node can abort on Windows.
- Windows PowerShell 5.1 `Get-Content`/`Set-Content` mangle UTF-8 (→, ·, —). Edit files with the editor tools instead.

## Layout

- `src/main/`: Electron main process. Main files:
  - `index.ts`: lifecycle and windows;
  - `ipcHandlers.ts`;
  - `displayManager.ts`;
  - `protocolHandler.ts`: the `local-media://` protocol;
  - `remoteServer.ts`: the crew WebSocket server;
  - `internetAccess.ts`: the Cloudflare tunnel and relay link;
  - `remotePage.ts`: the phone page;
  - `driveSync.ts`, `pdfCache.ts`, `presentationConverter.ts`, `mediaScanner.ts`, `runSheetExporter.ts`.
- `src/preload/`: sandboxed, role-based IPC bridge.
- `src/renderer/src/`: `operator.tsx`, `stage.tsx`, `store/` (Zustand), `services/` (audio engine, cue logic, follow engine…), `components/`.
- `relay/`: `server.js` (the relay), `check.js` (the deployment checker), `Dockerfile`, `README.md`.
- `tests/unit/` (Vitest) and `tests/e2e/stagecue.spec.ts` (Playwright `_electron`, with hooks exposed as `window.__STAGECUE_TEST__` when started with `--stagecue-e2e`).

Code style: no stubs or TODOs; strict TypeScript; match the surrounding comment density.
