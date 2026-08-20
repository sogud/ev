import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { App, createElectronTransport, i18n, installTransport } from '@ev/ui';
import '@ev/design-tokens/theme.css';
import '@ev/ui/styles/primitives.css';
import '@ev/ui/styles/index.css';

// server-client-split-v1: the renderer is a pure HTTP+WS client (isomorphic between
// the desktop shell and the web form). Electron main injects the URL hash; the
// ElectronTransport reads it — never IPC.
// Fleet view (herdr-fleet-v1) mounts through <App /> — same shared mount as the web form.
installTransport(createElectronTransport());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
);
