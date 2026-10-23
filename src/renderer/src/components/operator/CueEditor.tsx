import { Film, ImageIcon, Music, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CueItem, FollowMode, MediaItem, TransitionType } from '../../types';
import { clampTransitionDuration } from '../../services/cueManager';
import { formatPercent } from '../../services/utils';
import { useMediaStore } from '../../store/useMediaStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Slider } from '../common/Slider';

export interface CueEditorProps {
  cueId: string | null;
  onClose: () => void;
}

const FOLLOW_OPTIONS: Array<{ value: FollowMode; label: string; hint: string }> = [
  { value: 'off', label: 'Manual', hint: 'Wait for the operator' },
  { value: 'on-end', label: 'When video ends', hint: 'Take the next cue as soon as this video finishes' },
  { value: 'after-delay', label: 'After a delay', hint: 'Take the next cue after N seconds' }
];

const TRANSITIONS: Array<{ value: TransitionType; label: string; hint: string }> = [
  { value: 'cut', label: 'Cut', hint: 'Instant switch' },
  { value: 'dissolve', label: 'Dissolve', hint: 'Cross-dissolve from the current picture' },
  { value: 'fade', label: 'Fade', hint: 'Fade through black' }
];

function Field({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-av-muted">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-av-border bg-av-bg px-2.5 py-2 hover:border-av-muted/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-sky-400"
      />
      <span>
        <span className="block text-xs font-medium text-av-text">{label}</span>
        <span className="block text-[11px] text-av-muted">{hint}</span>
      </span>
    </label>
  );
}

function MediaSelect({
  value,
  options,
  emptyLabel,
  onChange
}: {
  value: string | undefined;
  options: MediaItem[];
  emptyLabel: string;
  onChange: (id: string | undefined) => void;
}): JSX.Element {
  return (
    <select
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      className="h-9 w-full rounded-md border border-av-border bg-av-bg px-2 text-sm text-av-text focus:border-av-blue focus:outline-none"
    >
      <option value="">{emptyLabel}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id} disabled={m.missing}>
          {m.name}
          {m.type === 'video' && options.some((o) => o.type === 'image') ? ' (video loop)' : ''}
          {m.type === 'web' ? ' (web page)' : ''}
          {m.type === 'screen' ? ' (live window)' : ''}
          {m.pdf ? ` (${m.pdf.originalPath ? 'slide' : 'page'} ${m.pdf.page}/${m.pdf.pageCount})` : ''}
          {m.missing ? ' — missing' : ''}
        </option>
      ))}
    </select>
  );
}

