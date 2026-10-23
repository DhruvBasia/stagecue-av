# StageCue AV

A dual-screen presentation and cue controller for live auditoriums and conference rooms. The operator's laptop drives the projector over HDMI. The audience only sees the **Stage Output** window, and the operator works on the laptop screen without the audience ever seeing it.

Built with **Electron 31 · React 18 · TypeScript · Zustand · Tailwind CSS · Web Audio API**.

---

## Install (AV laptop, Windows 10/11)

1. Download **StageCue-AV-Setup-x.y.z.exe** from [stagecue-av-releases](https://github.com/DhruvBasia/stagecue-av-releases/releases/latest). It's public and needs no GitHub login. After the first install, StageCue updates itself.
2. Run it. The installer isn't code-signed yet, so Windows SmartScreen may say *"Windows protected your PC"*. Click **More info → Run anyway**. It installs for your user only, with no admin rights needed, and adds a desktop shortcut.
3. **For crew phones on any network or mobile data**, install Cloudflare's tunnel once (free, no account needed):
   ```bash
   winget install --id Cloudflare.cloudflared
   ```
   Then in StageCue, open Settings → **Crew remote** ON → wait for **ONLINE** → share the QR code. Without it, phones still work on the same Wi-Fi as the laptop.

Uninstall from Windows Settings → Apps → *StageCue AV*.

### Optional: permanent crew link (relay on Render)

The Cloudflare tunnel address changes every time StageCue starts. For a link that never changes, so printed QR codes keep working, deploy the relay for free:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/DhruvBasia/stagecue-av)

1. Click the button, sign in to Render and allow it to access this repo. Then click **Deploy Blueprint**, which creates the free service *stagecue-relay*.
2. Check it: `node relay/check.js https://<your-service>.onrender.com` (every line should say PASS).
3. In Render → stagecue-relay → **Environment**, copy `RELAY_HOST_KEY`.
4. In StageCue, open Settings → Crew remote → Connection → *Internet* → **My relay server**, then paste the URL and the host key. Wait for **ONLINE**.

Details: [relay/README.md](relay/README.md). If you use Claude Code, ask it to *"set up StageCue for me"*; [CLAUDE.md](CLAUDE.md) has the steps.

---

## Quick start (developers)

```bash
npm install          # installs deps (Electron binary included)
npm run typecheck    # strict TS checks for main/preload and renderer
npm test             # Vitest unit suite
npm run dev          # launches the Operator + Stage windows with hot reload
npm run build        # typecheck → bundle → Windows installer in release/<version>/
```

Extra scripts:

| Script | Purpose |
| --- | --- |
| `npm start` | Run the last production bundle (`electron-vite preview`) |
| `npm run test:e2e` | Build, then run the Playwright dual-window integration test |
| `npm run build:unpack` | Bundle into `release/<version>/win-unpacked` without an installer |
| `npm run build:mac` / `build:linux` | DMG / AppImage (run on the matching OS) |

> **npm 11+ note:** install scripts are opt-in. This repo's `package.json` already has `allowScripts` set for `electron` and `esbuild`, so `npm install` downloads the Electron binary. If you see `Electron failed to install correctly`, run `npm rebuild electron`.

---

## Running a show

1. **Connect the projector** over HDMI and set Windows to *Extend* (Win+P → Extend). StageCue detects it and pins the Stage window fullscreen on it (header badge: **HDMI ACTIVE**). With no projector connected it opens a 1280×720 **REHEARSAL MODE** window so you can practise.
2. **Import the event folder** with **Folder** (Ctrl+Shift+F), or drag the folder onto the window. Sub-folders are included, and every image, PDF, video and track is sorted into *Backdrops & Posters*, *Videos (Kulgeet / Anthem)* or *Background Tracks*. The folder stays linked to the show:
   - **↻ Rescan** picks up files added later and flags moved or deleted ones as missing.
   - Opening the show rescans its linked folders automatically.

   Single files work too: use **Files** (Ctrl+I) or drag them in.
