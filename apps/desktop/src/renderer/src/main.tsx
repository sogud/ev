import React from 'react';
import ReactDOM from 'react-dom/client';
import { createEvClient } from '@ev/contracts/client';
import App from './App';
import '@ev/design-tokens/theme.css';
import './styles/primitives.css';
import './styles/index.css';

// server-client-split-v1：renderer 是纯 HTTP+WS 客户端（desktop 窗壳与 Web 同构）。
// bootstrap 走 URL hash（desktop main 注入）或 query（Web 形态），不是 IPC。
const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
const port = params.get('port') ?? window.location.port ?? '7877';
const token = params.get('token') ?? '';
window.agentDesktop = createEvClient({ baseUrl: `http://127.0.0.1:${port}`, token });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
