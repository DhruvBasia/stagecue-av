import {
  AlertTriangle,
  AppWindow,
  Cloud,
  Download,
  Film,
  FolderOpen,
  FolderPlus,
  Globe,
  ImageIcon,
  ListOrdered,
  ListPlus,
  Loader2,
  Music,
  RefreshCw,
  Search,
  Trash2,
  Unlink,
  Upload,
  X,
  Zap
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MediaItem, MediaType } from '../../types';
import { markDropHandled, saveWebPageOffline } from '../../services/operatorBridge';
import { baseName, formatBytes, formatTime, MEDIA_TYPE_LABEL, mediaPathKey, sourcePathOf } from '../../services/utils';
import { useMediaStore } from '../../store/useMediaStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { useDriveStore } from '../../store/useDriveStore';
import { BuildCuesModal } from './BuildCuesModal';
import { DriveModal } from './DriveModal';
import { MEDIA_DRAG_TYPE } from './CueList';
import { AddWebPageModal, CapturePickerModal } from './LiveSourceModals';

type BinKey = 'image' | 'video' | 'audio' | 'live';

const BINS: Array<{ key: BinKey; types: MediaType[]; short: string; label: string; icon: JSX.Element }> = [
  { key: 'image', types: ['image'], short: 'Backdrops', label: MEDIA_TYPE_LABEL.image, icon: <ImageIcon size={14} /> },
  { key: 'video', types: ['video'], short: 'Videos', label: MEDIA_TYPE_LABEL.video, icon: <Film size={14} /> },
  { key: 'audio', types: ['audio'], short: 'Tracks', label: MEDIA_TYPE_LABEL.audio, icon: <Music size={14} /> },
  { key: 'live', types: ['web', 'screen'], short: 'Live', label: 'Web pages & windows', icon: <Globe size={14} /> }
];

function binOf(type: MediaType): BinKey {
  return type === 'web' || type === 'screen' ? 'live' : type;
}

