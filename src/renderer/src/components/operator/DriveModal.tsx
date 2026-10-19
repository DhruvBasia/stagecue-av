import { CloudDownload, FolderOpen, KeyRound, Link2 } from 'lucide-react';
import { useState } from 'react';
import { SYNC_INTERVALS, useDriveStore } from '../../store/useDriveStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Switch } from './SettingsModal';

export interface DriveModalProps {
  open: boolean;
  onClose: () => void;
}

const INTERVAL_LABELS: Record<number, string> = { 30: '30 s', 60: '1 min', 120: '2 min', 300: '5 min' };

/** Add a performers' Google Drive folder and configure syncing. */
export function DriveModal({ open, onClose }: DriveModalProps): JSX.Element | null {
  const adding = useDriveStore((s) => s.adding);
  const addSource = useDriveStore((s) => s.addSource);
  const apiKey = useDriveStore((s) => s.apiKey);
  const setApiKey = useDriveStore((s) => s.setApiKey);
  const autoSync = useDriveStore((s) => s.autoSync);
  const setAutoSync = useDriveStore((s) => s.setAutoSync);
  const intervalSec = useDriveStore((s) => s.intervalSec);
  const setIntervalSec = useDriveStore((s) => s.setIntervalSec);
  const [url, setUrl] = useState('');
  const [localDir, setLocalDir] = useState<string | null>(null);
  const [keyText, setKeyText] = useState(apiKey);
  const [showKey, setShowKey] = useState(apiKey.length > 0);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (keyText.trim() !== apiKey) setApiKey(keyText);
    const source = await addSource(url, localDir);
    if (source) {
      setUrl('');
      setLocalDir(null);
      onClose();
    }
  };

  return (
    <Modal
      open
      title="Performer tracks from Google Drive"
      onClose={onClose}
      width="md"
      testId="drive-modal"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            active
            icon={<CloudDownload size={14} />}
            disabled={adding || url.trim().length === 0}
            onClick={() => void submit()}
            data-testid="drive-add"
          >
            {adding ? 'Checking folder…' : 'Add & download'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ol className="list-decimal space-y-1 rounded-lg border border-av-border bg-av-bg py-2.5 pl-8 pr-3 text-xs text-av-muted">
          <li>Make one Drive folder for the event; performers upload their tracks into it (sub-folders per performer are fine).</li>
          <li>
            In Drive: <strong className="text-av-text">Share → General access → Anyone with the link (Viewer)</strong>.
          </li>
          <li>Copy the folder link and paste it below. Every track is downloaded to this laptop and appears in Background Tracks.</li>
        </ol>

        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-av-muted">
            <Link2 size={12} /> Drive folder link
          </span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/…"
            data-testid="drive-url"
            className="h-9 w-full rounded-md border border-av-border bg-av-bg px-2.5 text-sm text-av-text focus:border-av-blue focus:outline-none"
          />
        </label>

        <div>
          <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-av-muted">
            <FolderOpen size={12} /> Save tracks to
          </span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-av-border bg-av-bg px-2 py-1.5 font-mono text-[11px] text-av-text">
              {localDir ?? 'Documents\\StageCue Drive\\<folder name>'}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void window.api.invoke('drive:choose-folder').then((dir) => {
                  if (dir) setLocalDir(dir);
                });
              }}
            >
              Change…
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-av-border bg-av-bg p-3">
          <div>
            <div className="text-sm font-semibold text-av-text">Auto-sync</div>
            <div className="text-xs text-av-muted">Check Drive for new or changed tracks in the background. Applies to this laptop.</div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={intervalSec}
              disabled={!autoSync}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              aria-label="Sync interval"
              className="h-8 rounded-md border border-av-border bg-av-panel px-1.5 text-xs text-av-text disabled:opacity-40"
            >
              {SYNC_INTERVALS.map((s) => (
                <option key={s} value={s}>
                  every {INTERVAL_LABELS[s]}
                </option>
              ))}
            </select>
            <Switch checked={autoSync} onChange={setAutoSync} label="Auto-sync" testId="drive-autosync" />
          </div>
        </div>

        <div className="rounded-lg border border-av-border bg-av-bg p-3">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-av-muted hover:text-av-text"
            onClick={() => setShowKey((v) => !v)}
          >
            <KeyRound size={13} /> Google API key (optional, recommended) {showKey ? '▾' : '▸'}
          </button>
          {showKey ? (
            <div className="mt-2 space-y-2 text-xs text-av-muted">
              <p>
                Without a key StageCue reads Drive&apos;s public folder page, which works but is not an official Google service and
                can change. With a free API key it uses the official Drive API, which is faster, sees file changes and handles large folders.
              </p>
              <p>
                Get one at <strong className="text-av-text">console.cloud.google.com</strong> → enable “Google Drive API” → Credentials →
                Create API key (restrict it to the Drive API). The key stays on this laptop.
              </p>
              <input
                value={keyText}
                onChange={(e) => setKeyText(e.target.value)}
                onBlur={() => setApiKey(keyText)}
                placeholder="AIza…"
                type="password"
                autoComplete="off"
                aria-label="Google API key"
                className="h-8 w-full rounded-md border border-av-border bg-av-panel px-2 font-mono text-xs text-av-text"
              />
            </div>
          ) : null}
        </div>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
