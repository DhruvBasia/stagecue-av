import {
  ArrowLeft,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Home,
  Loader2,
  Maximize2,
  RotateCw,
  Volume2,
  VolumeX
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { MediaItem, WebInput } from '../../types';
import { describePaging, livePaging } from '../../services/paging';
import { useShowStore } from '../../store/useShowStore';
import { useStageStore } from '../../store/useStageStore';
import { useWebStore } from '../../store/useWebStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

/* Live page turning for the booklet on stage (PDF / slide deck / web page),
 * and the operator's remote view of an on-stage web page. */

const MOVE_INTERVAL_MS = 33;

function sendWeb(input: WebInput): void {
  window.api.send('web:input', input);
}

function reportTurn(result: { ok: boolean; message: string; atEnd: boolean }): void {
  if (!result.ok && result.atEnd) useShowStore.getState().pushAlert('info', result.message, '', false);
}

/** Where the picture actually sits inside an object-contain box (letterboxing excluded). */
function contentRect(el: HTMLImageElement): { left: number; top: number; width: number; height: number } {
  const box = el.getBoundingClientRect();
  const ratio = el.naturalWidth > 0 && el.naturalHeight > 0 ? el.naturalWidth / el.naturalHeight : box.width / box.height;
  let width = box.width;
  let height = width / ratio;
  if (height > box.height) {
    height = box.height;
    width = height * ratio;
  }
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * The live picture of the on-stage web page. Click, drag and scroll here and
 * it happens on the projector (the flipbook turns its pages for everyone).
 */
export function WebRemoteView({ media, large = false }: { media: MediaItem; large?: boolean }): JSX.Element {
  const frame = useWebStore((s) => s.frame);
  const image = useWebStore((s) => s.image);
  const imgRef = useRef<HTMLImageElement>(null);
  const down = useRef(false);
  const lastMove = useRef(0);
  const live = frame !== null && frame.mediaId === media.id;

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el) return null;
    const rect = contentRect(el);
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const p = point(event);
    if (!p) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    down.current = true;
    sendWeb({ type: 'pointer', phase: 'down', ...p });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!down.current) return;
    const now = performance.now();
    if (now - lastMove.current < MOVE_INTERVAL_MS) return;
    lastMove.current = now;
    const p = point(event);
    if (p) sendWeb({ type: 'pointer', phase: 'move', ...p });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!down.current) return;
    down.current = false;
    const el = imgRef.current;
    const rect = el ? contentRect(el) : null;
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    const p = rect
      ? { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
      : { x: 0.5, y: 0.5 };
    sendWeb({ type: 'pointer', phase: 'up', ...p });
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const p = point(event);
    if (p) sendWeb({ type: 'wheel', ...p, deltaY: event.deltaY });
  };

  return (
    <div
      className={`absolute inset-0 select-none ${live ? 'cursor-pointer' : ''}`}
      onPointerDown={live ? onPointerDown : undefined}
      onPointerMove={live ? onPointerMove : undefined}
      onPointerUp={live ? onPointerUp : undefined}
      onPointerCancel={live ? onPointerUp : undefined}
      onWheel={live ? onWheel : undefined}
      data-testid={large ? 'web-remote-large' : 'web-remote'}
      title={live ? 'Live web page: click, drag or scroll here to control it on the projector' : undefined}
    >
      {live && image ? (
        <img ref={imgRef} src={image} alt="" draggable={false} className="monitor-media pointer-events-none" data-testid="web-remote-image" />
      ) : media.thumbnailUrl ? (
        <img src={media.thumbnailUrl} alt="" draggable={false} className="monitor-media pointer-events-none opacity-60" />
      ) : null}
      {!live || frame.loading ? (
        <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-av-muted">
          <Loader2 size={11} className="animate-spin" /> {live ? 'Loading…' : 'Connecting to the stage page…'}
        </span>
      ) : null}
    </div>
  );
}

function PdfPageControls({ item }: { item: MediaItem }): JSX.Element {
  const turnPage = useStageStore((s) => s.turnPage);
  const goToPage = useStageStore((s) => s.goToPage);
  const paging = livePaging(item, null);
  const page = item.pdf?.page ?? 1;
  const count = item.pdf?.pageCount ?? 1;
  const slides = Boolean(item.pdf?.originalPath);
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);

  const jump = (): void => {
    const n = Number(draft);
    if (Number.isInteger(n) && n >= 1 && n <= count) reportTurn(goToPage(n));
    else setDraft(String(page));
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="page-controls" data-kind="pdf">
      <Button size="sm" variant="secondary" icon={<ChevronFirst size={15} />} disabled={page <= 1} onClick={() => reportTurn(goToPage(1))} aria-label="First page" title="First page" />
      <Button
        size="sm"
        variant="secondary"
        icon={<ChevronLeft size={16} />}
        disabled={page <= 1}
        onClick={() => reportTurn(turnPage(-1))}
        aria-label="Previous page"
        title="Previous page ( [ or clicker back )"
        data-testid="page-prev"
      />
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs text-av-muted">
        <span>{slides ? 'Slide' : 'Page'}</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
          onBlur={jump}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              jump();
              event.currentTarget.blur();
            }
          }}
          aria-label="Go to page"
          className="h-7 w-11 rounded border border-av-border bg-av-bg text-center font-mono text-sm font-bold text-av-text focus:border-av-blue focus:outline-none"
          data-testid="page-number"
        />
        <span className="font-mono">/ {count}</span>
      </div>
      <Button
        size="sm"
        variant="primary"
        icon={<ChevronRight size={16} />}
        disabled={page >= count}
        onClick={() => reportTurn(turnPage(1))}
        aria-label="Next page"
        title="Next page ( ] or clicker forward )"
        data-testid="page-next"
      >
        Next
      </Button>
      <Button size="sm" variant="secondary" icon={<ChevronLast size={15} />} disabled={page >= count} onClick={() => reportTurn(goToPage(count))} aria-label="Last page" title="Last page" />
      <span className="sr-only" data-testid="page-label">
        {describePaging(paging, slides)}
      </span>
    </div>
  );
}

