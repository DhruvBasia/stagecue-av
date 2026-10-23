import { RefreshCw } from 'lucide-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './components/common/Button';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { AlertStack } from './components/operator/AlertStack';
import { AudioMixerDeck } from './components/operator/AudioMixerDeck';
import { CrewPanel } from './components/operator/CrewPanel';
import { CueList } from './components/operator/CueList';
import { EmergencyPanel } from './components/operator/EmergencyPanel';
import { HeaderBar } from './components/operator/HeaderBar';
import { MediaLibrary } from './components/operator/MediaLibrary';
import { MonitorDualDeck } from './components/operator/MonitorDualDeck';
import { OnAirPanel } from './components/operator/OnAirPanel';
import { PreshowCheckModal } from './components/operator/PreshowCheckModal';
import { SessionRestoreModal } from './components/operator/SessionRestoreModal';
import { SettingsModal } from './components/operator/SettingsModal';
import { useOperatorBridge } from './services/operatorBridge';
import { useAudioStore } from './store/useAudioStore';
import { useCrewStore } from './store/useCrewStore';
import { useDriveStore } from './store/useDriveStore';
import { useMediaStore } from './store/useMediaStore';
import { usePrefsStore } from './store/usePrefsStore';
import { useShowStore } from './store/useShowStore';
import { useStageStore } from './store/useStageStore';
import { useOnAirStore } from './store/useOnAirStore';
import { useWebStore } from './store/useWebStore';
import './styles/globals.css';

declare global {
  interface Window {
    /** Exposed only when launched by the Playwright end-to-end suite. */
    __STAGECUE_TEST__?: {
      media: typeof useMediaStore;
      stage: typeof useStageStore;
      audio: typeof useAudioStore;
      show: typeof useShowStore;
      prefs: typeof usePrefsStore;
      crew: typeof useCrewStore;
      drive: typeof useDriveStore;
      web: typeof useWebStore;
      onAir: typeof useOnAirStore;
    };
  }
}

function OperatorApp(): JSX.Element {
  useOperatorBridge();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-av-bg text-av-text" data-testid="operator-root">
      <HeaderBar />
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(232px,300px)_minmax(0,1fr)_minmax(272px,340px)] gap-2 p-2">
        <MediaLibrary />
        <section className="flex min-h-0 min-w-0 flex-col gap-2">
          <MonitorDualDeck />
          <CueList />
        </section>
        <aside className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <EmergencyPanel />
          <OnAirPanel />
          <AudioMixerDeck />
        </aside>
      </main>
      <AlertStack />
      <SessionRestoreModal />
      <PreshowCheckModal />
      <SettingsModal />
      <CrewPanel />
    </div>
  );
}

function OperatorCrash({ error, reset }: { error: Error; reset: () => void }): JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-av-bg p-8 text-center text-av-text">
      <h1 className="text-lg font-bold text-av-red">The operator console hit an error</h1>
      <p className="max-w-lg text-sm text-av-muted">
        The projector output is unaffected and keeps showing the last cue. Recover the console to continue the show.
      </p>
      <pre className="max-w-2xl overflow-auto rounded-md border border-av-border bg-av-panel p-3 text-left text-xs text-av-muted">
        {error.message}
      </pre>
      <Button variant="primary" icon={<RefreshCw size={14} />} onClick={reset}>
        Recover console
      </Button>
    </div>
  );
}

if (window.api.isE2E) {
  window.__STAGECUE_TEST__ = {
    media: useMediaStore,
    stage: useStageStore,
    audio: useAudioStore,
    show: useShowStore,
    prefs: usePrefsStore,
    crew: useCrewStore,
    drive: useDriveStore,
    web: useWebStore,
    onAir: useOnAirStore
  };
}

window.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target || !target.closest('input, textarea')) event.preventDefault();
});

const container = document.getElementById('root');
if (!container) throw new Error('Operator root element missing');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reset) => <OperatorCrash error={error} reset={reset} />}>
      <OperatorApp />
    </ErrorBoundary>
  </StrictMode>
);
