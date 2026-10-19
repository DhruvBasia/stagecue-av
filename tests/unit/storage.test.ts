import { describe, expect, it } from 'vitest';
import { DEFAULT_MIX } from '../../src/renderer/src/services/audioEngine';
import { createCue } from '../../src/renderer/src/services/cueManager';
import {
  AUTOSAVE_KEY,
  clearAutosave,
  parseShowFile,
  readAutosave,
  serializeShow,
  ShowFileError,
  writeAutosave,
  type StorageLike
} from '../../src/renderer/src/services/storage';
import type { MediaItem } from '../../src/renderer/src/types';

const poster: MediaItem = {
  id: 'm1',
  name: 'poster.png',
  filePath: 'C:\\Shows\\Convocation\\poster.png',
  fileUrl: 'local-media://media/x',
  type: 'image',
  dimensions: { width: 3840, height: 2160 },
  thumbnailUrl: 'data:image/jpeg;base64,AAAA'
};

const anthem: MediaItem = {
  id: 'm2',
  name: 'anthem.mp4',
  filePath: 'C:\\Shows\\Convocation\\anthem.mp4',
  fileUrl: 'local-media://media/y',
  type: 'video',
  duration: 52.4
};

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('show file persistence', () => {
  const show = serializeShow(
    {
      name: '  Convocation 2026 ',
      media: [
        poster,
        anthem,
        {
          id: 'm3',
          name: 'Brochure · p2',
          filePath: 'C:\\Users\\op\\AppData\\render-cache\\page-0002.png',
          fileUrl: 'local-media://media/z',
          type: 'image',
          pdf: { sourcePath: 'C:\\Shows\\Convocation\\Brochure.pdf', page: 2, pageCount: 4 }
        }
      ],
      cues: [
        createCue({ id: 'c2', label: 'Anthem', foregroundMediaId: 'm2' }, 5),
        createCue({ id: 'c1', label: 'Poster', backdropMediaId: 'm1' }, 2)
      ],
      mix: { ...DEFAULT_MIX, bgMusicVolume: 0.6 },
      folders: ['C:\\Shows\\Convocation']
    },
    new Date('2026-10-14T10:00:00Z')
  );

  it('serializes without UI-only data and with renumbered cues', () => {
    expect(show.name).toBe('Convocation 2026');
    expect(show.savedAt).toBe('2026-10-14T10:00:00.000Z');
    expect(show.media[0]).toEqual({
      id: 'm1',
      name: 'poster.png',
      type: 'image',
      filePath: 'C:\\Shows\\Convocation\\poster.png',
      dimensions: { width: 3840, height: 2160 }
    });
    expect(JSON.stringify(show)).not.toContain('data:image');
    expect(show.cues.map((c) => [c.id, c.order])).toEqual([
      ['c1', 1],
      ['c2', 2]
    ]);
  });

  it('round-trips through JSON, including linked event folders', () => {
    expect(parseShowFile(JSON.stringify(show))).toEqual(show);
    expect(parseShowFile(JSON.stringify(show)).folders).toEqual(['C:\\Shows\\Convocation']);
    expect(parseShowFile(JSON.stringify(show)).media[2].pdf).toEqual({
      sourcePath: 'C:\\Shows\\Convocation\\Brochure.pdf',
      page: 2,
      pageCount: 4
    });
  });

  it('treats folders as optional for shows saved before folder linking', () => {
    const { folders: _omitted, ...legacy } = show;
    expect(parseShowFile(JSON.stringify(legacy)).folders).toEqual([]);
    const messy = { ...show, folders: ['C:\\A', 'C:\\A', '', 42] };
    expect(parseShowFile(JSON.stringify(messy)).folders).toEqual(['C:\\A']);
  });

  it('rejects foreign or future files with readable messages', () => {
    expect(() => parseShowFile('not json')).toThrow(ShowFileError);
    expect(() => parseShowFile('{"app":"other"}')).toThrow(/not a StageCue/);
    expect(() => parseShowFile(JSON.stringify({ ...show, version: 99 }))).toThrow(/newer version/);
    expect(() => parseShowFile(JSON.stringify({ ...show, media: [{ id: 'x' }] }))).toThrow(/missing its id or file path/);
  });

  it('repairs dangling references and clamps values from hand-edited files', () => {
    const edited = JSON.parse(JSON.stringify(show)) as Record<string, unknown> & { cues: Array<Record<string, unknown>> };
    edited.cues[0].backdropMediaId = 'deleted-media';
    edited.cues[0].audioVolume = 7;
    edited.cues[0].transition = 'wipe';
    const parsed = parseShowFile(JSON.stringify(edited));
    expect(parsed.cues[0].backdropMediaId).toBeUndefined();
    expect(parsed.cues[0].audioVolume).toBe(1);
    expect(parsed.cues[0].transition).toBe('dissolve');
  });

  it('autosaves for crash recovery', () => {
    const storage = new MemoryStorage();
    expect(readAutosave(storage)).toBeNull();
    expect(writeAutosave(show, storage)).toBe(true);
    expect(storage.data.has(AUTOSAVE_KEY)).toBe(true);
    expect(readAutosave(storage)).toEqual(show);
    storage.setItem(AUTOSAVE_KEY, '{corrupt');
    expect(readAutosave(storage)).toBeNull();
    clearAutosave(storage);
    expect(storage.data.size).toBe(0);
  });
});
