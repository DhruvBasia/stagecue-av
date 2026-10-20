/* =========================================================================
 * StageCue AV — shared domain & IPC contracts.
 * Imported by the main process, the preload bridge and both renderers.
 * ========================================================================= */

/** Kinds that are files on disk. */
export type FileMediaType = 'image' | 'video' | 'audio';
/**
 * web    – a live web page (e.g. an online flipbook magazine) shown on stage and
 *          controlled from the operator window.
 * screen – a live capture of an app window or a whole screen.
 */
export type MediaType = FileMediaType | 'web' | 'screen';
export type TransitionType = 'cut' | 'fade' | 'dissolve';

export interface WebPageRef {
  url: string;
}

export interface CaptureRef {
  /** desktopCapturer id; window ids change when the app restarts, so `name` is used to find it again. */
  sourceId: string;
  kind: 'window' | 'screen';
}

export interface MediaItem {
  id: string;
  name: string;
  filePath: string;
  fileUrl: string; // local-media:// protocol URL
  type: MediaType;
  duration?: number;
  dimensions?: { width: number; height: number };
  thumbnailUrl?: string;
  sizeBytes?: number;
  /** True when the file could not be found on disk (e.g. a show moved between machines). */
  missing?: boolean;
  /** Human-readable reason why metadata probing failed (codec unsupported, timeout, ...). */
  probeError?: string;
  /** Set for backdrops rendered from a PDF page; filePath/fileUrl point at the cached render. */
  pdf?: PdfPageRef;
  /** type 'web': the page address (filePath/fileUrl hold the same URL). */
  web?: WebPageRef;
  /** type 'screen': the window or screen to capture (filePath holds its name). */
  capture?: CaptureRef;
}

export interface PdfPageRef {
  sourcePath: string;
  page: number;
  pageCount: number;
  /** Source PDF path relative to the show file (filled in when saving). */
  relativeSourcePath?: string;
  /** The PowerPoint/Impress deck this PDF was converted from (slides). */
  originalPath?: string;
  relativeOriginalPath?: string;
}

export interface PdfCacheRequest {
  sourcePath: string;
  page: number;
  /** Render resolution, e.g. "3840x2160". Part of the cache key. */
  renderKey: string;
}

export interface PdfCacheStoreRequest extends PdfCacheRequest {
  /** PNG bytes of the rendered page. */
  data: Uint8Array;
}

export interface CueItem {
  id: string;
  order: number;
  label: string;
  backdropMediaId?: string;
  foregroundMediaId?: string;
  audioMediaId?: string;
  transition: TransitionType;
  transitionDurationMs: number;
  autoPlayForeground: boolean;
  loopBackdrop: boolean;
  loopAudio: boolean;
  audioVolume: number; // 0.0 to 1.0
  duckAudioOnVideo: boolean;
  notes?: string;
  /** What happens after this cue is taken (only when Auto-follow is switched on). */
  followMode?: FollowMode;
  /** Seconds to wait for 'after-delay'. */
  followDelaySec?: number;
  /** Cue to take next; empty means the following cue in the stack. */
  followTargetId?: string;
}

/**
 * off          – operator presses TAKE as usual.
 * on-end       – take the next cue when this cue's video finishes.
 * after-delay  – take the next cue after N seconds (poster slideshows, sponsor loops).
 */
export type FollowMode = 'off' | 'on-end' | 'after-delay';

export interface ShowSettings {
  /** Master switch for every cue's follow rule. */
  autoFollowEnabled: boolean;
}

export interface AudioOutputPref {
  deviceId: string;
  label: string;
}

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

export interface AudioDevicesPayload {
  devices: AudioOutputDevice[];
  /** '' is the system default output. */
  currentSinkId: string;
  supported: boolean;
  error: string | null;
}

export type RemoteActionName =
  | 'take'
  | 'take-cue'
  | 'next-cue'
  | 'prev-cue'
  | 'freeze'
  | 'blackout'
  | 'instant-backdrop'
  | 'fade-audio'
  | 'toggle-video'
  | 'music-toggle'
  | 'toggle-follow'
  | 'page-next'
  | 'page-prev';

