import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createEvClient } from '@ev/contracts/client';
import App from './App';
import { i18n } from './i18n';
import '@ev/design-tokens/theme.css';
import './styles/primitives.css';
import './styles/index.css';

// server-client-split-v1: the renderer is a pure HTTP+WS client (isomorphic between
// the desktop shell and the web form). Bootstrap reads the URL hash (injected by
// desktop main) or the query string — never IPC.
const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
const port = params.get('port') ?? window.location.port ?? '7877';
const token = params.get('token') ?? '';
window.agentDesktop = createEvClient({ baseUrl: `http://127.0.0.1:${port}`, token });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
);