export function CueEditor({ cueId, onClose }: CueEditorProps): JSX.Element | null {
  const cue = useStageStore((s) => (cueId ? s.cues.find((c) => c.id === cueId) ?? null : null));
  const updateCue = useStageStore((s) => s.updateCue);
  const removeCue = useStageStore((s) => s.removeCue);
  const cues = useStageStore((s) => s.cues);
  const allCues = useMemo(() => [...cues].sort((a, b) => a.order - b.order), [cues]);
  const items = useMediaStore((s) => s.items);
  const [draft, setDraft] = useState<CueItem | null>(cue);

  useEffect(() => {
    setDraft(cue);
    // Re-seed only when a different cue is opened.
  }, [cueId]);

  const backdrops = useMemo(
    () => items.filter((m) => m.type === 'image' || m.type === 'video' || m.type === 'web' || m.type === 'screen'),
    [items]
  );
  const videos = useMemo(() => items.filter((m) => m.type === 'video'), [items]);
  const tracks = useMemo(() => items.filter((m) => m.type === 'audio'), [items]);

  if (!cueId || !draft) return null;

  const patch = (changes: Partial<CueItem>): void => setDraft((prev) => (prev ? { ...prev, ...changes } : prev));

  const save = (): void => {
    updateCue(draft.id, {
      ...draft,
      label: draft.label.trim() || `Cue ${draft.order}`,
      transitionDurationMs: clampTransitionDuration(draft.transition, draft.transitionDurationMs),
      notes: draft.notes?.trim() ? draft.notes.trim() : undefined,
      caption: draft.caption?.title.trim()
        ? { title: draft.caption.title.trim(), subtitle: draft.caption.subtitle.trim() }
        : undefined
    });
    onClose();
  };

  return (
    <Modal
      open
      title={`Edit cue ${draft.order}`}
      onClose={onClose}
      width="md"
      testId="cue-editor"
      footer={
        <>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={14} />}
            className="mr-auto"
            onClick={() => {
              if (window.confirm(`Delete cue "${draft.label}"?`)) {
                removeCue(draft.id);
                onClose();
              }
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" active onClick={save} data-testid="cue-editor-save">
            Save cue
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Label">
          <input
            value={draft.label}
            onChange={(event) => patch({ label: event.target.value })}
            className="h-9 w-full rounded-md border border-av-border bg-av-bg px-2.5 text-sm text-av-text focus:border-av-blue focus:outline-none"
            placeholder="e.g. Welcome poster + walk-in music"
            maxLength={120}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Backdrop" icon={<ImageIcon size={12} />}>
            <MediaSelect
              value={draft.backdropMediaId}
              options={backdrops}
              emptyLabel="— Keep current backdrop —"
              onChange={(id) => patch({ backdropMediaId: id })}
            />
          </Field>
          <Field label="Foreground video" icon={<Film size={12} />}>
            <MediaSelect
              value={draft.foregroundMediaId}
              options={videos}
              emptyLabel="— None (show backdrop) —"
              onChange={(id) => patch({ foregroundMediaId: id })}
            />
          </Field>
          <Field label="Background track" icon={<Music size={12} />}>
            <MediaSelect
              value={draft.audioMediaId}
              options={tracks}
              emptyLabel="— Keep current music —"
              onChange={(id) => patch({ audioMediaId: id })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Transition">
            <div className="flex gap-1 rounded-md border border-av-border bg-av-bg p-1">
              {TRANSITIONS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  title={t.hint}
                  onClick={() => patch({ transition: t.value })}
                  className={`flex-1 rounded px-2 py-1.5 text-xs font-semibold ${
                    draft.transition === t.value ? 'bg-av-blue text-av-bg' : 'text-av-muted hover:bg-av-raised hover:text-av-text'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Transition duration">
            <Slider
              value={draft.transition === 'cut' ? 0 : draft.transitionDurationMs}
              min={0}
              max={5000}
              step={50}
              disabled={draft.transition === 'cut'}
              onChange={(v) => patch({ transitionDurationMs: v })}
              format={(v) => `${(v / 1000).toFixed(2)} s`}
              defaultValue={800}
            />
          </Field>
        </div>

        <Field label="Music level for this cue">
          <Slider
            value={draft.audioVolume}
            onChange={(v) => patch({ audioVolume: v })}
            format={formatPercent}
            accent="green"
            defaultValue={0.8}
            disabled={!draft.audioMediaId}
          />
        </Field>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Toggle
            checked={draft.autoPlayForeground}
            onChange={(v) => patch({ autoPlayForeground: v })}
            label="Auto-play video on TAKE"
            hint="Off: the video waits on its first frame until you press Play."
          />
          <Toggle
            checked={draft.duckAudioOnVideo}
            onChange={(v) => patch({ duckAudioOnVideo: v })}
            label="Duck music under video"
            hint="Lowers background music while this cue's video plays."
          />
          <Toggle
            checked={draft.loopBackdrop}
            onChange={(v) => patch({ loopBackdrop: v })}
            label="Loop backdrop video"
            hint="Applies when the backdrop is a moving background."
          />
          <Toggle
            checked={draft.loopAudio}
            onChange={(v) => patch({ loopAudio: v })}
            label="Loop background track"
            hint="Repeat the music until the next audio cue."
          />
        </div>

        <Field label="After this cue (auto-follow)">
          <div className="space-y-2 rounded-md border border-av-border bg-av-bg p-2.5">
            <div className="flex gap-1 rounded-md border border-av-border bg-av-panel p-1" role="radiogroup">
              {FOLLOW_OPTIONS.map((option) => {
                const disabled = option.value === 'on-end' && !draft.foregroundMediaId;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={(draft.followMode ?? 'off') === option.value}
                    disabled={disabled}
                    title={disabled ? 'Add a foreground video first' : option.hint}
                    onClick={() => patch({ followMode: option.value })}
                    data-testid={`follow-${option.value}`}
                    className={`flex-1 rounded px-2 py-1.5 text-xs font-semibold disabled:opacity-40 ${
                      (draft.followMode ?? 'off') === option.value
                        ? 'bg-av-amber text-av-bg'
                        : 'text-av-muted hover:bg-av-raised hover:text-av-text'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {(draft.followMode ?? 'off') !== 'off' ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-av-muted">
                {draft.followMode === 'after-delay' ? (
                  <label className="flex items-center gap-1.5">
                    Wait
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      value={draft.followDelaySec ?? 10}
                      onChange={(e) => patch({ followDelaySec: Math.max(1, Math.min(3600, Number(e.target.value) || 1)) })}
                      className="h-7 w-16 rounded border border-av-border bg-av-panel px-2 text-av-text"
                      aria-label="Seconds before the next cue"
                      data-testid="follow-delay"
                    />
                    seconds, then take
                  </label>
                ) : (
                  <span>When the video finishes, take</span>
                )}
                <select
                  value={draft.followTargetId ?? ''}
                  onChange={(e) => patch({ followTargetId: e.target.value || undefined })}
                  className="h-7 min-w-[160px] rounded border border-av-border bg-av-panel px-2 text-av-text"
                  aria-label="Cue to take next"
                >
                  <option value="">the next cue</option>
                  {allCues
                    .filter((c) => c.id !== draft.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        cue {c.order}: {c.label}
                      </option>
                    ))}
                </select>
              </div>
            ) : (
              <p className="text-[11px] text-av-dim">The operator presses TAKE for the next cue.</p>
            )}
            <p className="text-[11px] text-av-dim">
              Runs only while AUTO-FOLLOW is ON; pauses during freeze and blackout. Pick an earlier cue to loop a sponsor slideshow.
            </p>
          </div>
        </Field>

        <Field label="Name caption on TAKE (optional, hides after 10 s)">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={draft.caption?.title ?? ''}
              onChange={(event) => patch({ caption: { title: event.target.value, subtitle: draft.caption?.subtitle ?? '' } })}
              maxLength={80}
              placeholder="Prof. Mahesh Verma"
              aria-label="Caption name"
              className="h-9 rounded-md border border-av-border bg-av-bg px-2.5 text-sm text-av-text focus:border-av-blue focus:outline-none"
              data-testid="cue-caption-title"
            />
            <input
              value={draft.caption?.subtitle ?? ''}
              onChange={(event) => patch({ caption: { title: draft.caption?.title ?? '', subtitle: event.target.value } })}
              maxLength={120}
              placeholder="Vice Chancellor"
              aria-label="Caption role"
              className="h-9 rounded-md border border-av-border bg-av-bg px-2.5 text-sm text-av-text focus:border-av-blue focus:outline-none"
              data-testid="cue-caption-subtitle"
            />
          </div>
        </Field>

        <Field label="Operator notes">
          <textarea
            value={draft.notes ?? ''}
            onChange={(event) => patch({ notes: event.target.value })}
            rows={2}
            maxLength={500}
            placeholder="e.g. Wait for the chief guest to reach the podium"
            className="w-full resize-none rounded-md border border-av-border bg-av-bg px-2.5 py-2 text-sm text-av-text focus:border-av-blue focus:outline-none"
          />
        </Field>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