export const REMOTE_ACTIONS: readonly RemoteActionName[] = [
  'take',
  'take-cue',
  'next-cue',
  'prev-cue',
  'freeze',
  'blackout',
  'instant-backdrop',
  'fade-audio',
  'toggle-video',
  'music-toggle',
  'toggle-follow',
  'page-next',
  'page-prev'
];

/** A live cue whose pages can be turned: a PDF booklet or a web page (flipbook). */
export interface LivePaging {
  kind: 'pdf' | 'web';
  /** Current page (web: read from a ?page= address when the site has one). */
  page: number | null;
  pageCount: number | null;
}

/**
 * operator – the AV-room's own phone: full control, never locked.
 * stage    – the crew beside the stage: only what the AV room allows.
 */
export type RemoteRole = 'operator' | 'stage';

export interface StageTeamPermissions {
  /** GO / play any cue from the list. */
  takeCues: boolean;
  /** Play/pause the program video and the background music, fade audio. */
  mediaControls: boolean;
  /** Freeze, blackout, instant backdrop. */
  emergency: boolean;
  /** Switch auto-follow on/off. */
  autoFollow: boolean;
}

export const DEFAULT_STAGE_PERMISSIONS: StageTeamPermissions = {
  takeCues: true,
  mediaControls: true,
  emergency: false,
  autoFollow: false
};

export interface RemoteActionEvent {
  requestId: string;
  action: RemoteActionName;
  cueId?: string;
  clientId: string;
  clientName: string;
  role: RemoteRole;
}

export interface RemoteAck {
  requestId: string;
  ok: boolean;
  message: string;
}

export type CrewMessageKind = 'standby' | 'ready' | 'hold' | 'guest-arrived' | 'problem' | 'custom' | 'reply';

export const CREW_MESSAGE_KINDS: readonly CrewMessageKind[] = [
  'standby',
  'ready',
  'hold',
  'guest-arrived',
  'problem',
  'custom',
  'reply'
];

export interface CrewMessage {
  id: string;
  kind: CrewMessageKind;
  text: string;
  from: string;
  role: RemoteRole | 'av-room';
  /** Sender device (null for the AV room). */
  clientId: string | null;
  /** Recipient device; null = everyone. */
  to: string | null;
  at: number;
}

export interface CrewMessageRequest {
  kind: CrewMessageKind;
  text: string;
  /** Recipient device id; null = all connected devices. */
  to: string | null;
}

/**
 * How phones reach the laptop.
 *   off    – same Wi-Fi / hotspot only
 *   tunnel – Cloudflare quick tunnel (cloudflared): any network, no server to run
 *   relay  – your own StageCue relay server: any network, permanent URL
 */
export type InternetMode = 'off' | 'tunnel' | 'relay';

export interface InternetConfig {
  mode: InternetMode;
  relayUrl: string;
  /** Public room id on the relay (part of the phone links). */
  roomId: string;
  /** Proves to the relay that this laptop owns the room. */
  roomSecret: string;
  /** Optional key some relays require before a laptop may host. */
  relayHostKey: string;
}

export type InternetState = 'off' | 'starting' | 'online' | 'reconnecting' | 'error' | 'not-installed';

export interface InternetStatus {
  mode: InternetMode;
  state: InternetState;
  /** Public https base the phones open (null until online). */
  publicBase: string | null;
  error: string | null;
}

export interface RemoteClientInfo {
  id: string;
  name: string;
  role: RemoteRole;
  /** 'lan' = same network, 'internet' = through the tunnel or relay. */
  via: 'lan' | 'internet';
  address: string;
  connectedAt: number;
  lastSeen: number;
  latencyMs: number | null;
}

export type RemoteCueKind = 'backdrop' | 'video' | 'music' | 'mixed' | 'empty';

/** Cue-list entry sent to phones/tablets (thumbnails are small JPEG data URLs). */
export interface RemoteCue {
  id: string;
  order: number;
  label: string;
  kind: RemoteCueKind;
  thumb: string | null;
  detail: string;
  notes: string | null;
  follow: string | null;
}

