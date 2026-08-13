import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PixelLoader, ThinkingBlock } from './ui/AgentState';

describe('AgentState indicators', () => {
  it('PixelLoader renders the pixel grid, shimmer label and elapsed timer', () => {
    const markup = renderToStaticMarkup(<PixelLoader label='Working' startedAt={Date.now()} />);
    expect(markup).toContain('ev-loader');
    expect((markup.match(/ev-loader-pixel/g) ?? []).length).toBe(9);
    expect(markup).toContain('Working');
    expect(markup).toContain('0.0s');
  });

  it('PixelLoader omits the timer without startedAt', () => {
    const markup = renderToStaticMarkup(<PixelLoader label='Loading' />);
    expect(markup).not.toContain('ev-loader-time');
  });

  it('ThinkingBlock shows the shimmer label and a spinner on the live row', () => {
    const markup = renderToStaticMarkup(
      <ThinkingBlock
        activeLabel='Thinking'
        doneLabel='Ran 2 tools'
        running={true}
        rows={[
          { primary: 'Edit', secondary: 'server.ts' },
          { primary: 'Run', secondary: 'pnpm test' },
        ]}
      />
    );
    expect(markup).toContain('ev-think');
    expect(markup).toContain('Thinking');
    expect(markup).toContain('ev-think-spinner');
    expect(markup).toContain('server.ts');
    // all rows except the live one carry the check icon
    expect((markup.match(/ev-think-check/g) ?? []).length).toBe(1);
  });

  it('ThinkingBlock shows the done label when the turn settled', () => {
    const markup = renderToStaticMarkup(
      <ThinkingBlock
        activeLabel='Thinking'
        doneLabel='Ran 2 tools'
        running={false}
        rows={[{ primary: 'Edit', secondary: 'server.ts' }]}
      />
    );
    expect(markup).toContain('Ran 2 tools');
    expect(markup).not.toContain('ev-shimmer-text');
    expect(markup).not.toContain('ev-think-spinner');
  });
});