3. **PDF backdrops**: every page of a PDF becomes its own backdrop ("Brochure · p1", "· p2", …). Pages are rendered once at projector resolution (1080p–4K) and cached, so on stage they behave exactly like images, including cuts, dissolves and freeze. Editing the PDF re-renders it automatically.
   **PowerPoint (`.pptx`, `.ppt`, `.ppsx`, `.odp`)**: import a deck like any other file, or just keep it in the event folder.
   - It is converted once (Microsoft PowerPoint on Windows, LibreOffice otherwise) and every slide becomes a backdrop ("Award Night · slide 3", marked **SLIDE n/N**). Build cues from it, or use *Auto-advance* for a self-running deck.
   - Saving the deck again re-converts it automatically.
   - **Animations, slide transitions and videos embedded in the deck do not play**: each slide shows its final state. For animated decks, use PowerPoint **File → Export → Create a Video** and import the MP4 as a video cue. For videos inside a deck, import the original video files as separate video cues.
   - No PowerPoint or LibreOffice on the show laptop? Use **File → Export → PDF** in PowerPoint and import the PDF; it behaves the same.
4. **Build the cue stack**:
   - Press **Cues** on a linked folder to generate the running order from the file names (`01 Welcome.png`, `02 Kulgeet.mp4`, …). Images and PDF pages become backdrop cues, videos become video cues, and tracks become music cues.
   - You can also drag library items onto the cue list: drop a file on an existing cue to assign it, or on empty space to create a cue.
   - Each cue shows a thumbnail. Double-click a cue to edit its transition, loops, music level, ducking and notes.
5. **Auto-follow (optional)**: in the cue editor, set *After this cue* to:
   - **When video ends**: e.g. take the next cue as soon as the anthem finishes.
   - **After a delay**: e.g. show each sponsor poster for 8 s.
   - Pick an earlier cue as the target to loop a sponsor reel. "Cues from folder" can also build such a reel directly (the *Auto-advance* option).
   - The **AUTO-FOLLOW ON/OFF** switch in the cue stack (also in Settings, and on the phone remote) turns all of this on or off at once.
   - Countdowns pause while frozen or blacked out. Pressing F4 or taking another cue cancels them.
6. **Before doors open, press Check (Ctrl+Shift+C).** It confirms the projector is connected, the stage window is responding and the audio engine and output device are ready. It also re-opens and decodes every file used by a cue, and flags empty cues, wrong file types and broken follow targets. Use "Go to cue" to jump to a problem.
7. **Print the run sheet** (Ctrl+P) or export it as PDF (Ctrl+E) for the stage manager. It has a thumbnail, media, music level, transition, follow rule, notes and a tick box per cue.
8. **Run it**: the highlighted cue (green, **NEXT**) appears in **Preview**. **Space** takes it live and moves the highlight to the next cue.

### Booklets, web flipbooks and live windows
A souvenir booklet, a slide deck or the annual magazine is **one cue whose pages you turn live**. You don't need one cue per page.