export interface RemoteStatus {
  showName: string;
  liveCue: string | null;
  liveCueId: string | null;
  nextCue: string | null;
  nextCueId: string | null;
  nextCueNumber: number | null;
  isFrozen: boolean;
  isBlackout: boolean;
  videoPlaying: boolean;
  videoRemaining: number | null;
  musicName: string | null;
  musicPlaying: boolean;
  autoFollowEnabled: boolean;
  followCountdown: number | null;
  projector: StageMode | null;
  /** Set while a PDF booklet or web page is live: phones show page buttons. */
  paging: LivePaging | null;
}

export interface RemoteConfigRequest {
  enabled: boolean;
  port: number;
  operatorToken?: string;
  stageToken?: string;
  /** Issue brand-new links (old QR codes stop working, connected phones are dropped). */
  regenerate?: boolean;
  stagePermissions: StageTeamPermissions;
  stageLocked: boolean;
  internet: InternetConfig;
}

export interface RemoteLink {
  role: RemoteRole;
  url: string;
  /** 'internet' links work from any network; 'lan' links only on the same network. */
  scope: 'internet' | 'lan';
  address: string;
  interfaceName: string;
  /** Windows Mobile Hotspot / laptop-created network: works without venue Wi-Fi. */
  hotspot: boolean;
}

export interface RemoteInfo {
  enabled: boolean;
  port: number;
  operatorToken: string;
  stageToken: string;
  links: RemoteLink[];
  clients: RemoteClientInfo[];
  stagePermissions: StageTeamPermissions;
  stageLocked: boolean;
  internet: InternetStatus;
  error: string | null;
}

export interface RunSheetExportRequest {
  html: string;
  mode: 'pdf' | 'print';
  suggestedName: string;
}

export type RunSheetExportResult =
  | { ok: true; filePath: string | null }
  | { ok: false; canceled: boolean; error?: string };

/* ------------------------------ Google Drive ------------------------------ */

/** A shared Drive folder that is downloaded into a local folder linked to the library. */
export interface DriveSource {
  id: string;
  url: string;
  folderId: string;
  resourceKey?: string;
  name: string;
  /** Local copy (linked to the media library). */
  localPath: string;
}

export interface DriveInspectRequest {
  url: string;
  /** Destination folder; null = Documents/StageCue Drive/<folder name>. */
  localDir: string | null;
  apiKey: string | null;
}

export interface DriveSyncRequest {
  source: DriveSource;
  apiKey: string | null;
}

export type DriveSyncPhase = 'listing' | 'downloading' | 'done' | 'error';

export interface DriveSyncProgress {
  sourceId: string;
  phase: DriveSyncPhase;
  done: number;
  total: number;
  current: string | null;
  error: string | null;
}

export interface DriveSyncResult {
  sourceId: string;
  ok: boolean;
  /** 'api' = Drive API with key, 'public-page' = keyless public folder page. */
  mode: 'api' | 'public-page';
  listed: number;
  /** Local paths of files downloaded for the first time. */
  downloaded: string[];
  /** Local paths of files re-downloaded because they changed on Drive. */
  updated: string[];
  unchanged: number;
  /** Names of files that are not playable media (documents, zips…). */
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
  /** Files no longer on Drive; their local copies are kept. */
  removedRemote: string[];
  error: string | null;
  at: number;
}

export interface StageState {
  currentBackdrop: MediaItem | null;
  currentForeground: MediaItem | null;
  isForegroundPlaying: boolean;
  foregroundCurrentTime: number;
  foregroundDuration: number;
  isFrozen: boolean;
  isBlackout: boolean;
  transitionDurationMs: number;
}

export interface AudioState {
  bgMusicMedia: MediaItem | null;
  isBgMusicPlaying: boolean;
  bgMusicVolume: number;
  videoAudioVolume: number;
  masterVolume: number;
  isMuted: boolean;
  isDucked: boolean;
  duckAttenuationPercent: number; // default 80% (drops volume to 20%)
  autoDuckEnabled: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
  isPrimary: boolean;
  isExternal: boolean;
  name: string;
}

/* ----------------------------- Display status ---------------------------- */

