import {
  ChevronDown,
  ChevronUp,
  Copy,
  Film,
  ImageIcon,
  ListPlus,
  Music,
  Pencil,
  Repeat2,
  SkipBack,
  SkipForward,
  StickyNote,
  Trash2,
  Zap
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { CueItem, MediaItem } from '../../types';
import { sortCues } from '../../services/cueManager';
import { describeFollow, followSecondsLeft } from '../../services/followEngine';
import { markDropHandled } from '../../services/operatorBridge';
import { useMediaStore } from '../../store/useMediaStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { CueEditor } from './CueEditor';

export const MEDIA_DRAG_TYPE = 'application/x-stagecue-media';

function hasMediaDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(MEDIA_DRAG_TYPE);
}

function MediaChip({ media, icon, tone }: { media: MediaItem | null; icon: JSX.Element; tone: string }): JSX.Element | null {
  if (!media) return null;
  return (
    <span
      className={`inline-flex max-w-[180px] items-center gap-1 truncate rounded border px-1.5 py-px text-[11px] ${
        media.missing ? 'border-av-red/50 text-av-red' : tone
      }`}
      title={media.missing ? `${media.name} (missing)` : media.name}
    >
      {icon}
      <span className="truncate">{media.name}</span>
    </span>
  );
}

/**
 * 16:9 cue preview: the backdrop fills the frame and a cue video sits as a
 * picture-in-picture. A video-only cue shows the video full-frame; a music-only
 * cue shows a note.
 */
function CueThumb({
  backdrop,
  foreground,
  audio,
  isLive
}: {
  backdrop: MediaItem | null;
  foreground: MediaItem | null;
  audio: MediaItem | null;
  isLive: boolean;
}): JSX.Element {
  const main = backdrop ?? foreground;
  const pip = backdrop && foreground ? foreground : null;
  return (
    <div
      className={`relative aspect-video w-[88px] shrink-0 self-center overflow-hidden rounded border bg-black ${
        isLive ? 'border-av-red/70' : 'border-av-border'
      }`}
      data-testid="cue-thumb"
    >
      {main && main.thumbnailUrl ? (
        <img src={main.thumbnailUrl} alt="" draggable={false} className="h-full w-full object-contain" />
      ) : main ? (
        <div className="flex h-full w-full items-center justify-center text-av-dim">
          {main.type === 'video' ? <Film size={16} /> : <ImageIcon size={16} />}
        </div>
      ) : audio ? (
        <div className="flex h-full w-full items-center justify-center bg-av-green/10 text-av-green">
          <Music size={16} />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[9px] text-av-dim">empty</div>
      )}
      {pip ? (
        <div className="absolute bottom-0.5 right-0.5 aspect-video w-[44%] overflow-hidden rounded-sm border border-av-blue/70 bg-black">
          {pip.thumbnailUrl ? (
            <img src={pip.thumbnailUrl} alt="" draggable={false} className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-av-blue">
              <Film size={10} />
            </div>
          )}
        </div>
      ) : null}
      {foreground && !pip ? (
        <span className="absolute left-0.5 top-0.5 rounded-sm bg-av-blue/90 p-px text-av-bg">
          <Film size={9} />
        </span>
      ) : null}
      {audio && main ? (
        <span className="absolute left-0.5 bottom-0.5 rounded-sm bg-av-green/90 p-px text-av-bg">
          <Music size={9} />
        </span>
      ) : null}
    </div>
  );
}

interface CueRowProps {
  cue: CueItem;
  isSelected: boolean;
  isLive: boolean;
  lookup: (id: string | undefined) => MediaItem | null;
  onEdit: () => void;
  followText: string | null;
  followEnabled: boolean;
}

