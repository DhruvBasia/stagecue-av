import type { CueItem, MediaItem } from '../types';
import { describeFollow } from './followEngine';
import { formatTime } from './utils';

/* =========================================================================
 * Printable run sheet (A4 landscape): one row per cue with thumbnail, what
 * goes on screen, the music, transition, auto-follow rule, operator notes and
 * an empty tick box for the stage manager.
 * ========================================================================= */

export interface RunSheetInput {
  showName: string;
  cues: readonly CueItem[];
  items: readonly MediaItem[];
  autoFollowEnabled: boolean;
  generatedAt: Date;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only our own generated JPEG/PNG data URLs are embedded. */
function safeThumb(url: string | undefined): string | null {
  return url && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null;
}

function mediaCell(item: MediaItem | null, fallback: string): string {
  if (!item) return `<span class="dim">${escapeHtml(fallback)}</span>`;
  const extra = item.duration !== undefined && item.type !== 'image' ? ` <span class="dur">${formatTime(item.duration)}</span>` : '';
  const missing = item.missing ? ' <span class="bad">MISSING</span>' : '';
  return `${escapeHtml(item.name)}${extra}${missing}`;
}

export function totalVideoSeconds(cues: readonly CueItem[], items: readonly MediaItem[]): number {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  return cues.reduce((sum, cue) => {
    const video = cue.foregroundMediaId ? byId.get(cue.foregroundMediaId) : undefined;
    return sum + (video?.duration ?? 0);
  }, 0);
}

export function buildRunSheetHtml(input: RunSheetInput): string {
  const byId = new Map(input.items.map((i) => [i.id, i] as const));
  const lookup = (id: string | undefined): MediaItem | null => (id ? byId.get(id) ?? null : null);
  const ordered = [...input.cues].sort((a, b) => a.order - b.order);
  const date = input.generatedAt.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  const videoTotal = totalVideoSeconds(ordered, input.items);

  const rows = ordered
    .map((cue) => {
      const backdrop = lookup(cue.backdropMediaId);
      const video = lookup(cue.foregroundMediaId);
      const music = lookup(cue.audioMediaId);
      const thumbSource = safeThumb((backdrop ?? video)?.thumbnailUrl);
      const thumb = thumbSource ? `<img src="${thumbSource}" alt="">` : '<div class="nothumb"></div>';
      const transition =
        cue.transition === 'cut' ? 'Cut' : `${cue.transition === 'fade' ? 'Fade' : 'Dissolve'} ${(cue.transitionDurationMs / 1000).toFixed(1)}s`;
      const follow = describeFollow(cue, ordered);
      const musicCell = music
        ? `${mediaCell(music, '')}<br><span class="dim">${Math.round(cue.audioVolume * 100)}%${cue.loopAudio ? ' · loop' : ''}</span>`
        : '<span class="dim">unchanged</span>';
      return `<tr>
  <td class="num">${cue.order}</td>
  <td class="thumb">${thumb}</td>
  <td><strong>${escapeHtml(cue.label)}</strong></td>
  <td>${mediaCell(backdrop, 'keeps current')}</td>
  <td>${mediaCell(video, '—')}${video && !cue.autoPlayForeground ? '<br><span class="dim">waits for Play</span>' : ''}</td>
  <td>${musicCell}</td>
  <td>${escapeHtml(transition)}</td>
  <td>${follow ? escapeHtml(follow.replace('→ ', '')) : '<span class="dim">manual</span>'}</td>
  <td class="notes">${cue.notes ? escapeHtml(cue.notes) : ''}</td>
  <td class="tick"><span></span></td>
</tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.showName)} — Run Sheet</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; color: #111827; margin: 0; font-size: 10.5px; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111827; padding-bottom: 6px; margin-bottom: 8px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: #4b5563; font-size: 11px; margin-top: 2px; }
  .stats { text-align: right; color: #374151; font-size: 11px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: #4b5563; border-bottom: 1px solid #9ca3af; padding: 4px; }
  td { border-bottom: 1px solid #e5e7eb; padding: 5px 4px; vertical-align: middle; word-wrap: break-word; }
  tbody tr:nth-child(even) td { background: #f9fafb; }
  .num { font-size: 16px; font-weight: 800; text-align: center; }
  .thumb img, .nothumb { width: 96px; height: 54px; object-fit: contain; background: #000; border-radius: 3px; display: block; }
  .dim { color: #6b7280; }
  .dur { color: #1d4ed8; font-weight: 600; }
  .bad { color: #b91c1c; font-weight: 800; }
  .notes { color: #92400e; }
  .tick span { display: inline-block; width: 14px; height: 14px; border: 1.5px solid #374151; border-radius: 2px; }
  footer { margin-top: 8px; color: #6b7280; font-size: 9px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(input.showName)}</h1>
    <div class="sub">Run sheet · ${escapeHtml(date)}</div>
  </div>
  <div class="stats">
    ${ordered.length} cue${ordered.length === 1 ? '' : 's'} · video total ${formatTime(videoTotal)}<br>
    Auto-follow: ${input.autoFollowEnabled ? 'ON' : 'OFF'}
  </div>
</header>
<table>
  <colgroup>
    <col style="width:4%"><col style="width:10%"><col style="width:14%"><col style="width:13%"><col style="width:13%">
    <col style="width:12%"><col style="width:8%"><col style="width:10%"><col style="width:13%"><col style="width:3%">
  </colgroup>
  <thead><tr><th>#</th><th>Preview</th><th>Cue</th><th>Backdrop</th><th>Video</th><th>Music</th><th>Transition</th><th>Next</th><th>Notes</th><th>✓</th></tr></thead>
  <tbody>
${rows || '<tr><td colspan="10" class="dim">No cues yet.</td></tr>'}
  </tbody>
</table>
<footer><span>Keys: Space TAKE · F8 Freeze · ESC Blackout · F4 Backdrop · F9 Fade audio</span><span>StageCue AV</span></footer>
</body>
</html>`;
}