/**
 * projector  – stage window is fullscreen on an external (HDMI) display.
 * rehearsal  – no external display at launch; 1280x720 windowed preview.
 * docked     – the HDMI cable was pulled mid-show; small floating window.
 */
export type StageMode = 'projector' | 'rehearsal' | 'docked';

export type DisplayChangeReason =
  | 'startup'
  | 'display-added'
  | 'display-removed'
  | 'metrics-changed'
  | 'manual';

export interface DisplayStatus {
  mode: StageMode;
  displays: DisplayInfo[];
  stageDisplayId: number | null;
  operatorDisplayId: number;
  preferredStageDisplayId: number | null;
  reason: DisplayChangeReason;
  changedAt: number;
}

/* ------------------------------ Stage payloads --------------------------- */

export interface StageCuePayload {
  /** Monotonic take counter. A re-take of the same media restarts it. */
  takeId: number;
  cueId: string | null;
  label: string;
  backdrop: MediaItem | null;
  foreground: MediaItem | null;
  transition: TransitionType;
  transitionDurationMs: number;
  autoPlayForeground: boolean;
  loopBackdrop: boolean;
  duckAudioOnVideo: boolean;
  /** Resume position for the foreground (used when re-syncing a restarted stage window). */
  foregroundStartAt?: number;
}

export interface FreezeRequest {
  requestedAt: number;
}

export interface UnfreezeRequest {
  requestedAt: number;
  fadeMs: number;
}

export interface BlackoutPayload {
  active: boolean;
  fadeMs: number;
}

export interface ClearForegroundPayload {
  fadeMs: number;
}

export type VideoControl =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'restart' }
  | { action: 'seek'; time: number };

export type FreezeSource = 'composite' | 'backdrop' | 'foreground' | 'empty';

export interface FreezeAck {
  isFrozen: boolean;
  requestedAt: number;
  acknowledgedAt: number;
  latencyMs: number;
  source: FreezeSource;
}

export type MediaLayer = 'backdrop' | 'foreground' | 'music' | 'stage';

export interface MediaErrorPayload {
  mediaId: string | null;
  mediaName: string;
  layer: MediaLayer;
  takeId: number | null;
  message: string;
  code: number | null;
}

/* ------------------------- Web pages & screen capture --------------------- */

/** Session for on-stage web pages: the only one the stage may embed, sandboxed and without permissions. */
export const WEB_PARTITION = 'persist:stagecue-web';

/** Stage → main: which on-stage web page (webview guest) is the live one. */
export interface StageWebLivePayload {
  mediaId: string | null;
  takeId: number;
  /** webContents id of the live <webview>; null when no web page is on stage. */
  webContentsId: number | null;
  /** The address the cue asked for ("home" for the operator's Home button). */
  homeUrl: string | null;
}

export const WEB_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space',
  'Enter',
  'Escape'
] as const;
export type WebKey = (typeof WEB_KEYS)[number];

/** Operator → main: input for the live web page. Pointer coordinates are 0–1 of the page. */
export type WebInput =
  | { type: 'pointer'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaY: number }
  | { type: 'key'; key: WebKey }
  | { type: 'nav'; action: 'back' | 'forward' | 'reload' | 'home' }
  | { type: 'mute'; muted: boolean };

/** Main → operator: live picture and state of the on-stage web page. */
export interface WebFrame {
  mediaId: string;
  /** JPEG data URL; null when the picture has not changed since the last frame. */
  image: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  muted: boolean;
  /** Page number from a ?page= address (flipbooks), else null. */
  page: number | null;
  at: number;
}

export interface WebInspectRequest {
  url: string;
  /** Also load the page off-screen and return its title and a thumbnail. */
  snapshot: boolean;
}

export interface WebInspectResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** Address after redirects. */
  finalUrl: string;
  title: string | null;
  /** Small JPEG data URL of the loaded page. */
  thumbnail: string | null;
}

/** A window or screen that can be shown on stage. */
export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  /** Small JPEG data URL. */
  thumbnail: string;
}

export interface CaptureResolveRequest {
  sourceId: string;
  name: string;
  kind: 'window' | 'screen';
}

export interface ForegroundEndedPayload {
  mediaId: string;
  takeId: number;
  cueId: string | null;
}

