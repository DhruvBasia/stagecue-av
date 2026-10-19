import { Film, ImageIcon, ListOrdered, Music } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TransitionType } from '../../types';
import {
  buildCuesFromMedia,
  DEFAULT_BUILD_OPTIONS,
  mediaInFolder,
  type BuildCuesOptions
} from '../../services/cueBuilder';
import { baseName, createId } from '../../services/utils';
import { useMediaStore } from '../../store/useMediaStore';
import { useShowStore } from '../../store/useShowStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

export interface BuildCuesModalProps {
  folder: string | null;
  onClose: () => void;
}

const PREVIEW_LIMIT = 12;

function Check({
  checked,
  onChange,
  icon,
  label,
  count
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  icon: JSX.Element;
  label: string;
  count: number;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-av-border bg-av-bg px-2.5 py-2 hover:border-av-muted/60">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-sky-400" />
      {icon}
      <span className="flex-1 text-xs text-av-text">{label}</span>
      <span className="font-mono text-[11px] text-av-muted">{count}</span>
    </label>
  );
}

export function BuildCuesModal({ folder, onClose }: BuildCuesModalProps): JSX.Element | null {
  const items = useMediaStore((s) => s.items);
  const cues = useStageStore((s) => s.cues);
  const addCues = useStageStore((s) => s.addCues);
  const [options, setOptions] = useState<BuildCuesOptions>(DEFAULT_BUILD_OPTIONS);
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  const inFolder = useMemo(
    () => (folder ? mediaInFolder(items, folder, window.api.platform) : []),
    [items, folder]
  );
  const counts = useMemo(
    () => ({
      image: inFolder.filter((i) => i.type === 'image' && !i.missing).length,
      video: inFolder.filter((i) => i.type === 'video' && !i.missing).length,
      audio: inFolder.filter((i) => i.type === 'audio' && !i.missing).length
    }),
    [inFolder]
  );
  const preview = useMemo(() => {
    let n = 0;
    return buildCuesFromMedia(inFolder, mode === 'replace' ? [] : cues, options, () => `preview-${(n += 1)}`);
  }, [inFolder, cues, options, mode]);

  if (!folder) return null;

  const patch = (changes: Partial<BuildCuesOptions>): void => setOptions((prev) => ({ ...prev, ...changes }));

  const create = (): void => {
    if (mode === 'replace' && cues.length > 0 && !window.confirm(`Replace all ${cues.length} existing cues?`)) return;
    const built = buildCuesFromMedia(inFolder, mode === 'replace' ? [] : cues, options, () => createId('cue'));
    addCues(built, mode);
    useShowStore
      .getState()
      .pushAlert('success', 'Cues created', `${built.length} cue(s) built from “${baseName(folder)}”.`, false);
    onClose();
  };

  return (
    <Modal
      open
      title={`Build cues from “${baseName(folder)}”`}
      onClose={onClose}
      width="md"
      testId="build-cues-modal"
      footer={
        <>
          <span className="mr-auto text-xs text-av-muted">
            {preview.length} cue{preview.length === 1 ? '' : 's'} will be {mode === 'replace' ? 'created' : 'appended'}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            active
            disabled={preview.length === 0}
            onClick={create}
            data-testid="build-cues-confirm"
          >
            Create {preview.length} cue{preview.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-av-muted">Include</p>
          <Check
            checked={options.includeImages}
            onChange={(v) => patch({ includeImages: v })}
            icon={<ImageIcon size={14} className="text-av-muted" />}
            label="Backdrops & PDF pages"
            count={counts.image}
          />
          <Check
            checked={options.includeVideos}
            onChange={(v) => patch({ includeVideos: v })}
            icon={<Film size={14} className="text-av-blue" />}
            label="Videos (play over the backdrop)"
            count={counts.video}
          />
          <Check
            checked={options.includeAudio}
            onChange={(v) => patch({ includeAudio: v })}
            icon={<Music size={14} className="text-av-green" />}
            label="Tracks (as music cues)"
            count={counts.audio}
          />
          <label className="flex cursor-pointer items-center gap-2 px-1 pt-1 text-xs text-av-muted">
            <input
              type="checkbox"
              checked={options.skipUsed}
              onChange={(e) => patch({ skipUsed: e.target.checked })}
              className="h-4 w-4 accent-sky-400"
            />
            Skip files already used in a cue
          </label>

          <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-av-muted">Transition</p>
          <div className="flex gap-1 rounded-md border border-av-border bg-av-bg p-1">
            {(['cut', 'dissolve', 'fade'] as TransitionType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => patch({ transition: t })}
                className={`flex-1 rounded px-2 py-1.5 text-xs font-semibold capitalize ${
                  options.transition === t ? 'bg-av-blue text-av-bg' : 'text-av-muted hover:bg-av-raised hover:text-av-text'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-av-muted">Slideshow</p>
          <div className="space-y-1.5 rounded-md border border-av-border bg-av-bg p-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-av-text">
              <input
                type="checkbox"
                checked={options.slideshow}
                onChange={(e) => patch({ slideshow: e.target.checked })}
                className="h-4 w-4 accent-amber-400"
                data-testid="build-slideshow"
              />
              Auto-advance (sponsor loop / poster reel)
            </label>
            {options.slideshow ? (
              <div className="space-y-1.5 pl-6 text-xs text-av-muted">
                <label className="flex items-center gap-1.5">
                  Each poster for
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={options.slideshowSeconds}
                    onChange={(e) => patch({ slideshowSeconds: Math.max(1, Number(e.target.value) || 1) })}
                    className="h-7 w-16 rounded border border-av-border bg-av-panel px-2 text-av-text"
                    aria-label="Seconds per poster"
                  />
                  s · videos play to the end
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={options.slideshowLoop}
                    onChange={(e) => patch({ slideshowLoop: e.target.checked })}
                    className="h-4 w-4 accent-amber-400"
                  />
                  Loop back to the first slide
                </label>
              </div>
            ) : null}
          </div>

          <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-av-muted">Cue stack</p>
          <div className="flex gap-1 rounded-md border border-av-border bg-av-bg p-1">
            {(
              [
                ['append', 'Append to existing'],
                ['replace', 'Replace all cues']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`flex-1 rounded px-2 py-1.5 text-xs font-semibold ${
                  mode === value
                    ? value === 'replace'
                      ? 'bg-av-amber text-av-bg'
                      : 'bg-av-blue text-av-bg'
                    : 'text-av-muted hover:bg-av-raised hover:text-av-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-av-muted">
            <ListOrdered size={13} /> Running order (from file names)
          </p>
          <ol className="max-h-[320px] space-y-1 overflow-y-auto rounded-md border border-av-border bg-av-bg p-2">
            {preview.length === 0 ? (
              <li className="py-6 text-center text-xs text-av-dim">Nothing to add with these settings.</li>
            ) : (
              preview.slice(0, PREVIEW_LIMIT).map((cue, index) => (
                <li key={cue.id} className="flex items-center gap-2 text-xs">
                  <span className="w-6 text-right font-mono text-av-dim">{index + 1}</span>
                  {cue.foregroundMediaId ? (
                    <Film size={12} className="shrink-0 text-av-blue" />
                  ) : cue.audioMediaId ? (
                    <Music size={12} className="shrink-0 text-av-green" />
                  ) : (
                    <ImageIcon size={12} className="shrink-0 text-av-muted" />
                  )}
                  <span className="truncate text-av-text">{cue.label}</span>
                </li>
              ))
            )}
            {preview.length > PREVIEW_LIMIT ? (
              <li className="pt-1 text-center text-[11px] text-av-dim">…and {preview.length - PREVIEW_LIMIT} more</li>
            ) : null}
          </ol>
          <p className="mt-2 text-[11px] text-av-dim">
            Tip: number your files (01, 02, 03…) to control the order. You can reorder and edit cues afterwards.
          </p>
        </div>
      </div>
    </Modal>
  );
}
