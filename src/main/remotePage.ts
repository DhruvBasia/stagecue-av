/* Self-contained crew remote page (phones and tablets) served by remoteServer.ts.
 * One page for both roles; what is shown depends on the permissions the AV
 * room grants. All text from the show is inserted with textContent. */

export const REMOTE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>StageCue Crew</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --raised:#21262d; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --dim:#6e7681; --blue:#38bdf8; --amber:#fbbf24; --red:#f87171; --green:#4ade80; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { min-height: 100dvh; padding: 10px 12px calc(12px + env(safe-area-inset-bottom)); user-select: none; }
  .wrap { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
  header { display: flex; align-items: center; gap: 8px; }
  .role { font-size: 11px; font-weight: 900; letter-spacing: .12em; padding: 4px 8px; border-radius: 6px; background: rgba(56,189,248,.15); color: var(--blue); }
  .role.stage { background: rgba(74,222,128,.14); color: var(--green); }
  .who { flex: 1; min-width: 0; }
  .show { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .me { font-size: 11px; color: var(--muted); background: none; border: 0; padding: 0; text-decoration: underline dotted; }
  .link { font-size: 11px; font-weight: 800; letter-spacing: .06em; padding: 4px 8px; border-radius: 999px; background: rgba(248,113,113,.15); color: var(--red); white-space: nowrap; }
  .link.ok { background: rgba(74,222,128,.12); color: var(--green); }
  .banner { display: none; border-radius: 10px; padding: 10px 12px; font-size: 13px; font-weight: 700; }
  .banner.show { display: block; }
  .banner.lock { background: rgba(251,191,36,.12); color: var(--amber); border: 1px solid rgba(251,191,36,.5); }
  .banner.off { background: rgba(248,113,113,.12); color: var(--red); border: 1px solid rgba(248,113,113,.5); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; min-height: 0; }
  .chip { font-size: 11px; font-weight: 800; letter-spacing: .08em; padding: 3px 8px; border-radius: 6px; }
  .chip.frozen { background: var(--blue); color: var(--bg); }
  .chip.black { background: var(--red); color: var(--bg); }
  .chip.warn { background: rgba(251,191,36,.15); color: var(--amber); }
  .now { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 8px; min-width: 0; }
  .card.live { border-color: rgba(248,113,113,.6); }
  .card.next { border-color: rgba(74,222,128,.5); }
  .label { font-size: 10px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
  .live .label { color: var(--red); } .next .label { color: var(--green); }
  .thumb { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 6px; margin-top: 6px; object-fit: contain; display: block; }
  .thumb.empty { display: flex; align-items: center; justify-content: center; color: var(--dim); font-size: 22px; }
  .title { font-size: 14px; font-weight: 700; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 11px; color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; min-height: 14px; }
  button { font: inherit; color: inherit; border: 2px solid var(--border); background: var(--raised); border-radius: 12px; cursor: pointer; touch-action: manipulation; }
  button:active { transform: scale(.98); filter: brightness(1.25); }
  button:disabled { opacity: .35; }
  #go { width: 100%; min-height: 84px; background: #14532d; border-color: var(--green); color: #fff; font-size: 26px; font-weight: 900; letter-spacing: .08em; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
  #go small { font-size: 13px; font-weight: 600; letter-spacing: 0; opacity: .85; max-width: 92%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .row button { min-height: 54px; font-weight: 800; font-size: 13px; letter-spacing: .05em; }
  .on-blue { background: #0369a1 !important; border-color: var(--blue) !important; }
  .on-red { background: var(--red) !important; border-color: var(--red) !important; color: var(--bg) !important; }
  .on-amber { border-color: var(--amber) !important; color: var(--amber) !important; }
  .on-green { border-color: var(--green) !important; color: var(--green) !important; }
  .hidden { display: none !important; }
  .pagelabel { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-weight: 900; font-size: 15px; font-variant-numeric: tabular-nums; border: 2px dashed var(--border); border-radius: 12px; }
  .pagelabel small { font-size: 10px; font-weight: 800; letter-spacing: .12em; color: var(--muted); }
  /* Podium screen (?view=timer): one huge speaker timer, nothing else. */
  .podium { position: fixed; inset: 0; background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2vh; padding: 3vh 3vw; text-align: center; }
  .pd-speaker { font-size: clamp(16px, 4.5vh, 48px); font-weight: 700; color: var(--muted); max-width: 95vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pd-time { font-size: min(30vw, 50vh); font-weight: 900; line-height: .9; font-variant-numeric: tabular-nums; letter-spacing: -.02em; color: var(--green); }
  .pd-time.warn { color: var(--amber); } .pd-time.over { color: var(--red); }
  .pd-msg { font-size: clamp(22px, 9vh, 120px); font-weight: 900; letter-spacing: .06em; color: #000; background: var(--amber); padding: .1em .5em; border-radius: .2em; }
  .pd-msg:empty { display: none; }
  .pd-foot { position: fixed; bottom: 2vh; font-size: 12px; color: var(--dim); }
  .podium.over { animation: pd-flash 1s steps(2) infinite; }
  @keyframes pd-flash { 50% { background: #3b0a0a; } }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; background: var(--panel); border-radius: 10px; padding: 4px; }
  .tabs button { border: 0; background: transparent; min-height: 38px; font-weight: 800; font-size: 13px; letter-spacing: .06em; color: var(--muted); border-radius: 8px; position: relative; }
  .tabs button.sel { background: var(--raised); color: var(--text); }
  .dot { position: absolute; top: 8px; right: 14px; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .cue { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px; text-align: left; width: 100%; }
  .cue.is-live { border-color: rgba(248,113,113,.7); background: rgba(248,113,113,.08); }
  .cue.is-next { border-color: rgba(74,222,128,.6); background: rgba(74,222,128,.06); }
  .cue .num { width: 30px; text-align: center; font-weight: 900; font-size: 16px; color: var(--muted); }
  .cue img, .cue .ph { width: 88px; aspect-ratio: 16/9; object-fit: contain; background: #000; border-radius: 5px; flex-shrink: 0; }
  .cue .ph { display: flex; align-items: center; justify-content: center; color: var(--dim); }
  .cue .meta { flex: 1; min-width: 0; }
  .cue .name { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cue .det { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cue .note { font-size: 11px; color: var(--amber); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { font-size: 10px; font-weight: 900; letter-spacing: .1em; }
  .is-live .tag { color: var(--red); } .is-next .tag { color: var(--green); }
  .quick { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .quick button { min-height: 46px; font-weight: 800; font-size: 12px; letter-spacing: .05em; }
  .compose { display: flex; gap: 6px; }
  .compose input { flex: 1; min-width: 0; height: 44px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); color: var(--text); padding: 0 12px; font-size: 15px; user-select: text; }
  .compose button { padding: 0 16px; font-weight: 800; }
  .msg { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
  .msg.av { border-color: rgba(56,189,248,.6); background: rgba(56,189,248,.07); }
  .msg.alert { border-color: rgba(248,113,113,.6); }
  .msg .from { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
  .msg .txt { font-size: 15px; font-weight: 600; margin-top: 2px; word-break: break-word; }
  .sheet-bg { position: fixed; inset: 0; background: rgba(0,0,0,.65); display: none; align-items: flex-end; justify-content: center; z-index: 10; }
  .sheet-bg.show { display: flex; }
  .sheet { width: 100%; max-width: 560px; background: var(--panel); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 16px 14px calc(16px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px; }
  .sheet img { width: 100%; aspect-ratio: 16/9; object-fit: contain; background: #000; border-radius: 8px; }
  .sheet h2 { margin: 0; font-size: 18px; }
  .sheet .btns { display: grid; grid-template-columns: 1fr 2fr; gap: 8px; }
  .sheet .btns button { min-height: 56px; font-weight: 900; font-size: 15px; }
  .sheet .play { background: #14532d; border-color: var(--green); color: #fff; }
  .sheet input { height: 48px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 0 12px; font-size: 16px; user-select: text; }
  #toast { position: fixed; left: 50%; bottom: calc(18px + env(safe-area-inset-bottom)); transform: translateX(-50%); padding: 10px 16px; border-radius: 999px; font-weight: 800; font-size: 14px; background: var(--raised); border: 1px solid var(--border); opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 20; max-width: 92vw; text-align: center; }
  #toast.show { opacity: 1; }
  #toast.ok { border-color: var(--green); color: var(--green); }
  #toast.bad { border-color: var(--red); color: var(--red); }
  .offline .controls { opacity: .35; pointer-events: none; }
  .empty-note { color: var(--dim); font-size: 13px; text-align: center; padding: 16px; }
  @media (min-width: 700px) { .row button { min-height: 64px; font-size: 15px; } #go { min-height: 100px; } }
</style>
</head>
<body>
<div class="wrap" id="app">
  <header>
    <span class="role" id="role">CONNECTING</span>
    <div class="who"><div class="show" id="show">StageCue AV</div><button class="me" id="me" type="button">Set your name</button></div>
    <span class="link" id="link">OFFLINE</span>
  </header>
  <div class="banner off" id="offline">Reconnecting to StageCue… Check that this phone has a working internet or Wi-Fi connection.</div>
  <div class="banner lock" id="locked">Controls are locked by the AV room. Messages still work.</div>
  <div class="chips" id="chips"></div>
  <div class="now">
    <div class="card live"><div class="label">Live</div><div id="liveThumb"></div><div class="title" id="liveTitle">—</div><div class="sub" id="liveSub"></div></div>
    <div class="card next"><div class="label">Next</div><div id="nextThumb"></div><div class="title" id="nextTitle">—</div><div class="sub" id="nextSub"></div></div>
  </div>
  <div class="controls" id="controls">
    <button id="go" type="button" data-perm="takeCues" data-action="take">GO<small id="goLabel">—</small></button>
    <div id="pagesWrap" class="hidden">
      <div class="row" data-perm="takeCues" style="margin-top:8px">
        <button type="button" data-action="page-prev">◀ PAGE</button>
        <div class="pagelabel" id="pageLabel">—</div>
        <button type="button" class="on-green" data-action="page-next">PAGE ▶</button>
      </div>
    </div>
    <div class="row" data-perm="takeCues" style="margin-top:8px">
      <button type="button" data-action="prev-cue">◀ PREV</button>
      <button type="button" id="followBtn" data-perm="autoFollow" data-action="toggle-follow">AUTO</button>
      <button type="button" data-action="next-cue">NEXT ▶</button>
    </div>
    <div class="row" data-perm="mediaControls" style="margin-top:8px">
      <button type="button" id="videoBtn" data-action="toggle-video">▶ VIDEO</button>
      <button type="button" id="musicBtn" data-action="music-toggle">▶ MUSIC</button>
      <button type="button" data-action="fade-audio">FADE AUDIO</button>
    </div>
    <div class="row" data-perm="emergency" style="margin-top:8px">
      <button type="button" id="freezeBtn" data-action="freeze">FREEZE</button>
      <button type="button" id="blackBtn" data-action="blackout">BLACKOUT</button>
      <button type="button" data-action="instant-backdrop">BACKDROP</button>
    </div>
  </div>
  <div class="tabs"><button type="button" class="sel" id="tabCues">CUES</button><button type="button" id="tabCrew">CREW<span class="dot hidden" id="unread"></span></button></div>
  <div id="cuesPane" class="list"></div>
  <div id="crewPane" class="hidden" style="display:flex;flex-direction:column;gap:8px">
    <div class="quick">
      <button type="button" data-msg="standby" data-text="Standing by">STANDBY</button>
      <button type="button" data-msg="ready" data-text="Ready on stage" class="on-green">READY</button>
      <button type="button" data-msg="hold" data-text="HOLD — wait" class="on-amber">HOLD</button>
      <button type="button" data-msg="guest-arrived" data-text="Chief guest has arrived">GUEST IN</button>
      <button type="button" data-msg="custom" data-text="Speaker is finishing">WRAP UP</button>
      <button type="button" data-msg="problem" data-text="Problem on stage — need help" style="border-color:var(--red);color:var(--red)">PROBLEM</button>
    </div>
    <form class="compose" id="compose"><input id="msgText" maxlength="200" placeholder="Message to AV room…" autocomplete="off"><button type="submit">SEND</button></form>
    <div class="list" id="feed"></div>
  </div>
</div>
<div class="sheet-bg" id="confirm"><div class="sheet">
  <h2 id="confirmTitle">Play cue?</h2><div id="confirmThumb"></div><div class="sub" id="confirmSub"></div>
  <div class="btns"><button type="button" id="confirmNo">Cancel</button><button type="button" class="play" id="confirmYes">PLAY NOW</button></div>
</div></div>
<div class="sheet-bg" id="nameSheet"><div class="sheet">
  <h2>Who is using this device?</h2>
  <div class="sub">Shown to the AV room, e.g. “Stage left – Rahul”.</div>
  <input id="nameInput" maxlength="32" placeholder="Your name / position" autocomplete="off">
  <div class="btns"><button type="button" id="nameSkip">Skip</button><button type="button" class="play" id="nameSave">CONTINUE</button></div>
</div></div>
<div id="podium" class="podium hidden" data-testid="podium">
  <div class="pd-speaker" id="pdSpeaker"></div>
  <div class="pd-time" id="pdTime">--:--</div>
  <div class="pd-msg" id="pdMsg"></div>
  <div class="pd-foot" id="pdFoot">Waiting for the AV room…</div>
</div>
<div id="toast"></div>
<script>
(function () {
  'use strict';
  var token = new URLSearchParams(location.search).get('t') || '';
  var $ = function (id) { return document.getElementById(id); };
  var NAME_KEY = 'stagecue-crew-name';
  var st = { role: null, perms: {}, locked: false, status: null, cues: [], messages: [], connected: false, latency: null, clientId: null, tab: 'cues', unread: 0 };
  var ws = null, retry = 500, pingTimer = null, revoked = false, pending = {}, confirmCue = null, toastTimer = null;
  var myName = '';
  try { myName = localStorage.getItem(NAME_KEY) || ''; } catch (e) { myName = ''; }
  // Podium screen: a big speaker timer for the person at the microphone.
  var podium = new URLSearchParams(location.search).get('view') === 'timer';
  var timerBase = null;
  if (podium) myName = 'Podium screen';

  function fmtClock(ms) {
    var over = ms < 0, total = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    var body = h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s : m + ':' + (s < 10 ? '0' : '') + s;
    return over ? '+' + body : body;
  }
  function timerLeft() {
    if (!timerBase) return null;
    return timerBase.running ? timerBase.remainingMs - (Date.now() - timerBase.receivedAt) : timerBase.remainingMs;
  }
  function renderPodium() {
    if (!podium) return;
    var t = timerBase, left = timerLeft();
    var time = $('pdTime');
    if (!t || left === null) {
      time.textContent = '--:--'; time.className = 'pd-time'; $('pdSpeaker').textContent = ''; $('pdMsg').textContent = '';
      $('podium').className = 'podium';
      $('pdFoot').textContent = st.connected ? 'Waiting for the AV room to start the timer…' : 'Connecting to StageCue…';
      return;
    }
    var tone = left < 0 ? 'over' : left <= t.warnMs ? 'warn' : 'ok';
    time.textContent = fmtClock(left);
    time.className = 'pd-time' + (tone === 'ok' ? '' : ' ' + tone);
    $('pdSpeaker').textContent = t.speaker || '';
    $('pdMsg').textContent = t.message || '';
    $('podium').className = 'podium' + (tone === 'over' ? ' over' : '');
    $('pdFoot').textContent = st.connected ? (t.running ? '' : 'PAUSED') : 'Connection lost: showing the last known time';
  }
  function keepAwake() {
    if (!podium || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').catch(function () { /* the phone may still dim; set its screen timeout */ });
  }

  function safeThumb(url) { return typeof url === 'string' && /^data:image\\/(jpeg|png);base64,[A-Za-z0-9+\\/=]+$/.test(url) ? url : null; }
  function fmt(s) { if (s == null || !isFinite(s)) return ''; s = Math.max(0, Math.floor(s)); var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function thumbEl(url, cls) { var u = safeThumb(url); if (u) { var i = el('img', cls); i.src = u; i.alt = ''; return i; } var d = el('div', cls + ' empty', '▢'); return d; }
  function cueById(id) { for (var i = 0; i < st.cues.length; i++) if (st.cues[i].id === id) return st.cues[i]; return null; }
  function toast(text, ok) { var t = $('toast'); t.textContent = text; t.className = 'show ' + (ok ? 'ok' : 'bad'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ''; }, 2200); }
  function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }
  function can(perm) { return st.role === 'operator' || (!st.locked && !!st.perms[perm]); }

  function send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }
  function act(action, cueId) {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (!send({ type: 'action', action: action, cueId: cueId, requestId: id })) { toast('Not connected', false); return; }
    pending[id] = action; vibrate(25);
  }

  function renderHeader() {
    var r = $('role');
    r.textContent = st.role === 'operator' ? 'AV OPERATOR' : st.role === 'stage' ? 'STAGE TEAM' : 'CONNECTING';
    r.className = 'role' + (st.role === 'stage' ? ' stage' : '');
    $('me').textContent = myName ? myName + ' ✎' : 'Set your name';
    var link = $('link');
    link.textContent = st.connected ? ('LIVE' + (st.latency != null ? ' · ' + st.latency + 'ms' : '')) : (revoked ? 'LINK REVOKED' : 'OFFLINE');
    link.className = 'link' + (st.connected ? ' ok' : '');
    $('offline').className = 'banner off' + (!st.connected ? ' show' : '');
    if (revoked) $('offline').textContent = 'This link was replaced in the AV room. Scan the new QR code.';
    $('locked').className = 'banner lock' + (st.connected && st.role === 'stage' && st.locked ? ' show' : '');
    document.body.className = st.connected ? '' : 'offline';
    var perms = document.querySelectorAll('[data-perm]');
    for (var i = 0; i < perms.length; i++) {
      var p = perms[i].getAttribute('data-perm');
      var allowed = st.role === 'operator' || !!st.perms[p];
      perms[i].classList.toggle('hidden', !allowed);
      if (perms[i].tagName === 'BUTTON') perms[i].disabled = !can(p);
      var inner = perms[i].querySelectorAll('button');
      for (var j = 0; j < inner.length; j++) {
        var own = inner[j].getAttribute('data-perm');
        inner[j].disabled = !can(own || p);
        if (own) inner[j].classList.toggle('hidden', !(st.role === 'operator' || !!st.perms[own]));
      }
    }
  }

  function renderStatus() {
    var s = st.status;
    if (!s) return;
    $('show').textContent = s.showName || 'StageCue AV';
    var live = cueById(s.liveCueId), next = cueById(s.nextCueId);
    $('liveThumb').replaceChildren(thumbEl(live && live.thumb, 'thumb'));
    $('liveTitle').textContent = s.liveCue || '—';
    $('liveSub').textContent = s.videoRemaining != null ? '▶ video −' + fmt(s.videoRemaining) : (s.musicPlaying && s.musicName ? '♪ ' + s.musicName : '');
    $('nextThumb').replaceChildren(thumbEl(next && next.thumb, 'thumb'));
    $('nextTitle').textContent = s.nextCue ? (s.nextCueNumber ? s.nextCueNumber + '. ' : '') + s.nextCue : 'End of list';
    $('nextSub').textContent = s.followCountdown != null ? 'auto in ' + Math.ceil(s.followCountdown) + 's' : (next ? next.detail : '');
    $('goLabel').textContent = s.nextCue ? (s.nextCueNumber ? s.nextCueNumber + '. ' : '') + s.nextCue : 'No cue highlighted';
    $('freezeBtn').textContent = s.isFrozen ? 'UNFREEZE' : 'FREEZE';
    $('freezeBtn').classList.toggle('on-blue', !!s.isFrozen);
    $('blackBtn').classList.toggle('on-red', !!s.isBlackout);
    $('videoBtn').textContent = s.videoPlaying ? '❚❚ VIDEO' : '▶ VIDEO';
    $('musicBtn').textContent = s.musicPlaying ? '❚❚ MUSIC' : '▶ MUSIC';
    $('musicBtn').classList.toggle('on-green', !!s.musicPlaying);
    $('followBtn').textContent = 'AUTO ' + (s.autoFollowEnabled ? 'ON' : 'OFF');
    $('followBtn').classList.toggle('on-amber', !!s.autoFollowEnabled);
    // A PDF booklet / slide deck / web flipbook is live: page buttons.
    var pg = s.paging || null;
    $('pagesWrap').classList.toggle('hidden', !pg);
    if (pg) {
      var lbl = $('pageLabel'); lbl.replaceChildren();
      lbl.appendChild(el('small', '', pg.kind === 'web' ? 'WEB PAGE' : 'BOOKLET'));
      lbl.appendChild(document.createTextNode(pg.page != null ? (pg.page + (pg.pageCount ? ' / ' + pg.pageCount : '')) : '—'));
    }
    var chips = $('chips'); chips.replaceChildren();
    if (s.isFrozen) chips.appendChild(el('span', 'chip frozen', 'FROZEN'));
    if (s.isBlackout) chips.appendChild(el('span', 'chip black', 'BLACKOUT'));
    if (s.projector && s.projector !== 'projector') chips.appendChild(el('span', 'chip warn', 'NO PROJECTOR'));
    if (s.followCountdown != null) chips.appendChild(el('span', 'chip warn', 'NEXT IN ' + Math.ceil(s.followCountdown) + 's'));
    if (s.timer) chips.appendChild(el('span', 'chip ' + (s.timer.remainingMs < 0 ? 'black' : 'warn'), 'SPEAKER ' + fmtClock(s.timer.remainingMs) + (s.timer.message ? ' · ' + s.timer.message : '')));
  }

  function renderCues() {
    var pane = $('cuesPane'); pane.replaceChildren();
    if (!st.cues.length) { pane.appendChild(el('div', 'empty-note', 'No cues yet.')); return; }
    var s = st.status || {};
    st.cues.forEach(function (c) {
      var b = el('button', 'cue' + (c.id === s.liveCueId ? ' is-live' : c.id === s.nextCueId ? ' is-next' : ''));
      b.type = 'button';
      b.appendChild(el('div', 'num', String(c.order)));
      var u = safeThumb(c.thumb);
      if (u) { var img = el('img'); img.src = u; img.alt = ''; b.appendChild(img); } else { b.appendChild(el('div', 'ph', c.kind === 'music' ? '♪' : '▢')); }
      var meta = el('div', 'meta');
      var tag = c.id === s.liveCueId ? 'LIVE' : c.id === s.nextCueId ? 'NEXT' : '';
      if (tag) meta.appendChild(el('div', 'tag', tag));
      meta.appendChild(el('div', 'name', c.label));
      meta.appendChild(el('div', 'det', c.detail + (c.follow ? ' · ' + c.follow : '')));
      if (c.notes) meta.appendChild(el('div', 'note', c.notes));
      b.appendChild(meta);
      b.addEventListener('click', function () { openConfirm(c); });
      pane.appendChild(b);
    });
  }

  function renderFeed() {
    var feed = $('feed'); feed.replaceChildren();
    if (!st.messages.length) { feed.appendChild(el('div', 'empty-note', 'No messages yet.')); }
    st.messages.slice().reverse().forEach(function (m) {
      var box = el('div', 'msg' + (m.role === 'av-room' ? ' av' : '') + (m.kind === 'problem' || m.kind === 'hold' ? ' alert' : ''));
      var from = el('div', 'from');
      from.appendChild(el('span', '', (m.role === 'av-room' ? '🎛 ' : '') + m.from + (m.to ? ' → you' : '')));
      from.appendChild(el('span', '', new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      box.appendChild(from);
      box.appendChild(el('div', 'txt', m.text));
      feed.appendChild(box);
    });
    $('unread').classList.toggle('hidden', !(st.unread > 0 && st.tab !== 'crew'));
  }

  function setTab(tab) {
    st.tab = tab;
    $('tabCues').className = tab === 'cues' ? 'sel' : '';
    $('tabCrew').className = tab === 'crew' ? 'sel' : '';
    $('cuesPane').classList.toggle('hidden', tab !== 'cues');
    $('crewPane').classList.toggle('hidden', tab !== 'crew');
    if (tab === 'crew') st.unread = 0;
    renderFeed();
  }

  function openConfirm(c) {
    if (!can('takeCues')) { toast(st.locked ? 'Locked by the AV room' : 'Only the AV room can play cues', false); return; }
    confirmCue = c;
    $('confirmTitle').textContent = 'Play cue ' + c.order + ': ' + c.label + '?';
    $('confirmThumb').replaceChildren(thumbEl(c.thumb, 'thumb'));
    $('confirmSub').textContent = c.detail + (c.notes ? ' · ' + c.notes : '');
    $('confirm').className = 'sheet-bg show';
  }
  function closeConfirm() { confirmCue = null; $('confirm').className = 'sheet-bg'; }

  function askName() { $('nameInput').value = myName; $('nameSheet').className = 'sheet-bg show'; setTimeout(function () { $('nameInput').focus(); }, 50); }
  function saveName(value) {
    myName = (value || '').trim().slice(0, 32);
    try { localStorage.setItem(NAME_KEY, myName); } catch (e) { /* private mode: the name lasts for this session only */ }
    $('nameSheet').className = 'sheet-bg';
    send({ type: 'hello', name: myName });
    renderHeader();
  }

  function handle(msg) {
    switch (msg.type) {
      case 'hello': st.role = msg.role; st.clientId = msg.clientId; st.perms = msg.permissions || {}; st.locked = !!msg.locked; renderHeader(); renderStatus(); break;
      case 'access': st.perms = msg.permissions || {}; st.locked = !!msg.locked; renderHeader(); toast(st.locked ? 'AV room locked the controls' : 'Controls updated by AV room', !st.locked); break;
      case 'status':
        st.status = msg.status;
        var t = msg.status && msg.status.timer;
        timerBase = t ? { remainingMs: t.remainingMs, running: !!t.running, warnMs: t.warnMs || 0, speaker: t.speaker || '', message: t.message || null, receivedAt: Date.now() } : null;
        renderStatus(); renderCues(); renderPodium(); break;
      case 'cues': st.cues = msg.cues || []; renderCues(); renderStatus(); break;
      case 'history': st.messages = msg.messages || []; renderFeed(); break;
      case 'message':
        st.messages.push(msg.message); st.messages = st.messages.slice(-40);
        if (msg.message.clientId !== st.clientId) {
          if (st.tab !== 'crew') st.unread += 1;
          if (msg.message.role === 'av-room') { vibrate([60, 40, 60]); toast('AV room: ' + msg.message.text, true); }
        }
        renderFeed(); break;
      case 'ack':
        if (pending[msg.requestId] !== undefined) { delete pending[msg.requestId]; toast((msg.ok ? '✓ ' : '✕ ') + msg.message, msg.ok); if (!msg.ok) vibrate([80, 50, 80]); }
        break;
      case 'pong':
        if (typeof msg.t === 'number' && msg.t > 0) { st.latency = Date.now() - msg.t; send({ type: 'latency', ms: st.latency }); renderHeader(); }
        break;
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    // Works at "/" (laptop or tunnel) and at "/r/<room>/" (relay server).
    var base = location.pathname.replace(/[^/]*$/, '') || '/';
    ws = new WebSocket(proto + location.host + base + 'ws?t=' + encodeURIComponent(token));
    ws.onopen = function () {
      st.connected = true; retry = 500; send({ type: 'hello', name: myName });
      clearInterval(pingTimer); pingTimer = setInterval(function () { send({ type: 'ping', t: Date.now() }); }, 3000);
      send({ type: 'ping', t: Date.now() });
      renderHeader();
    };
    ws.onmessage = function (e) { try { handle(JSON.parse(e.data)); } catch (err) { toast('Bad message from StageCue', false); } };
    ws.onclose = function (e) {
      st.connected = false; st.latency = null; clearInterval(pingTimer);
      if (e.code === 4001) { revoked = true; renderHeader(); return; }
      $('offline').textContent = e.code === 1013 || e.code === 1012
        ? 'The AV laptop is offline or restarting. Reconnecting automatically…'
        : 'Reconnecting to StageCue… Check that this phone has a working internet or Wi-Fi connection.';
      renderHeader();
      setTimeout(connect, retry); retry = Math.min(retry * 2, 5000);
    };
    ws.onerror = function () { try { ws.close(); } catch (err) { st.connected = false; } };
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (b) {
    b.addEventListener('click', function () { act(b.getAttribute('data-action')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-msg]'), function (b) {
    b.addEventListener('click', function () { if (send({ type: 'message', kind: b.getAttribute('data-msg'), text: b.getAttribute('data-text') })) { vibrate(20); toast('Sent: ' + b.getAttribute('data-text'), true); } else toast('Not connected', false); });
  });
  $('compose').addEventListener('submit', function (e) {
    e.preventDefault(); var t = $('msgText').value.trim(); if (!t) return;
    if (send({ type: 'message', kind: 'custom', text: t })) { $('msgText').value = ''; vibrate(20); } else toast('Not connected', false);
  });
  $('tabCues').addEventListener('click', function () { setTab('cues'); });
  $('tabCrew').addEventListener('click', function () { setTab('crew'); });
  $('confirmNo').addEventListener('click', closeConfirm);
  $('confirm').addEventListener('click', function (e) { if (e.target === $('confirm')) closeConfirm(); });
  $('confirmYes').addEventListener('click', function () { if (confirmCue) act('take-cue', confirmCue.id); closeConfirm(); });
  $('me').addEventListener('click', askName);
  $('nameSave').addEventListener('click', function () { saveName($('nameInput').value); });
  $('nameSkip').addEventListener('click', function () { saveName(myName); });
  $('nameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveName($('nameInput').value); });

  renderHeader(); renderCues(); renderFeed();
  if (podium) {
    $('app').classList.add('hidden');
    $('podium').classList.remove('hidden');
    setInterval(renderPodium, 200);
    keepAwake();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') keepAwake(); });
    renderPodium();
  } else if (!myName) {
    askName();
  }
  connect();
})();
</script>
</body>
</html>`;
