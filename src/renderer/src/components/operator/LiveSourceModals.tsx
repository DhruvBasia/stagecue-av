import { Globe, Loader2, Monitor, RefreshCw, AppWindow } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CaptureSourceInfo, WebInspectResult } from '../../types';
import { normalizeWebUrl, webPageName } from '../../services/utils';
import { useMediaStore } from '../../store/useMediaStore';
import { useShowStore } from '../../store/useShowStore';
import { markSnapshotted } from '../../store/useWebStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

/* Dialogs that add live sources to the library: a web page (e.g. an online
 * flipbook magazine) or an app window / screen to show on the projector. */

export function AddWebPageModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const addWebPage = useMediaStore((s) => s.addWebPage);
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<WebInspectResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setAddress('');
    setName('');
    setNameEdited(false);
    setChecking(false);
    setResult(null);
  }, [open]);

  const url = normalizeWebUrl(address);
  const finalName = name.trim() || (url ? webPageName(url) : '');

  const add = (inspected: WebInspectResult | null): void => {
    if (!url) return;
    // The page's own title is a better name than the address, unless the operator typed one.
    const title = inspected?.title?.trim() ?? '';
    const chosen = !nameEdited && title && title.length <= 48 ? title : finalName;
    const item = addWebPage(url, chosen, inspected?.thumbnail ?? null);
    if (inspected?.thumbnail) markSnapshotted(item.id);
    useShowStore
      .getState()
      .pushAlert(
        'success',
        `Web page added: ${item.name}`,
        'Find it under Library → Live. Make it a cue, then turn its pages with ◀ ▶, the clicker or the live preview.',
        false
      );
    onClose();
  };

  const check = async (): Promise<void> => {
    if (!url) return;
    setChecking(true);
    setResult(null);
    try {
      const inspected = await window.api.invoke('web:inspect', { url, snapshot: true });
      setResult(inspected);
      if (inspected.ok) add(inspected);
    } catch (error) {
      setResult({
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
        finalUrl: url,
        title: null,
        thumbnail: null
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Add a web page"
      onClose={onClose}
      width="sm"
      testId="web-page-modal"
      footer={
        <>
          {result && !result.ok ? (
            <Button variant="secondary" onClick={() => add(null)} disabled={!url} data-testid="web-add-anyway">
              Add anyway
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={checking ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
            disabled={!url || checking}
            onClick={() => void check()}
            data-testid="web-add"
          >
            {checking ? 'Opening…' : 'Add'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <p className="text-xs text-av-muted">
          The page plays live on the projector, for example an online flipbook magazine. You control it from the Program monitor:
          click or drag on the live picture, or use ◀ ▶ (and the clicker) to turn pages.
        </p>
        <label className="block text-xs font-semibold text-av-text">
          Address
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setResult(null);
            }}
            placeholder="https://fests.example.dev/annual-magazine"
            className="mt-1 h-9 w-full rounded-md border border-av-border bg-av-bg px-2.5 font-mono text-xs text-av-text focus:border-av-blue focus:outline-none"
            spellCheck={false}
            data-testid="web-url"
          />
        </label>
        <label className="block text-xs font-semibold text-av-text">
          Name in the library
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
            placeholder={url ? webPageName(url) : 'Annual magazine'}
            maxLength={80}
            className="mt-1 h-9 w-full rounded-md border border-av-border bg-av-bg px-2.5 text-xs text-av-text focus:border-av-blue focus:outline-none"
          />
        </label>
        {address.trim() && !url ? <p className="text-xs text-av-red">Enter a web address such as https://example.com/magazine</p> : null}
        {result && !result.ok ? (
          <p className="rounded-md border border-av-amber/50 bg-av-amber/10 p-2 text-xs text-av-amber" data-testid="web-error">
            Could not open the page: {result.error ?? 'unknown error'}. If the venue has internet later, add it anyway; it is
            checked again in the pre-show check.
          </p>
        ) : null}
        <p className="text-[11px] text-av-dim">
          Needs an internet connection during the show. Keep a PDF of the magazine in the library as a backup.
        </p>
      </form>
    </Modal>
  );
}

export function CapturePickerModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const addCapture = useMediaStore((s) => s.addCapture);
  const [sources, setSources] = useState<CaptureSourceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setSources(null);
    setError(null);
    window.api
      .invoke('capture:list-sources')
      .then(setSources)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const pick = (source: CaptureSourceInfo): void => {
    const item = addCapture(source);
    useShowStore
      .getState()
      .pushAlert('success', `Live window added: ${item.name}`, 'Find it under Library → Live and make it a cue.', false);
    onClose();
  };

  const group = (kind: 'screen' | 'window'): CaptureSourceInfo[] => (sources ?? []).filter((s) => s.kind === kind);

  return (
    <Modal
      open={open}
      title="Show a window or screen on the projector"
      onClose={onClose}
      width="lg"
      testId="capture-modal"
      footer={
        <>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={load}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-av-muted">
        Pick the app window to show (for example a browser with the magazine, Canva or a live score). The audience sees that window
        live; you work in it on this laptop. StageCue's own windows are not listed.
      </p>
      {error ? <p className="text-xs text-av-red">{error}</p> : null}
      {sources === null && !error ? (
        <div className="flex items-center gap-2 py-8 text-xs text-av-muted">
          <Loader2 size={16} className="animate-spin" /> Looking for windows…
        </div>
      ) : null}
      {(['window', 'screen'] as const).map((kind) =>
        group(kind).length > 0 ? (
          <div key={kind} className="mb-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-av-muted">
              {kind === 'window' ? <AppWindow size={13} /> : <Monitor size={13} />}
              {kind === 'window' ? 'Windows' : 'Whole screens'}
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {group(kind).map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => pick(source)}
                  className="overflow-hidden rounded-md border border-av-border bg-av-bg text-left hover:border-av-blue"
                  data-testid="capture-source"
                  title={source.name}
                >
                  <div className="aspect-video bg-black">
                    {source.thumbnail ? <img src={source.thumbnail} alt="" className="h-full w-full object-contain" /> : null}
                  </div>
                  <div className="truncate px-2 py-1 text-[11px] text-av-text">{source.name}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null
      )}
      {sources !== null && sources.length === 0 ? <p className="text-xs text-av-muted">No windows found. Open the app first, then Refresh.</p> : null}
    </Modal>
  );
}