- **PDF booklet / PowerPoint deck**: make a cue from its first page (hover a page in the library → **Cue**), or tick *One cue per PDF / slide deck* when building cues from a folder. When it's live, the Program monitor shows ⏮ ◀ **Page 3 / 34** ▶ ⏭, and you can type a page number. Pages change with a quick dissolve and the cue stays live.
- **Web page (online flipbook magazine)**: go to Library → **Live** → **Web page** and paste the address (e.g. the Netted Bytes flipbook). StageCue checks the address and takes a snapshot, then you make it a cue like any other. When it's live, the page runs on the projector and the Program monitor shows a **live, clickable picture** of it:
  - click or drag on the picture, or scroll it, and the same happens on the projector (flip a corner, press the flipbook's own buttons);
  - ◀ **Next** send the page's arrow keys, which turns most flipbooks; ← ⌂ ⟳ go back, start again or reload, and 🔇 switches page sound on or off (muted by default);
  - ⤢ opens a bigger live view;
  - freeze (F8) holds a still of the page while you keep flipping underneath.

  Web pages need internet during the show, so make an **offline copy**: hover the web page in the library → **Offline**. StageCue opens the flipbook out of sight at projector size, turns through every page and saves each view into a PDF in *Documents\StageCue Offline*. It's added as a booklet cue "*name* (offline)" that plays without internet. The Netted Bytes magazine takes about a minute and gives 18 full-screen spreads. Running Offline again later refreshes the same pages. The pre-show check also opens every web address.
- **Window / screen**: go to Library → **Live** → **Window / screen**, then pick any app window (a browser, Canva, a scoreboard) or a whole screen. The audience sees it live while you work in it on the laptop. If the app was restarted, StageCue finds the window again by its title.
- **Turning pages**: use the buttons, **[ / ]** on the keyboard, the **clicker** (PgDn/→ next page, PgUp/← previous; after the last page the clicker moves on to the next cue), or a crew phone (◀ PAGE / PAGE ▶ appear while a booklet is live, allowed with *GO / play cues*). Use **Space** to go on to the next cue at any time.

### On air: speaker timer, name captions, countdown
The **On air** card sits in the right column. Its captions, countdown and timer are drawn on the projector over the picture (and over a freeze, but under the blackout). The Program monitor shows them exactly as the audience sees them.

- **Timer**: a countdown for each speaker.
  - Pick a length (3 / 5 / 7 / 10 / 15 min or any number) and type the speaker's name, then press **Start**. Use **+1m** to add time.
  - Send **WRAP UP / 1 MINUTE / TIME UP** signals to the speaker.
  - The **podium screen** is a phone or tablet facing the speaker, opened from the *Podium timer* QR code (Settings → Crew remote). It shows only a huge timer: green, then amber in the last minute, then flashing red and counting up when the speaker is over time. It stays awake and keeps counting through Wi-Fi drops.
  - *On projector* also puts a small timer in a corner of the projector.
- **Captions**: name captions (lower thirds), such as "Prof. Mahesh Verma · Vice Chancellor".
  - Prepare the list once (it's saved with the show), then **Show / Hide** them live. There are two styles, *Bar* and *Glass*.
  - A cue can also bring its own caption (cue editor → *Name caption on TAKE*). It slides in with the cue and disappears after 10 s.
- **Countdown**: "The event begins in 4:59", full screen over the backdrop, for before the doors open. It hides itself at 0:00, or you can leave it on screen.

### Updates
StageCue checks for new versions in the background (shortly after it starts, then every few hours) and downloads them quietly. **It never restarts during a show.** The update installs the next time you close StageCue, or right away with **Restart to update** in the header (or Settings → Updates). Installers are published in the public [stagecue-av-releases](https://github.com/DhruvBasia/stagecue-av-releases/releases) repo; the source stays private.

### Cue tracking rules
| Cue field | If set | If empty |
| --- | --- | --- |
| Backdrop | replaces the poster / background loop | **keeps** the current backdrop |
| Foreground video | plays over the backdrop, then auto-returns to the backdrop when it ends | **clears** any playing video |
| Background track | crossfades to the new track | **keeps** the current music |

### Keyboard (operator window keeps focus at all times)
| Key | Action |
| --- | --- |
| **Space** | TAKE the highlighted cue (auto-repeat ignored; 300 ms double-take guard) |
| **F8** | Software **Freeze** / Unfreeze |
| **ESC** | **Blackout** toggle (inside a text field the first ESC only leaves the field) |
| **F4** | **Instant Backdrop**: drop the video, show the poster |
| **F9** | **Fade Audio**: background music fades out over 3 s |
| ↑ / ↓ | Move the highlight |
| [ / ] | Previous / next page of the live PDF booklet, slide deck or web flipbook |
| Shift+P | Play / pause the program video |
| Ctrl+N / O / S / Shift+S / I | New / Open / Save / Save As / Import |

F4, F8 and F9 work even while typing or inside a dialog.

### Settings (gear icon, Ctrl+,)
| Setting | Scope | What it does |
| --- | --- | --- |
| Auto-follow | show | Master ON/OFF for every cue's follow rule |
| Presentation clicker | this laptop | **PgDn / →** TAKE · **PgUp / ←** previous cue · **B / .** blackout (the clicker's "blank screen" key). With *Clicker turns pages* ON (default), while a booklet / deck / web flipbook is live, forward/back turn its pages instead. |
| Crew remote | this laptop | Off by default. Phones and tablets connect over a WebSocket and get instant updates. Two QR links: **Stage team** (only what you allow) and **AV operator phone** (full control). Links survive restarts; *New links* revokes old QR codes and disconnects those phones. The first time, allow StageCue AV through the Windows firewall on **private** networks. |
| Audio output | show | Sends music and video audio to HDMI, the headphone jack or a USB interface (also selectable in the mixer). If that device is unplugged, audio falls back to the system default and switches back automatically when it returns. |

### Performer tracks from Google Drive
Performers upload their audio to one Drive folder; StageCue downloads it to the laptop so the show never depends on the internet.

1. In Drive, share the folder as **Anyone with the link (Viewer)**. Performers can upload into sub-folders.
2. **Library → Drive**, paste the folder link and choose where to save. The default is `Documents\StageCue Drive\<folder name>`.
3. Every audio, video, image, PDF and PowerPoint file is downloaded, the folder is linked to the library, and the tracks appear in **Background Tracks** marked **NEW** (the tab shows `+N`). Play them, put them in cues, or press **Cues** on the Drive row to build the running order. NEW clears once an item is used; *Mark as seen* clears them all.
4. **Auto-sync** (on by default, every 30 s – 5 min, in the Drive dialog) picks up late submissions in the background. **↻ Sync now** fetches immediately. Only new or changed files are downloaded.
   - Files deleted on Drive stay on the laptop, so nothing disappears mid-show.
   - If the internet drops, everything already downloaded keeps playing, and sync errors are shown once rather than every minute.
5. Drive folders are saved with the show. Opening the show syncs them again.

**Google API key (optional, recommended).** Without a key, StageCue reads Drive's public folder page. That works with no setup, but it is not an official Google service and could change. With a free API key (console.cloud.google.com → enable *Google Drive API* → Credentials → API key), it uses the official Drive API: more reliable, detects edited files, and handles large folders. The key is stored on this laptop only.

**Alternative:** if *Google Drive for desktop* is installed, you can link its synced folder with **Folder** instead, and press **↻ Rescan** to pick up new files.

### Stage team module (crew beside the stage)
The AV room is usually far from the stage. The stage manager and crew scan the **Stage team** QR code (Settings → Crew remote) and get, on any phone or tablet browser (no app install):
- **Live / Next** cards with thumbnails, the video time remaining and the auto-follow countdown.
- A big **GO** button plus the full **cue list with thumbnails**. Tap a cue, confirm, and it plays.
- **Video / music** play-pause and fade, plus freeze / blackout, but only if the AV room allows them. Permissions are set in Settings (*Stage team can…*), and the **Lock** switch (Settings or the Crew panel) blocks stage control instantly while messaging keeps working.
- **Crew messages**: STANDBY, READY, HOLD, GUEST IN, WRAP UP, PROBLEM or typed text, straight to the AV room. They pop up as alerts on the operator screen and appear in the **Crew** panel (header button with an unread badge). The AV room answers everyone or one device, with one-tap replies ("Copy that", "Stand by", "GO", "Hold").
- Every command gets an instant ✓ / ✕ on the phone, e.g. "✓ Cue 7 “Kulgeet” is live" or "✕ Controls are locked by the AV room". Everything the stage team does is shown as an alert in the AV room.

### Network for the crew: any network or mobile data
The phones and the laptop **do not need to share a Wi-Fi network**. The laptop can be on venue Wi-Fi, a phone hotspot or a USB dongle, and the crew can be on any Wi-Fi or on 4G/5G. On mobile data the laptop sits behind the carrier's NAT, so phones can't dial it directly. Instead **both sides connect out** to a secure `wss://` address on the internet, and that address carries the same real-time WebSocket traffic. The laptop still checks every crew link (token), and wrong links are refused.

Settings → Crew remote → **Connection** gives two internet options:

| | **Cloudflare tunnel** (default) | **My relay server** |
| --- | --- | --- |
| Setup | Install once: `winget install --id Cloudflare.cloudflared` | Deploy `relay/` once to any Node host ([relay/README.md](relay/README.md)) |
| Account / cost | None, free | Free tiers work (Render, Railway, Fly.io, a VPS) |
| Address | `https://<random>.trycloudflare.com`, which **changes every time StageCue starts**, so reshare the QR | `https://your-relay/r/<room>`, **permanent**, so printed QR codes keep working |

The status chip shows **ONLINE**, **CONNECTING**, **RECONNECTING** (backoff retries after internet drops) or **NOT INSTALLED**. Internet links are listed first and marked *any network*. The Crew panel shows each phone as *internet* or *same Wi-Fi*.

**Same Wi-Fi only** remains as a fallback for venues with no internet at all. Phones then talk straight to the laptop, via a pocket travel router, the laptop's Mobile Hotspot, or venue Wi-Fi without client isolation. Even in internet mode the *same Wi-Fi* links still work, so a phone on the AV desk router keeps working if the internet drops.

The phone page shows **LIVE · 43 ms** when connected and reconnects automatically. If the laptop goes offline, the page says so and reconnects by itself when it's back.

---

## Architecture

```
┌──────────────── Operator window ────────────────┐        ┌──────── Stage window (HDMI) ────────┐
│ React + Zustand (source of truth)               │  IPC   │ Layer 3  Blackout overlay   z=30   │
│  useStageStore ─ programReducer (pure)          │ ─────▶ │ Layer 2  Freeze canvas      z=20   │
│  useMediaStore ─ library + probing/thumbnails   │ relay  │ Layer 1  Foreground video A/B z=10 │
│  useAudioStore ─ mixer state                    │ ◀───── │ Layer 0  Backdrop A/B        z=0   │
│  HotkeyManager (capture phase)                  │ 10 Hz  │ Web Audio engine (music + video)   │
└─────────────────────────────────────────────────┘ telem. └────────────────────────────────────┘
                     ▲                     main process                      ▲
                     └── DisplayManager · local-media:// protocol · dialogs ─┘
```

* **Main process** (`src/main`)
  * `displayManager.ts` handles display selection, projector/rehearsal/docked placement and hot-plug (`display-added`, `display-removed`, debounced `display-metrics-changed`). Placements are applied to the *existing* stage window, so playback is never interrupted.
  * `protocolHandler.ts` serves `local-media://` with HTTP 206 range support for smooth scrubbing. Only files the operator imported are served (allowlist). CORS headers let Web Audio and thumbnails read the media.
  * `ipcHandlers.ts` relays typed channels between the windows after verifying the sender, and also handles the file dialogs and atomic show-file writes.
  * `index.ts` creates the windows and menu, blocks display sleep, asks for confirmation on quit, and recreates the stage window automatically if its renderer crashes. The operator then re-syncs the live cue, the music, and the video position.
* **Preload** (`src/preload`): a context-isolated, sandboxed bridge. Each window can only use the channels that fit its role.
* **Stage renderer** (`src/renderer/src/stage.tsx`)
  * Every media layer uses `object-fit: contain` on black, so 4:3, 16:9 and 16:10 projectors never stretch the image.
  * Video errors appear in an **operator-only** banner. The stage hides that layer immediately and keeps the backdrop on screen.
  * **Software freeze** draws the current backdrop and video composite (including a crossfade in progress) into one canvas that is allocated once and reused. It is shown on the next frame and confirmed back to the operator with the measured latency. A TAKE during a freeze loads the new cue underneath, waits until it has decoded, then dissolves out of the frozen frame.
* **Audio engine** (`services/audioEngine.ts`)
  * Signal path: music decks A/B → `musicGainNode`, video slots → `videoGainNode`, both → master gain → output, with analysers feeding the level meters.
  * Auto-ducking pulls music down to `volume × (1 − duck%)` while video audio plays (400 ms attack). It restores the level when the video pauses or ends (1200 ms release). Both ramps use `setTargetAtTime` with τ = duration/3, which gets about 95% of the way within each window.
  * Music crossfades use equal-power curves.

### Show files & recovery
Shows save as `*.stagecue.json`. Each file stores absolute **and** show-relative media paths, so a show folder copied to another laptop still finds its files. While a show has unsaved changes it is autosaved for crash recovery, and the next launch offers to restore it.

---

## Tests

```bash
npm test           # 174 unit tests
npm run test:e2e   # 21 Playwright Electron tests (opens real windows), plus 2 opt-in internet tests
```

Testing an installed build (e.g. a release downloaded from GitHub) with throwaway app data, plus the opt-in real-internet tunnel test:

```powershell
$env:STAGECUE_E2E_EXECUTABLE = "$env:LOCALAPPDATA\Programs\StageCue AV\StageCue AV.exe"
$env:STAGECUE_E2E_REAL_TUNNEL = "1"   # needs cloudflared + internet
$env:STAGECUE_E2E_REAL_WEB = "1"      # opens the real Netted Bytes flipbook and turns its pages
npx playwright test
```

| Suite | Covers |
| --- | --- |
| `audioEngine.test.ts` | duck formula & attenuation, τ calculations, anchored ramps, idempotent ducking, mute, equal-power crossfades, F9 fade + bus restore, analyser levels, decode errors |
| `cueManager.test.ts` | stack progression, insert/move/duplicate/remove, tracking rules, auto-return, stale-event rejection, **freeze immutability** (deep-frozen state, preserved frozen view), reveal-from-freeze |
| `displayManager.test.ts` | mocked `electron.screen`: single-display rehearsal, HDMI placement, built-in-panel detection, preferred display, docking on unplug, re-maximise on re-plug, metrics debounce, window fullscreen sequencing (Windows vs macOS) |
| `protocolHandler.test.ts` | range parsing, 200/206/403/416 responses, URL round-trips, relative-path fallback |
| `hotkeyManager.test.ts` / `storage.test.ts` | key routing rules; show-file validation, repair and autosave |
| `remoteServer.test.ts` / `internetAccess.test.ts` | crew WebSocket roles, permissions, lock, acks; relay round trip (phone → relay → laptop and back), wrong-token rejection, relay restart + auto-reconnect, room/host-key protection, offline page, Cloudflare tunnel URL detection (fake `cloudflared`), not-installed state |
| `e2e/stagecue.spec.ts` | real two-window app: Space → stage, F8 freeze isolation (< 250 ms ack), reveal-from-freeze, ESC blackout, telemetry, folders, PDF/PowerPoint, auto-follow, clicker, crew phones over LAN **and through the internet relay**, Drive sync, pre-show, run sheet, audio devices |

---

## Packaging notes

* The Windows build has `signAndEditExecutable: false`. Without it, electron-builder has to extract its `winCodeSign` toolkit, which fails without Windows Developer Mode or admin rights ("Cannot create symbolic link"). To add a custom icon or code signing, enable Developer Mode, set this back to `true`, and add `build/icon.ico`.
* Video decoding is hardware-accelerated by Chromium. H.264 MP4 is the safest format for projector shows. MOV and MKV files that contain H.264 or VP9 usually play too, and anything the player can't decode is reported to the operator before the show.
