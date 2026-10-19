import type { AudioOutputPref, CueItem, DisplayStatus, MediaItem } from '../types';
import { resolveFollowTarget } from './followEngine';

/* =========================================================================
 * Pre-show check: one button that tells the operator, before doors open,
 * whether every cue will actually play. Static rules are pure (unit tested);
 * file and decode checks are injected so the UI can show progress.
 * ========================================================================= */

export type CheckLevel = 'error' | 'warning' | 'info';
export type CheckCategory = 'projector' | 'audio' | 'media' | 'cue' | 'show';

export interface CheckIssue {
  id: string;
  level: CheckLevel;
  category: CheckCategory;
  title: string;
  detail: string;
  cueId?: string;
  mediaId?: string;
}

export interface PreshowContext {
  cues: readonly CueItem[];
  items: readonly MediaItem[];
  displayStatus: DisplayStatus | null;
  stageLinkOk: boolean;
  audioContextState: string;
  outputPref: AudioOutputPref | null;
  outputMissing: boolean;
  isDirty: boolean;
}

export interface MediaProbeOutcome {
  ok: boolean;
  problem?: string;
  duration?: number;
  dimensions?: { width: number; height: number };
}

export interface PreshowDeps {
  /** Returns the ids of media whose files are no longer on disk. */
  findMissingFiles: (items: MediaItem[]) => Promise<Set<string>>;
  /** Decodes one file the same way the stage will. */
  probe: (item: MediaItem) => Promise<MediaProbeOutcome>;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface PreshowReport {
  checkedAt: number;
  issues: CheckIssue[];
  errors: number;
  warnings: number;
  cuesChecked: number;
  mediaChecked: number;
  ready: boolean;
}

const HUGE_IMAGE_PX = 8192;

function cueName(cue: CueItem): string {
  return `Cue ${cue.order} “${cue.label}”`;
}

/** Media referenced by at least one cue, in cue order, without duplicates. */
export function mediaUsedByCues(cues: readonly CueItem[], items: readonly MediaItem[]): MediaItem[] {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const seen = new Set<string>();
  const used: MediaItem[] = [];
  for (const cue of [...cues].sort((a, b) => a.order - b.order)) {
    for (const id of [cue.backdropMediaId, cue.foregroundMediaId, cue.audioMediaId]) {
      if (!id || seen.has(id)) continue;
      const item = byId.get(id);
      if (!item) continue;
      seen.add(id);
      used.push(item);
    }
  }
  return used;
}

/** Rules that need no disk or decoder access. */
export function analyzeShow(ctx: PreshowContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const byId = new Map(ctx.items.map((i) => [i.id, i] as const));
  const push = (issue: Omit<CheckIssue, 'id'>): void => {
    issues.push({ ...issue, id: `${issue.category}-${issues.length}` });
  };

  // Projector & stage
  const mode = ctx.displayStatus?.mode ?? null;
  if (mode === 'docked') {
    push({ level: 'error', category: 'projector', title: 'Projector disconnected', detail: 'The HDMI output was lost. Reconnect the cable.' });
  } else if (mode !== 'projector') {
    push({
      level: 'warning',
      category: 'projector',
      title: 'No projector detected',
      detail: 'The stage is in rehearsal mode on this screen. Connect HDMI and set Windows to “Extend” (Win+P).'
    });
  }
  if (!ctx.stageLinkOk) {
    push({ level: 'error', category: 'projector', title: 'Stage window not responding', detail: 'Use Stage → Reload Stage Output.' });
  }

  // Audio
  if (ctx.audioContextState !== 'running') {
    push({
      level: 'error',
      category: 'audio',
      title: 'Audio engine not running',
      detail: `The stage audio engine is “${ctx.audioContextState}”. Reload the stage output.`
    });
  }
  if (ctx.outputPref && ctx.outputMissing) {
    push({
      level: 'error',
      category: 'audio',
      title: `Audio device “${ctx.outputPref.label}” not connected`,
      detail: 'Sound will play on the system default output until it is reconnected.'
    });
  }

  // Show
  if (ctx.cues.length === 0) {
    push({ level: 'warning', category: 'show', title: 'The cue stack is empty', detail: 'Build cues from your event folder or add them manually.' });
  }
  if (ctx.isDirty) {
    push({ level: 'info', category: 'show', title: 'Unsaved changes', detail: 'Save the show (Ctrl+S) so it can be reopened if anything goes wrong.' });
  }

  // Cues
  for (const cue of [...ctx.cues].sort((a, b) => a.order - b.order)) {
    const refs: Array<{ id: string | undefined; slot: string; expect: Array<MediaItem['type']> }> = [
      { id: cue.backdropMediaId, slot: 'backdrop', expect: ['image', 'video'] },
      { id: cue.foregroundMediaId, slot: 'video', expect: ['video'] },
      { id: cue.audioMediaId, slot: 'music', expect: ['audio'] }
    ];
    if (refs.every((r) => !r.id)) {
      push({ level: 'warning', category: 'cue', title: `${cueName(cue)} is empty`, detail: 'It has no backdrop, video or music.', cueId: cue.id });
    }
    for (const ref of refs) {
      if (!ref.id) continue;
      const item = byId.get(ref.id);
      if (!item) {
        push({ level: 'error', category: 'cue', title: `${cueName(cue)}: ${ref.slot} was removed`, detail: 'Pick a new file for this cue.', cueId: cue.id });
      } else if (!ref.expect.includes(item.type)) {
        push({
          level: 'error',
          category: 'cue',
          title: `${cueName(cue)}: wrong file type for ${ref.slot}`,
          detail: `“${item.name}” is ${item.type === 'audio' ? 'an audio file' : `a ${item.type}`}.`,
          cueId: cue.id,
          mediaId: item.id
        });
      }
    }
    if (cue.audioMediaId && cue.audioVolume <= 0.001) {
      push({ level: 'warning', category: 'cue', title: `${cueName(cue)}: music level is 0 %`, detail: 'The track will be silent.', cueId: cue.id });
    }
    const followMode = cue.followMode ?? 'off';
    if (followMode === 'on-end' && !cue.foregroundMediaId) {
      push({
        level: 'warning',
        category: 'cue',
        title: `${cueName(cue)}: follows “when video ends” but has no video`,
        detail: 'It will wait for a manual TAKE.',
        cueId: cue.id
      });
    }
    if (followMode !== 'off' && cue.followTargetId && !ctx.cues.some((c) => c.id === cue.followTargetId)) {
      push({ level: 'error', category: 'cue', title: `${cueName(cue)}: follow target was deleted`, detail: 'Choose another target cue.', cueId: cue.id });
    } else if (followMode !== 'off' && !resolveFollowTarget(ctx.cues, cue)) {
      push({ level: 'info', category: 'cue', title: `${cueName(cue)}: auto-follow at the end of the stack`, detail: 'There is no next cue to go to.', cueId: cue.id });
    }
  }
  return issues;
}

export async function runPreshowCheck(ctx: PreshowContext, deps: PreshowDeps): Promise<PreshowReport> {
  const issues = analyzeShow(ctx);
  const used = mediaUsedByCues(ctx.cues, ctx.items);
  const firstCueFor = (mediaId: string): string | undefined =>
    [...ctx.cues]
      .sort((a, b) => a.order - b.order)
      .find((c) => c.backdropMediaId === mediaId || c.foregroundMediaId === mediaId || c.audioMediaId === mediaId)?.id;

  deps.onProgress?.(0, used.length, 'Checking files on disk');
  const missing = await deps.findMissingFiles(used.filter((i) => !i.missing));
  let done = 0;
  for (const item of used) {
    const cueId = firstCueFor(item.id);
    if (item.missing || missing.has(item.id)) {
      issues.push({
        id: `media-missing-${item.id}`,
        level: 'error',
        category: 'media',
        title: `File not found: ${item.name}`,
        detail: item.pdf ? `PDF: ${item.pdf.sourcePath}` : item.filePath,
        cueId,
        mediaId: item.id
      });
    } else {
      deps.onProgress?.(done, used.length, `Decoding ${item.name}`);
      const result = await deps.probe(item);
      if (!result.ok) {
        issues.push({
          id: `media-decode-${item.id}`,
          level: 'error',
          category: 'media',
          title: `Will not play: ${item.name}`,
          detail: result.problem ?? 'The player could not decode this file.',
          cueId,
          mediaId: item.id
        });
      } else {
        if (item.type !== 'image' && (!result.duration || result.duration <= 0)) {
          issues.push({
            id: `media-duration-${item.id}`,
            level: 'warning',
            category: 'media',
            title: `No duration: ${item.name}`,
            detail: 'The file opened but reports zero length. Test it on the projector.',
            cueId,
            mediaId: item.id
          });
        }
        const dims = result.dimensions;
        if (dims && Math.max(dims.width, dims.height) > HUGE_IMAGE_PX) {
          issues.push({
            id: `media-huge-${item.id}`,
            level: 'warning',
            category: 'media',
            title: `Very large ${item.type}: ${item.name}`,
            detail: `${dims.width}×${dims.height} may load slowly. 3840×2160 or smaller is plenty for a projector.`,
            cueId,
            mediaId: item.id
          });
        }
      }
    }
    done += 1;
    deps.onProgress?.(done, used.length, item.name);
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  const order: Record<CheckLevel, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return {
    checkedAt: Date.now(),
    issues,
    errors,
    warnings,
    cuesChecked: ctx.cues.length,
    mediaChecked: used.length,
    ready: errors === 0
  };
}