function WebPageControls({ item }: { item: MediaItem }): JSX.Element {
  const frame = useWebStore((s) => s.frame);
  const [big, setBig] = useState(false);
  const live = frame !== null && frame.mediaId === item.id;
  const paging = livePaging(item, live ? frame.url : null);
  let host = '';
  try {
    host = new URL(live ? frame.url : item.web?.url ?? item.fileUrl).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }

  return (
    <div className="space-y-1.5" data-testid="page-controls" data-kind="web">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" icon={<ChevronLeft size={16} />} disabled={!live} onClick={() => sendWeb({ type: 'key', key: 'ArrowLeft' })} aria-label="Previous page" title="Previous page (← key sent to the page)" data-testid="page-prev" />
        <Button size="sm" variant="primary" icon={<ChevronRight size={16} />} disabled={!live} onClick={() => sendWeb({ type: 'key', key: 'ArrowRight' })} aria-label="Next page" title="Next page (→ key sent to the page)" data-testid="page-next">
          Next
        </Button>
        <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[11px] text-av-muted" title={live ? frame.url : item.web?.url} data-testid="page-label">
          {describePaging(paging) || host}
          {live && frame.title ? <span className="text-av-dim"> · {frame.title}</span> : null}
        </span>
        <Button size="xs" variant="ghost" icon={<ArrowLeft size={13} />} disabled={!live || !frame.canGoBack} onClick={() => sendWeb({ type: 'nav', action: 'back' })} aria-label="Back" title="Back (previous address)" />
        <Button size="xs" variant="ghost" icon={<Home size={13} />} disabled={!live} onClick={() => sendWeb({ type: 'nav', action: 'home' })} aria-label="Start again" title="Back to the cue's start address" />
        <Button size="xs" variant="ghost" icon={<RotateCw size={13} />} disabled={!live} onClick={() => sendWeb({ type: 'nav', action: 'reload' })} aria-label="Reload page" title="Reload" />
        <Button
          size="xs"
          variant="ghost"
          icon={live && !frame.muted ? <Volume2 size={13} /> : <VolumeX size={13} />}
          disabled={!live}
          onClick={() => live && sendWeb({ type: 'mute', muted: !frame.muted })}
          aria-label={live && !frame.muted ? 'Mute page sound' : 'Allow page sound'}
          title={live && !frame.muted ? 'Page sound is ON (plays on the Windows default output)' : 'Page sound is muted'}
        />
        <Button size="xs" variant="ghost" icon={<Maximize2 size={13} />} onClick={() => setBig(true)} aria-label="Bigger view" title="Bigger live view" data-testid="web-big" />
      </div>
      <Modal open={big} title={`Live on the projector · ${item.name}`} onClose={() => setBig(false)} width="lg" testId="web-big-modal">
        <div className="relative aspect-video w-full overflow-hidden rounded-md border-2 border-av-red/60 bg-black">
          <WebRemoteView media={item} large />
        </div>
        <div className="mt-3">
          <WebPageControlsBar live={live} />
        </div>
      </Modal>
    </div>
  );
}

/** Compact page buttons for the big view. */
function WebPageControlsBar({ live }: { live: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2">
      <Button variant="secondary" icon={<ChevronLeft size={18} />} disabled={!live} onClick={() => sendWeb({ type: 'key', key: 'ArrowLeft' })}>
        Previous page
      </Button>
      <Button variant="primary" icon={<ChevronRight size={18} />} disabled={!live} onClick={() => sendWeb({ type: 'key', key: 'ArrowRight' })}>
        Next page
      </Button>
      <span className="text-xs text-av-dim">Click or drag the picture to use the page directly.</span>
    </div>
  );
}

/** Shown under the Program monitor while a booklet is live. */
export function PageControls({ item }: { item: MediaItem }): JSX.Element | null {
  if (item.pdf) return <PdfPageControls item={item} />;
  if (item.type === 'web') return <WebPageControls item={item} />;
  return null;
}