export interface StageTelemetry extends StageState {
  takeId: number;
  cueId: string | null;
  displayMode: StageMode | null;
  sentAt: number;
}

/* ------------------------------ Audio payloads --------------------------- */

export interface AudioMix {
  bgMusicVolume: number;
  videoAudioVolume: number;
  masterVolume: number;
  isMuted: boolean;
  autoDuckEnabled: boolean;
  duckAttenuationPercent: number;
}

export type AudioCommand =
  | {
      type: 'music-load';
      media: MediaItem;
      loop: boolean;
      autoplay: boolean;
      crossfadeMs: number;
      startAt?: number;
    }
  | { type: 'music-play' }
  | { type: 'music-pause' }
  | { type: 'music-stop'; fadeMs: number }
  | { type: 'music-fade-out'; durationMs: number }
  | { type: 'music-seek'; time: number }
  | { type: 'music-set-loop'; loop: boolean }
  | { type: 'set-mix'; mix: AudioMix }
  | { type: 'set-output'; deviceId: string }
  | { type: 'refresh-devices' };

export interface AudioLevels {
  music: number;
  video: number;
  master: number;
}

export interface AudioTelemetry {
  bgMusicMediaId: string | null;
  bgMusicName: string | null;
  isBgMusicPlaying: boolean;
  musicCurrentTime: number;
  musicDuration: number;
  musicLoop: boolean;
  isDucked: boolean;
  isFadingOut: boolean;
  fadeEndsAt: number | null;
  levels: AudioLevels;
  contextState: string;
  /** Output device the stage is playing to ('' = system default). */
  sinkId: string;
  sentAt: number;
}

export interface MusicSyncState {
  media: MediaItem;
  loop: boolean;
  playing: boolean;
  currentTime: number;
}

export interface StageSyncSnapshot {
  cue: StageCuePayload | null;
  isBlackout: boolean;
  mix: AudioMix;
  music: MusicSyncState | null;
  outputDeviceId: string;
}

export interface StageReadyPayload {
  loadedAt: number;
}

export interface StageConnectionPayload {
  connected: boolean;
  reason: 'ready' | 'crashed' | 'unresponsive' | 'responsive' | 'closed';
  at: number;
}

export type MenuCommand =
  | 'new-show'
  | 'open-show'
  | 'save-show'
  | 'save-show-as'
  | 'import-media'
  | 'import-folder'
  | 'preshow-check'
  | 'export-runsheet'
  | 'print-runsheet'
  | 'open-settings';

/* ---------------------------- Media & show files ------------------------- */

export interface MediaDialogOptions {
  types: FileMediaType[];
  multiSelections: boolean;
}

export interface MediaPathRequest {
  filePath: string;
  relativePath?: string;
  baseDir?: string;
}

export interface ResolvedMediaFile {
  requestedPath: string;
  filePath: string;
  fileUrl: string;
  name: string;
  type: FileMediaType | null;
  sizeBytes: number;
  exists: boolean;
  /** A PDF document: must be rendered into per-page backdrops before use. */
  isPdf?: boolean;
  /** A PowerPoint/Impress deck: converted to PDF, then one backdrop per slide. */
  isPresentation?: boolean;
}

export interface FolderScanResult {
  folderPath: string;
  exists: boolean;
  /** Supported media found in the folder tree, in natural (01, 02, … 10) order. */
  files: ResolvedMediaFile[];
  /** Non-media files and unreadable folders that were ignored. */
  skipped: number;
  /** True when the scan stopped at the file limit. */
  truncated: boolean;
}

export interface ExpandedPaths {
  files: ResolvedMediaFile[];
  folders: FolderScanResult[];
}

export interface StoredMediaRef {
  id: string;
  name: string;
  type: MediaType;
  filePath: string;
  relativePath?: string;
  duration?: number;
  dimensions?: { width: number; height: number };
  pdf?: PdfPageRef;
  web?: WebPageRef;
  capture?: CaptureRef;
}

export const SHOW_FILE_VERSION = 1;

