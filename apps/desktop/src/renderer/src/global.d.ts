import type { EvClient } from '@ev/contracts/client';

declare global {
  interface Window {
    agentDesktop: EvClient;
  }
}
