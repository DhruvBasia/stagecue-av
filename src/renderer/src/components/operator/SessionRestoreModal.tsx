import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ShowFile } from '../../types';
import { applyShow } from '../../services/operatorBridge';
import { clearAutosave, readAutosave } from '../../services/storage';
import { useShowStore } from '../../store/useShowStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

/** Offers to restore the last autosaved session after a crash or unexpected quit. */
export function SessionRestoreModal(): JSX.Element | null {
  const [candidate, setCandidate] = useState<ShowFile | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (window.api.isE2E) return;
    const saved = readAutosave();
    if (saved && (saved.cues.length > 0 || saved.media.length > 0)) setCandidate(saved);
  }, []);

  if (!candidate) return null;

  const discard = (): void => {
    clearAutosave();
    setCandidate(null);
  };

  const restore = async (): Promise<void> => {
    setBusy(true);
    try {
      await applyShow(candidate, null, null);
      useShowStore.getState().pushAlert('success', 'Session restored', `"${candidate.name}" was recovered from autosave.`, false);
      setCandidate(null);
    } catch (error) {
      useShowStore
        .getState()
        .pushAlert('error', 'Could not restore session', error instanceof Error ? error.message : String(error));
      setCandidate(null);
    } finally {
      setBusy(false);
    }
  };

  const savedAt = new Date(candidate.savedAt);

  return (
    <Modal
      open
      title="Restore previous session?"
      onClose={discard}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={discard} disabled={busy}>
            Start fresh
          </Button>
          <Button variant="primary" size="sm" active onClick={() => void restore()} disabled={busy}>
            Restore
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <History size={28} className="shrink-0 text-av-blue" />
        <div className="space-y-1 text-sm text-av-muted">
          <p>
            <span className="font-semibold text-av-text">{candidate.name}</span> was not saved when StageCue AV last closed.
          </p>
          <p>
            {candidate.cues.length} cue(s), {candidate.media.length} media file(s) — autosaved{' '}
            {Number.isNaN(savedAt.getTime()) ? 'recently' : savedAt.toLocaleString()}.
          </p>
        </div>
      </div>
    </Modal>
  );
}
