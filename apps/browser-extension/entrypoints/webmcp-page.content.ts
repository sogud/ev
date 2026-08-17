import { installModelContextApi } from '../src/webmcp/page-api';

/**
 * WebMCP page API (MAIN world): exposes `navigator.modelContext.registerTool`
 * to page scripts so websites can register native tools for EV agents.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installModelContextApi();
  },
});