export interface ShowFile {
  app: 'stagecue-av';
  version: typeof SHOW_FILE_VERSION;
  name: string;
  savedAt: string;
  media: StoredMediaRef[];
  cues: CueItem[];
  audio: AudioMix;
  /** Event folders linked to the library (re-scanned on demand). */
  folders?: string[];
  settings?: ShowSettings;
  audioOutput?: AudioOutputPref | null;
  /** Google Drive folders synced for this event (performer tracks). */
  driveSources?: DriveSource[];
}

export interface ShowSaveRequest {
  show: ShowFile;
  filePath: string | null;
  saveAs: boolean;
}

export type ShowSaveResult =
  | { ok: true; filePath: string; savedAt: string }
  | { ok: false; canceled: boolean; error?: string };

export interface ShowOpenResult {
  filePath: string;
  baseDir: string;
  content: string;
}

/* ------------------------------- IPC contracts --------------------------- */

export const OPERATOR_TO_STAGE_CHANNELS = [
  'stage:take-cue',
  'stage:action-freeze',
  'stage:action-unfreeze',
  'stage:action-blackout',
  'stage:action-clear-foreground',
  'stage:video-control',
  'stage:full-sync',
  'audio:command'
] as const;

export const STAGE_TO_OPERATOR_CHANNELS = [
  'stage:state-update',
  'stage:freeze-ack',
  'stage:media-error',
  'stage:foreground-ended',
  'audio:state-update',
  'audio:devices'
] as const;

export const RENDERER_TO_MAIN_CHANNELS = [
  'stage:ready',
  'app:set-dirty',
  'remote:status',
  'remote:cues',
  'remote:ack',
  'remote:send-message',
  'stage:web-live',
  'web:input'
] as const;

export const MAIN_TO_RENDERER_CHANNELS = [
  'display:changed',
  'menu:command',
  'stage:connected',
  'remote:action',
  'remote:info',
  'remote:message',
  'drive:progress',
  'web:frame'
] as const;

export const INVOKE_CHANNELS = [
  'display:get-list',
  'display:set-stage-target',
  'display:raise-stage',
  'media:open-file-dialog',
  'media:read-metadata',
  'media:open-folder-dialog',
  'media:scan-folder',
  'media:expand-paths',
  'media:pdf-cache-lookup',
  'media:pdf-cache-store',
  'show:save',
  'show:open',
  'remote:configure',
  'runsheet:export',
  'media:convert-presentation',
  'app:open-hotspot-settings',
  'drive:inspect',
  'drive:sync',
  'drive:choose-folder',
  'drive:open-folder',
  'stage:capture-web',
  'web:inspect',
  'capture:list-sources',
  'capture:resolve'
] as const;

/** The only invoke channels the stage window may use. */
export const STAGE_INVOKE_CHANNELS = ['display:get-list', 'stage:capture-web', 'capture:resolve'] as const;

export type OperatorToStageChannel = (typeof OPERATOR_TO_STAGE_CHANNELS)[number];
export type StageToOperatorChannel = (typeof STAGE_TO_OPERATOR_CHANNELS)[number];
export type RendererToMainChannel = (typeof RENDERER_TO_MAIN_CHANNELS)[number];
export type MainToRendererChannel = (typeof MAIN_TO_RENDERER_CHANNELS)[number];
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

export type IpcChannels =
  | OperatorToStageChannel
  | StageToOperatorChannel
  | RendererToMainChannel
  | MainToRendererChannel
  | InvokeChannel;

export interface OperatorToStagePayloads {
  'stage:take-cue': StageCuePayload;
  'stage:action-freeze': FreezeRequest;
  'stage:action-unfreeze': UnfreezeRequest;
  'stage:action-blackout': BlackoutPayload;
  'stage:action-clear-foreground': ClearForegroundPayload;
  'stage:video-control': VideoControl;
  'stage:full-sync': StageSyncSnapshot;
  'audio:command': AudioCommand;
}

export interface StageToOperatorPayloads {
  'stage:state-update': StageTelemetry;
  'stage:freeze-ack': FreezeAck;
  'stage:media-error': MediaErrorPayload;
  'stage:foreground-ended': ForegroundEndedPayload;
  'audio:state-update': AudioTelemetry;
  'audio:devices': AudioDevicesPayload;
}

