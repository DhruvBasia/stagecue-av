import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  convertPresentation,
  converterOrder,
  findSoffice,
  isPresentationPath,
  lastStage,
  POWERPOINT_SCRIPT,
  sofficeCandidates,
  summarizeError
} from '../../src/main/presentationConverter';

let root: string;
let deck: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'stagecue-deck-'));
  deck = path.join(root, 'Award Night.pptx');
  writeFileSync(deck, 'fake pptx bytes');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const writePdf = async (_source: string, target: string): Promise<void> => {
  await fsp.writeFile(target, '%PDF-1.4 converted');
};

describe('presentation conversion', () => {
  it('recognises PowerPoint and Impress files', () => {
    for (const name of ['a.pptx', 'b.PPT', 'c.ppsx', 'd.pps', 'e.pptm', 'f.odp']) expect(isPresentationPath(name)).toBe(true);
    for (const name of ['a.pdf', 'b.key', 'c.docx']) expect(isPresentationPath(name)).toBe(false);
  });

  it('prefers PowerPoint on Windows and LibreOffice elsewhere', () => {
    expect(converterOrder('win32')).toEqual(['powerpoint', 'libreoffice']);
    expect(converterOrder('darwin')).toEqual(['libreoffice']);
    expect(converterOrder('linux')).toEqual(['libreoffice']);
  });

  it('finds LibreOffice in standard locations and on PATH', () => {
    const win = sofficeCandidates('win32', { ProgramFiles: 'C:\\Program Files', PATH: 'D:\\Tools' });
    expect(win).toContain('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    expect(win.some((p) => p.startsWith('D:\\Tools'))).toBe(true);
    expect(findSoffice('darwin', (p) => p === '/Applications/LibreOffice.app/Contents/MacOS/soffice', { PATH: '' })).toBe(
      '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    );
    expect(findSoffice('linux', () => false, { PATH: '/usr/bin' })).toBeNull();
  });

  it('reports the useful line of a PowerShell error and the last step reached', () => {
    const stderr = [
      'Exception calling "SaveAs" with "2" argument(s): "Error HRESULT E_FAIL has been returned from a call to a COM component."',
      'At line:10 char:3',
      '+   $pres.SaveAs($dst, 32)',
      '+   ~~~~~~~~~~~~~~~~~~~~~~',
      '    + CategoryInfo          : NotSpecified: (:) [], MethodInvocationException'
    ].join('\r\n');
    expect(summarizeError(stderr)).toBe(
      'Exception calling "SaveAs" with "2" argument(s): "Error HRESULT E_FAIL has been returned from a call to a COM component."'
    );
    expect(lastStage('STAGE:STARTED\r\nSTAGE:OPENED\r\n')).toBe('opened');
    expect(lastStage('')).toBe('not started');
  });

  it('passes file paths to PowerPoint through environment variables, never inside the script', () => {
    expect(POWERPOINT_SCRIPT).toContain('$env:STAGECUE_PPT_SRC');
    expect(POWERPOINT_SCRIPT).toContain('SaveAs($dst, 32)');
    expect(POWERPOINT_SCRIPT).not.toContain(root);
  });

  it('falls back to LibreOffice when PowerPoint fails, then reuses the cached PDF', async () => {
    const calls: string[] = [];
    const first = await convertPresentation(deck, path.join(root, 'cache'), {
      platform: 'win32',
      converters: {
        powerpoint: async () => {
          calls.push('powerpoint');
          throw new Error('PowerPoint is not installed');
        },
        libreoffice: async (source, target) => {
          calls.push('libreoffice');
          await writePdf(source, target);
        }
      }
    });
    expect(calls).toEqual(['powerpoint', 'libreoffice']);
    expect(first.endsWith('.pdf')).toBe(true);
    expect(await fsp.readFile(first, 'utf8')).toBe('%PDF-1.4 converted');

    const second = await convertPresentation(deck, path.join(root, 'cache'), {
      platform: 'win32',
      converters: {
        powerpoint: async () => {
          calls.push('again');
          throw new Error('should not run');
        }
      }
    });
    expect(second).toBe(first);
    expect(calls).toEqual(['powerpoint', 'libreoffice']);

    // Saving the deck again (new modification time) triggers a fresh conversion.
    const later = new Date(Date.now() + 60_000);
    utimesSync(deck, later, later);
    const third = await convertPresentation(deck, path.join(root, 'cache'), {
      platform: 'win32',
      converters: { powerpoint: writePdf }
    });
    expect(third).not.toBe(first);
  });

  it('explains what to do when no converter is available', async () => {
    const other = path.join(root, 'Sponsors.ppsx');
    writeFileSync(other, 'x');
    await expect(
      convertPresentation(other, path.join(root, 'cache'), {
        platform: 'linux',
        converters: {
          libreoffice: async () => {
            throw new Error('LibreOffice is not installed');
          }
        }
      })
    ).rejects.toThrow(/Install Microsoft PowerPoint or LibreOffice, or save the deck as PDF/);
  });
});
