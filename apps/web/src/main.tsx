import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { App, createWebTransport, i18n, installTransport } from '@ev/ui';
import '@ev/design-tokens/theme.css';
import '@ev/ui/styles/primitives.css';
import '@ev/ui/styles/index.css';

// server-client-split-v1: the web form is the same pure HTTP+WS client as the
// desktop renderer. Open with `?port=..&token=..` (or hash) pointing at a local
// `ev server`, e.g. http://localhost:5173/?port=7877&token=<token>.
// Fleet view (herdr-fleet-v1) mounts through <App /> — same shared mount as the desktop renderer.
installTransport(createWebTransport());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
);