export interface RendererToMainPayloads {
  'stage:ready': StageReadyPayload;
  'app:set-dirty': { dirty: boolean };
  'remote:status': RemoteStatus;
  'remote:cues': RemoteCue[];
  'remote:ack': RemoteAck;
  'remote:send-message': CrewMessageRequest;
  'stage:web-live': StageWebLivePayload;
  'web:input': WebInput;
}

export interface MainToRendererPayloads {
  'display:changed': DisplayStatus;
  'menu:command': MenuCommand;
  'stage:connected': StageConnectionPayload;
  'remote:action': RemoteActionEvent;
  'remote:info': RemoteInfo;
  'remote:message': CrewMessage;
  'drive:progress': DriveSyncProgress;
  'web:frame': WebFrame;
}

export interface InvokeContracts {
  'display:get-list': { args: []; result: DisplayStatus };
  'display:set-stage-target': { args: [displayId: number | null]; result: DisplayStatus };
  'display:raise-stage': { args: []; result: boolean };
  'media:open-file-dialog': { args: [options: MediaDialogOptions]; result: ResolvedMediaFile[] };
  'media:read-metadata': { args: [requests: MediaPathRequest[]]; result: ResolvedMediaFile[] };
  'media:open-folder-dialog': { args: []; result: FolderScanResult | null };
  'media:scan-folder': { args: [folderPath: string]; result: FolderScanResult };
  'media:expand-paths': { args: [paths: string[]]; result: ExpandedPaths };
  'media:pdf-cache-lookup': { args: [request: PdfCacheRequest]; result: ResolvedMediaFile | null };
  'media:pdf-cache-store': { args: [request: PdfCacheStoreRequest]; result: ResolvedMediaFile };
  'show:save': { args: [request: ShowSaveRequest]; result: ShowSaveResult };
  'show:open': { args: []; result: ShowOpenResult | null };
  'remote:configure': { args: [request: RemoteConfigRequest]; result: RemoteInfo };
  'runsheet:export': { args: [request: RunSheetExportRequest]; result: RunSheetExportResult };
  'media:convert-presentation': { args: [filePath: string]; result: ResolvedMediaFile };
  'app:open-hotspot-settings': { args: []; result: boolean };
  'drive:inspect': { args: [request: DriveInspectRequest]; result: DriveSource };
  'drive:sync': { args: [request: DriveSyncRequest]; result: DriveSyncResult };
  'drive:choose-folder': { args: []; result: string | null };
  'drive:open-folder': { args: [localPath: string]; result: boolean };
  /** Full-resolution JPEG data URL of the live on-stage web page (used for freeze). */
  'stage:capture-web': { args: []; result: string | null };
  'web:inspect': { args: [request: WebInspectRequest]; result: WebInspectResult };
  'capture:list-sources': { args: []; result: CaptureSourceInfo[] };
  /** Current id of a window/screen (window ids change after an app restart). */
  'capture:resolve': { args: [request: CaptureResolveRequest]; result: string | null };
}

export type SendPayloads = OperatorToStagePayloads & StageToOperatorPayloads & RendererToMainPayloads;
export type ReceivePayloads = OperatorToStagePayloads & StageToOperatorPayloads & MainToRendererPayloads;

export type WindowRole = 'operator' | 'stage';

export interface StageCueApi {
  readonly role: WindowRole;
  readonly platform: string;
  readonly isE2E: boolean;
  send<C extends keyof SendPayloads>(channel: C, payload: SendPayloads[C]): void;
  on<C extends keyof ReceivePayloads>(
    channel: C,
    listener: (payload: ReceivePayloads[C]) => void
  ): () => void;
  invoke<C extends keyof InvokeContracts>(
    channel: C,
    ...args: InvokeContracts[C]['args']
  ): Promise<InvokeContracts[C]['result']>;
  getPathForFile(file: File): string;
}

/* ------------------------------ Operator alerts -------------------------- */

export type AlertLevel = 'info' | 'success' | 'warning' | 'error';

export interface OperatorAlert {
  id: string;
  level: AlertLevel;
  title: string;
  message: string;
  at: number;
  sticky: boolean;
}