function MediaCard({ item, probing, isNew }: { item: MediaItem; probing: boolean; isNew: boolean }): JSX.Element {
  const addMediaAsCue = useStageStore((s) => s.addMediaAsCue);
  const takeMedia = useStageStore((s) => s.takeMedia);
  const detachMedia = useStageStore((s) => s.detachMedia);
  const removeItem = useMediaStore((s) => s.removeItem);
  const offlineBusy = useMediaStore((s) => Boolean(s.pdfJobs[`offline:${item.id}`]));

  const meta: string[] = [];
  if (item.dimensions) meta.push(`${item.dimensions.width}×${item.dimensions.height}`);
  if (item.duration !== undefined) meta.push(formatTime(item.duration));
  if (item.sizeBytes) meta.push(formatBytes(item.sizeBytes));

  return (
    <div
      draggable={!item.missing}
      onDragStart={(event) => {
        event.dataTransfer.setData(MEDIA_DRAG_TYPE, item.id);
        event.dataTransfer.effectAllowed = 'copyLink';
      }}
      data-testid="media-card"
      data-media-id={item.id}
      className={`group overflow-hidden rounded-md border bg-av-bg transition-colors ${
        item.missing ? 'border-av-red/60' : 'border-av-border hover:border-av-muted/60'
      }`}
      title={
        item.pdf
          ? `${item.pdf.originalPath ?? item.pdf.sourcePath} — ${item.pdf.originalPath ? 'slide' : 'page'} ${item.pdf.page}`
          : item.filePath
      }
    >
      <div className="relative aspect-video bg-black">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-av-dim">
            {probing ? (
              <Loader2 size={18} className="animate-spin" />
            ) : item.type === 'audio' ? (
              <Music size={22} />
            ) : item.type === 'video' ? (
              <Film size={22} />
            ) : item.type === 'web' ? (
              <Globe size={22} />
            ) : item.type === 'screen' ? (
              <AppWindow size={22} />
            ) : (
              <ImageIcon size={22} />
            )}
          </div>
        )}
        {isNew && !item.missing ? (
          <span
            className="absolute right-1 top-1 rounded bg-av-green px-1 py-px text-[10px] font-black tracking-wider text-av-bg"
            title="Just arrived; not used yet"
            data-testid="new-badge"
          >
            NEW
          </span>
        ) : null}
        {item.missing || item.probeError ? (
          <span
            className={`absolute left-1 top-1 inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-bold ${
              item.missing ? 'bg-av-red text-av-bg' : 'bg-av-amber text-av-bg'
            }`}
            title={item.missing ? 'File not found on disk' : item.probeError}
          >
            <AlertTriangle size={10} /> {item.missing ? 'MISSING' : 'CHECK'}
          </span>
        ) : null}
        {item.pdf ? (
          <span
            className="absolute bottom-1 right-1 rounded bg-av-red/90 px-1 font-mono text-[10px] font-bold text-av-bg"
            title={item.pdf.sourcePath}
            data-testid="pdf-badge"
          >
            {item.pdf.originalPath ? 'SLIDE' : 'PDF'} {item.pdf.page}/{item.pdf.pageCount}
          </span>
        ) : null}
        {item.duration !== undefined ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 font-mono text-[10px] text-av-text">
            {formatTime(item.duration)}
          </span>
        ) : null}
        {item.type === 'web' || item.type === 'screen' ? (
          <span
            className="absolute bottom-1 right-1 rounded bg-av-blue/90 px-1 font-mono text-[10px] font-bold text-av-bg"
            data-testid="live-badge"
          >
            {item.type === 'web' ? 'WEB' : item.capture?.kind === 'screen' ? 'SCREEN' : 'WINDOW'}
          </span>
        ) : null}
        <div className="absolute inset-0 flex flex-wrap content-center items-center justify-center gap-1 bg-black/60 p-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            size="xs"
            variant="secondary"
            icon={<ListPlus size={12} />}
            disabled={item.missing}
            onClick={() => addMediaAsCue(item)}
            title="Append a cue using this file"
          >
            Cue
          </Button>
          <Button
            size="xs"
            variant="warning"
            icon={<Zap size={12} />}
            disabled={item.missing}
            onClick={() => takeMedia(item)}
            title={item.type === 'audio' ? 'Play this track now' : 'Put this on the projector now'}
          >
            Now
          </Button>
          {item.type === 'web' ? (
            <Button
              size="xs"
              variant="info"
              icon={offlineBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              disabled={offlineBusy}
              onClick={() => void saveWebPageOffline(item)}
              title="Save every page as a PDF booklet that plays without internet (takes about a minute)"
              data-testid="make-offline"
            >
              Offline
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex items-start gap-1 px-1.5 py-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-av-text">{item.name}</div>
          <div className="truncate font-mono text-[10px] text-av-dim">{meta.join(' · ') || ' '}</div>
        </div>
        <button
          type="button"
          className="rounded p-0.5 text-av-dim opacity-0 hover:bg-av-raised hover:text-av-red group-hover:opacity-100"
          aria-label={`Remove ${item.name} from library`}
          title="Remove from library"
          onClick={() => {
            if (!window.confirm(`Remove "${item.name}" from the library? Cues using it will lose this media.`)) return;
            detachMedia(item.id);
            removeItem(item.id);
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function PdfProgress(): JSX.Element | null {
  const jobs = useMediaStore((s) => s.pdfJobs);
  const entries = Object.entries(jobs);
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 space-y-1" data-testid="pdf-progress">
      {entries.map(([key, job]) => (
        <div key={key} className="rounded-md border border-av-blue/40 bg-av-blue/5 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-av-text">
            <Loader2 size={12} className="shrink-0 animate-spin text-av-blue" />
            <span className="truncate">{key.startsWith('offline:') ? job.name : `Rendering ${job.name}`}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-av-muted">
              {key.startsWith('offline:') ? `${job.done} page${job.done === 1 ? '' : 's'}` : job.total > 0 ? `${job.done}/${job.total}` : '…'}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-av-raised">
            <div
              className="h-full bg-av-blue transition-[width]"
              style={{ width: `${job.total > 0 ? (job.done / job.total) * 100 : 5}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ago(at: number | null, now: number): string {
  if (!at) return 'not synced yet';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'synced just now';
  if (s < 60) return `synced ${s}s ago`;
  if (s < 3600) return `synced ${Math.floor(s / 60)}m ago`;
  return `synced ${Math.floor(s / 3600)}h ago`;
}

/** Google Drive folders: live sync status, progress, Sync now, open local copy, build cues. */
function DriveSources({ onBuildCues }: { onBuildCues: (folder: string) => void }): JSX.Element | null {
  const sources = useDriveStore((s) => s.sources);
  const status = useDriveStore((s) => s.status);
  const autoSync = useDriveStore((s) => s.autoSync);
  const syncSource = useDriveStore((s) => s.syncSource);
  const removeSource = useDriveStore((s) => s.removeSource);
  const items = useMediaStore((s) => s.items);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  if (sources.length === 0) return null;
  const platform = window.api.platform;

  return (
    <div className="mt-2 space-y-1" data-testid="drive-sources">
      {sources.map((source) => {
        const st = status[source.id];
        const prefix = `${mediaPathKey(source.localPath, platform).replace(/\/+$/, '')}/`;
        const count = items.filter((i) => mediaPathKey(sourcePathOf(i), platform).startsWith(prefix)).length;
        const progress = st?.progress;
        const downloading = st?.syncing && progress?.phase === 'downloading' && progress.total > 0;
        const line = st?.syncing
          ? progress?.phase === 'downloading' && progress.total > 0
            ? `Downloading ${progress.done}/${progress.total}${progress.current ? ` · ${progress.current}` : ''}`
            : 'Checking Drive…'
          : st?.error
            ? `⚠ ${st.error}`
            : `${count} file${count === 1 ? '' : 's'} · ${ago(st?.lastSyncAt ?? null, now)}${autoSync ? ' · auto' : ''}`;
        return (
          <div
            key={source.id}
            className={`rounded-md border bg-av-bg px-2 py-1 ${st?.error ? 'border-av-red/50' : 'border-av-blue/40'}`}
            title={`${source.url}\n→ ${source.localPath}`}
            data-testid="drive-source"
          >
            <div className="flex items-center gap-1.5">
              <Cloud size={13} className="shrink-0 text-av-blue" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-semibold text-av-text">{source.name}</div>
                <div
                  className={`truncate font-mono text-[10px] ${st?.error && !st.syncing ? 'text-av-red' : 'text-av-dim'}`}
                  data-testid="drive-status"
                >
                  {line}
                </div>
              </div>
              <button
                type="button"
                disabled={count === 0}
                onClick={() => onBuildCues(source.localPath)}
                className="inline-flex items-center gap-1 rounded border border-av-blue/40 px-1.5 py-0.5 text-[10px] font-semibold text-av-blue hover:bg-av-blue/10 disabled:opacity-40"
                aria-label={`Build cues from ${source.name}`}
              >
                <ListOrdered size={11} /> Cues
              </button>
              <button
                type="button"
                disabled={st?.syncing}
                onClick={() => void syncSource(source.id, 'manual')}
                className="rounded p-1 text-av-muted hover:bg-av-raised hover:text-av-text disabled:opacity-50"
                aria-label={`Sync ${source.name} now`}
                title="Sync now"
                data-testid="drive-sync-now"
              >
                <RefreshCw size={12} className={st?.syncing ? 'animate-spin' : ''} />
              </button>
              <button
                type="button"
                onClick={() => void window.api.invoke('drive:open-folder', source.localPath)}
                className="rounded p-1 text-av-dim hover:bg-av-raised hover:text-av-text"
                aria-label="Open the downloaded folder"
                title="Open the downloaded folder"
              >
                <FolderOpen size={12} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Stop syncing “${source.name}”? Downloaded tracks stay in the library.`)) removeSource(source.id);
                }}
                className="rounded p-1 text-av-dim hover:bg-av-raised hover:text-av-text"
                aria-label={`Stop syncing ${source.name}`}
                title="Stop syncing (keeps downloaded tracks)"
              >
                <X size={12} />
              </button>
            </div>
            {downloading && progress ? (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-av-raised">
                <div className="h-full bg-av-blue transition-[width]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function LinkedFolders({ onBuildCues }: { onBuildCues: (folder: string) => void }): JSX.Element | null {
  const allFolders = useMediaStore((s) => s.folders);
  const items = useMediaStore((s) => s.items);
  const scanning = useMediaStore((s) => s.scanningFolders);
  const rescanFolder = useMediaStore((s) => s.rescanFolder);
  const unlinkFolder = useMediaStore((s) => s.unlinkFolder);
  const driveSources = useDriveStore((s) => s.sources);
  const platform = window.api.platform;
  // Drive downloads are shown in their own rows.
  const drivePaths = new Set(driveSources.map((s) => mediaPathKey(s.localPath, platform)));
  const folders = allFolders.filter((f) => !drivePaths.has(mediaPathKey(f, platform)));

  if (folders.length === 0) return null;

  return (
    <div className="mt-2 space-y-1" data-testid="linked-folders">
      {folders.map((folder) => {
        const prefix = `${mediaPathKey(folder, platform).replace(/\/+$/, '')}/`;
        const inFolder = items.filter((i) => mediaPathKey(sourcePathOf(i), platform).startsWith(prefix));
        const missing = inFolder.filter((i) => i.missing).length;
        const busy = Boolean(scanning[folder]);
        return (
          <div
            key={folder}
            className="flex items-center gap-1.5 rounded-md border border-av-border bg-av-bg px-2 py-1"
            title={folder}
            data-testid="linked-folder"
          >
            <FolderOpen size={13} className="shrink-0 text-av-amber" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold text-av-text">{baseName(folder)}</div>
              <div className="font-mono text-[10px] text-av-dim">
                {inFolder.length} file{inFolder.length === 1 ? '' : 's'}
                {missing > 0 ? <span className="text-av-red"> · {missing} missing</span> : null}
              </div>
            </div>
            <button
              type="button"
              disabled={busy || inFolder.length === 0}
              onClick={() => onBuildCues(folder)}
              className="inline-flex items-center gap-1 rounded border border-av-blue/40 px-1.5 py-0.5 text-[10px] font-semibold text-av-blue hover:bg-av-blue/10 disabled:opacity-40"
              aria-label={`Build cues from ${baseName(folder)}`}
              title="Build the cue stack from this folder, in file-name order"
            >
              <ListOrdered size={11} /> Cues
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void rescanFolder(folder)}
              className="rounded p-1 text-av-muted hover:bg-av-raised hover:text-av-text disabled:opacity-50"
              aria-label={`Rescan ${baseName(folder)}`}
              title="Rescan: pick up new files and flag removed ones"
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => unlinkFolder(folder)}
              className="rounded p-1 text-av-dim hover:bg-av-raised hover:text-av-text"
              aria-label={`Unlink ${baseName(folder)}`}
              title="Unlink folder (imported media stays in the library)"
            >
              <Unlink size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function MediaLibrary(): JSX.Element {
  const items = useMediaStore((s) => s.items);
  const probing = useMediaStore((s) => s.probing);
  const importFromDialog = useMediaStore((s) => s.importFromDialog);
  const importFolderFromDialog = useMediaStore((s) => s.importFolderFromDialog);
  const importDroppedFiles = useMediaStore((s) => s.importDroppedFiles);
  const [bin, setBin] = useState<BinKey>('image');
  const [query, setQuery] = useState('');
  const [dropHover, setDropHover] = useState(false);
  const [buildFolder, setBuildFolder] = useState<string | null>(null);
  const [driveOpen, setDriveOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const newIds = useMediaStore((s) => s.newIds);
  const clearNew = useMediaStore((s) => s.clearNew);
  const binInfo = BINS.find((b) => b.key === bin) ?? BINS[0];

  const counts = useMemo(() => {
    const result: Record<BinKey, number> = { image: 0, video: 0, audio: 0, live: 0 };
    for (const item of items) result[binOf(item.type)] += 1;
    return result;
  }, [items]);

  const newCounts = useMemo(() => {
    const result: Record<BinKey, number> = { image: 0, video: 0, audio: 0, live: 0 };
    for (const item of items) if (newIds[item.id]) result[binOf(item.type)] += 1;
    return result;
  }, [items, newIds]);
  const totalNew = newCounts.image + newCounts.video + newCounts.audio + newCounts.live;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => binOf(i.type) === bin && (q === '' || i.name.toLowerCase().includes(q)));
  }, [items, bin, query]);

  return (
    <section
      className={`flex min-h-0 flex-col rounded-lg border bg-av-panel ${dropHover ? 'border-av-blue' : 'border-av-border'}`}
      data-testid="media-library"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropHover(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHover(false);
      }}
      onDrop={(event) => {
        setDropHover(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        markDropHandled(event);
        void importDroppedFiles(files);
      }}
    >
      <header className="border-b border-av-border px-2.5 py-2">
        <div className="flex items-center justify-between">
          <h3 className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.18em] text-av-text">Library</h3>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              icon={<Upload size={13} />}
              onClick={() => void importFromDialog(bin === 'live' ? ['image', 'video', 'audio'] : [bin])}
              title={`Import files into ${binInfo.label} (Ctrl+I imports any type)`}
            >
              Files
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<FolderPlus size={13} />}
              onClick={() => void importFolderFromDialog()}
              title="Import a whole event folder, including sub-folders (Ctrl+Shift+F)"
              data-testid="import-folder"
            >
              Folder
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Cloud size={13} />}
              onClick={() => setDriveOpen(true)}
              title="Download performer tracks from a Google Drive folder"
              data-testid="open-drive"
            >
              Drive
            </Button>
          </div>
        </div>
        <DriveSources onBuildCues={setBuildFolder} />
        <LinkedFolders onBuildCues={setBuildFolder} />
        <PdfProgress />
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-av-bg p-0.5" role="tablist">
          {BINS.map((b) => (
            <button
              key={b.key}
              type="button"
              role="tab"
              aria-selected={bin === b.key}
              onClick={() => setBin(b.key)}
              className={`flex min-w-0 items-center justify-center gap-1 rounded px-0.5 py-1 text-[11px] font-semibold ${
                bin === b.key ? 'bg-av-raised text-av-text' : 'text-av-muted hover:text-av-text'
              }`}
              title={b.label}
              data-testid={`bin-${b.key}`}
            >
              <span className="shrink-0">{b.icon}</span>
              <span className="truncate">{b.short}</span>
              <span className="font-mono text-[10px] text-av-dim">{counts[b.key]}</span>
              {newCounts[b.key] > 0 ? (
                <span className="rounded bg-av-green px-1 font-mono text-[9px] font-bold text-av-bg" title="New, not used yet">
                  +{newCounts[b.key]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {bin === 'live' ? (
          <div className="mt-2 grid grid-cols-2 gap-1">
            <Button size="sm" variant="primary" icon={<Globe size={13} />} onClick={() => setWebOpen(true)} data-testid="add-web-page">
              Web page
            </Button>
            <Button size="sm" variant="primary" icon={<AppWindow size={13} />} onClick={() => setCaptureOpen(true)} data-testid="add-capture">
              Window / screen
            </Button>
          </div>
        ) : null}
        {totalNew > 0 ? (
          <button
            type="button"
            onClick={() => clearNew()}
            className="mt-1 text-[10px] text-av-dim underline decoration-dotted hover:text-av-text"
          >
            Mark {totalNew} new item{totalNew === 1 ? '' : 's'} as seen
          </button>
        ) : null}
        <div className="relative mt-2">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-av-dim" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${binInfo.label.toLowerCase()}…`}
            className="h-7 w-full rounded-md border border-av-border bg-av-bg pl-7 pr-7 text-xs text-av-text placeholder:text-av-dim focus:border-av-blue focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-av-dim hover:text-av-text"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-av-dim">{binInfo.label}</p>
        {visible.length === 0 && bin === 'live' ? (
          <div className="rounded-md border border-dashed border-av-border px-3 py-6 text-center text-xs text-av-muted">
            <p>
              <strong className="text-av-text">Web page</strong>: an online flipbook or site, shown live on the projector and
              flipped from here.
            </p>
            <p className="mt-2">
              <strong className="text-av-text">Window / screen</strong>: show any app window live (a browser, Canva, a scoreboard…).
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-av-border px-3 py-8 text-center">
            <Upload size={22} className="text-av-dim" />
            <p className="text-xs text-av-muted">
              {query ? 'Nothing matches your search.' : 'Drop files or your whole event folder here.'}
            </p>
            {!query ? (
              <Button
                size="sm"
                variant="primary"
                icon={<FolderPlus size={13} />}
                onClick={() => void importFolderFromDialog()}
              >
                Import event folder
              </Button>
            ) : null}
            <p className="text-[11px] text-av-dim">
              {bin === 'image'
                ? 'PNG, JPG, WebP, GIF, SVG, PDF and PowerPoint (one backdrop per page/slide)'
                : bin === 'video'
                  ? 'MP4 (H.264), WebM, MOV'
                  : 'MP3, WAV, M4A, OGG, FLAC'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {visible.map((item) => (
              <MediaCard key={item.id} item={item} probing={Boolean(probing[item.id])} isNew={Boolean(newIds[item.id])} />
            ))}
          </div>
        )}
      </div>
      <BuildCuesModal folder={buildFolder} onClose={() => setBuildFolder(null)} />
      <DriveModal open={driveOpen} onClose={() => setDriveOpen(false)} />
      <AddWebPageModal open={webOpen} onClose={() => setWebOpen(false)} />
      <CapturePickerModal open={captureOpen} onClose={() => setCaptureOpen(false)} />
    </section>
  );
}