function CueRow({ cue, isSelected, isLive, lookup, onEdit, followText, followEnabled }: CueRowProps): JSX.Element {
  const selectCue = useStageStore((s) => s.selectCue);
  const takeCue = useStageStore((s) => s.takeCue);
  const moveCue = useStageStore((s) => s.moveCue);
  const duplicateCue = useStageStore((s) => s.duplicateCue);
  const removeCue = useStageStore((s) => s.removeCue);
  const assignMediaToCue = useStageStore((s) => s.assignMediaToCue);
  const [dropHover, setDropHover] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSelected]);

  const backdrop = lookup(cue.backdropMediaId);
  const foreground = lookup(cue.foregroundMediaId);
  const audio = lookup(cue.audioMediaId);

  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={isSelected}
      data-testid="cue-row"
      data-cue-id={cue.id}
      data-live={isLive ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      onClick={() => selectCue(cue.id)}
      onDoubleClick={onEdit}
      onDragOver={(event) => {
        if (!hasMediaDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'link';
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(event) => {
        setDropHover(false);
        const id = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        markDropHandled(event);
        const media = useMediaStore.getState().getById(id);
        if (media) assignMediaToCue(cue.id, media);
      }}
      className={[
        'group relative flex cursor-pointer items-stretch gap-2 rounded-md border px-2 py-1.5 transition-colors',
        isLive ? 'border-av-red/60 bg-av-red/10' : isSelected ? 'border-av-green/70 bg-av-green/10' : 'border-transparent hover:bg-av-raised',
        dropHover ? 'ring-2 ring-av-blue' : ''
      ].join(' ')}
    >
      <div className="flex w-10 shrink-0 flex-col items-center justify-center">
        <span className={`font-mono text-sm font-bold ${isLive ? 'text-av-red' : isSelected ? 'text-av-green' : 'text-av-muted'}`}>
          {cue.order}
        </span>
        {isLive ? (
          <span className="text-[9px] font-black tracking-widest text-av-red">LIVE</span>
        ) : isSelected ? (
          <span className="text-[9px] font-black tracking-widest text-av-green">NEXT</span>
        ) : null}
      </div>

      <CueThumb backdrop={backdrop} foreground={foreground} audio={audio} isLive={isLive} />

      <div className="min-w-0 flex-1 self-center">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-av-text">{cue.label}</span>
          <span className="shrink-0 rounded bg-av-bg px-1 font-mono text-[10px] uppercase text-av-muted">
            {cue.transition}
            {cue.transition !== 'cut' ? ` ${(cue.transitionDurationMs / 1000).toFixed(1)}s` : ''}
          </span>
          {followText ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded px-1 font-mono text-[10px] ${
                followEnabled ? 'bg-av-amber/15 text-av-amber' : 'bg-av-bg text-av-dim line-through'
              }`}
              title={followEnabled ? 'Auto-follow rule' : 'Auto-follow is switched OFF'}
              data-testid="follow-badge"
            >
              <Repeat2 size={10} />
              {followText.replace('→ ', '')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <MediaChip media={backdrop} icon={<ImageIcon size={11} />} tone="border-av-border text-av-muted" />
          <MediaChip media={foreground} icon={<Film size={11} />} tone="border-av-blue/40 text-av-blue" />
          <MediaChip media={audio} icon={<Music size={11} />} tone="border-av-green/40 text-av-green" />
          {!backdrop && !foreground && !audio ? (
            <span className="text-[11px] italic text-av-dim">Empty cue — drop media here or edit</span>
          ) : null}
          {cue.notes ? (
            <span className="inline-flex max-w-[260px] items-center gap-1 truncate text-[11px] text-av-amber" title={cue.notes}>
              <StickyNote size={11} />
              <span className="truncate">{cue.notes}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div
        className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Button size="xs" variant="success" icon={<Zap size={12} />} onClick={() => takeCue(cue.id)} title="Take this cue now">
          Take
        </Button>
        <Button size="xs" variant="ghost" icon={<Pencil size={12} />} onClick={onEdit} aria-label="Edit cue" title="Edit" />
        <Button size="xs" variant="ghost" icon={<ChevronUp size={12} />} onClick={() => moveCue(cue.id, -1)} aria-label="Move up" title="Move up" />
        <Button size="xs" variant="ghost" icon={<ChevronDown size={12} />} onClick={() => moveCue(cue.id, 1)} aria-label="Move down" title="Move down" />
        <Button size="xs" variant="ghost" icon={<Copy size={12} />} onClick={() => duplicateCue(cue.id)} aria-label="Duplicate" title="Duplicate" />
        <Button
          size="xs"
          variant="ghost"
          icon={<Trash2 size={12} />}
          onClick={() => {
            if (window.confirm(`Delete cue "${cue.label}"?`)) removeCue(cue.id);
          }}
          aria-label="Delete cue"
          title="Delete"
        />
      </div>
    </div>
  );
}

/** Live "next in 6s" / "after video" readout for the pending auto-follow. */
export function FollowCountdown(): JSX.Element | null {
  const pending = useStageStore((s) => s.pendingFollow);
  const cues = useStageStore((s) => s.cues);
  const program = useStageStore((s) => s.program);
  const enabled = useStageStore((s) => s.autoFollowEnabled);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);
  if (!pending) return null;
  const target = cues.find((c) => c.id === pending.targetCueId);
  const seconds = followSecondsLeft(pending, now);
  const paused = !enabled ? 'off' : program.isFrozen ? 'frozen' : program.isBlackout ? 'blackout' : null;
  const when = pending.mode === 'on-end' ? 'after video' : `in ${Math.ceil(seconds ?? 0)}s`;
  return (
    <span className="rounded bg-black/30 px-1 font-mono text-[10px] font-semibold" data-testid="follow-countdown">
      → {target ? target.order : '?'} {when}
      {paused ? ` (${paused === 'off' ? 'off' : `paused: ${paused}`})` : ''}
    </span>
  );
}

export function CueList(): JSX.Element {
  const cues = useStageStore((s) => s.cues);
  const selectedCueId = useStageStore((s) => s.selectedCueId);
  const liveCueId = useStageStore((s) => s.program.liveCueId);
  const addCue = useStageStore((s) => s.addCue);
  const addMediaAsCue = useStageStore((s) => s.addMediaAsCue);
  const takeSelected = useStageStore((s) => s.takeSelected);
  const selectNext = useStageStore((s) => s.selectNext);
  const selectPrev = useStageStore((s) => s.selectPrev);
  const items = useMediaStore((s) => s.items);
  const autoFollowEnabled = useStageStore((s) => s.autoFollowEnabled);
  const toggleAutoFollow = useStageStore((s) => s.toggleAutoFollow);
  const pendingFollow = useStageStore((s) => s.pendingFollow);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const hasFollowRules = cues.some((c) => (c.followMode ?? 'off') !== 'off');

  const ordered = useMemo(() => sortCues(cues), [cues]);
  const lookup = useMemo(() => {
    const map = new Map(items.map((i) => [i.id, i] as const));
    return (id: string | undefined): MediaItem | null => (id ? map.get(id) ?? null : null);
  }, [items]);
  const selected = ordered.find((c) => c.id === selectedCueId) ?? null;

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-av-border bg-av-panel" data-testid="cue-list">
      <header className="flex items-center gap-2 border-b border-av-border px-2.5 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-av-text">Cue Stack</h3>
        <span className="font-mono text-[11px] text-av-muted">{ordered.length} cues</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={autoFollowEnabled}
            onClick={toggleAutoFollow}
            data-testid="auto-follow-toggle"
            data-state={autoFollowEnabled ? 'on' : 'off'}
            title="Master switch for every cue's auto-follow rule"
            className={`mr-1 inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-bold tracking-wider ${
              autoFollowEnabled
                ? 'border-av-amber/60 bg-av-amber/10 text-av-amber'
                : 'border-av-border bg-av-bg text-av-dim'
            } ${hasFollowRules ? '' : 'opacity-60'}`}
          >
            <Repeat2 size={13} />
            AUTO-FOLLOW {autoFollowEnabled ? 'ON' : 'OFF'}
            {pendingFollow ? <FollowCountdown /> : null}
          </button>
          <Button size="sm" variant="ghost" icon={<SkipBack size={14} />} onClick={selectPrev} title="Previous cue (↑)" aria-label="Previous cue" />
          <Button size="sm" variant="ghost" icon={<SkipForward size={14} />} onClick={selectNext} title="Next cue (↓)" aria-label="Next cue" />
          <Button
            size="sm"
            variant="secondary"
            icon={<ListPlus size={14} />}
            onClick={() => setEditingId(addCue())}
            data-testid="add-cue"
          >
            Add cue
          </Button>
          <Button
            size="md"
            variant="success"
            active={selected !== null}
            disabled={!selected}
            icon={<Zap size={16} />}
            onClick={() => takeSelected()}
            className="min-w-[150px] font-black tracking-wider"
            title="Take the highlighted cue (Space)"
            data-testid="take-button"
          >
            {selected ? `TAKE ${selected.order}` : 'TAKE'}
            <span className="ml-1.5 rounded bg-black/25 px-1 font-mono text-[10px] font-bold">SPACE</span>
          </Button>
        </div>
      </header>

      <div
        role="grid"
        aria-label="Cue stack"
        className={`min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5 ${dropHover ? 'bg-av-blue/5' : ''}`}
        onDragOver={(event) => {
          if (!hasMediaDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropHover(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropHover(false);
        }}
        onDrop={(event) => {
          setDropHover(false);
          const id = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
          if (!id) return;
          event.preventDefault();
          markDropHandled(event);
          const media = useMediaStore.getState().getById(id);
          if (media) addMediaAsCue(media);
        }}
      >
        {ordered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <ListPlus size={28} className="text-av-dim" />
            <p className="text-sm text-av-muted">No cues yet.</p>
            <p className="max-w-sm text-xs text-av-dim">
              Drag posters, videos or tracks here from the library to build the running order, or press “Add cue”.
            </p>
          </div>
        ) : (
          ordered.map((cue) => (
            <CueRow
              key={cue.id}
              cue={cue}
              isSelected={cue.id === selectedCueId}
              isLive={cue.id === liveCueId}
              lookup={lookup}
              onEdit={() => setEditingId(cue.id)}
              followText={describeFollow(cue, ordered)}
              followEnabled={autoFollowEnabled}
            />
          ))
        )}
      </div>

      <CueEditor cueId={editingId} onClose={() => setEditingId(null)} />
    </section>
  );
}
