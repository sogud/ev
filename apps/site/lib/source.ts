import { loader, type InferPageType } from 'fumadocs-core/source';
import { docs } from '@/.source';
import { docsImageRoute, docsRoute } from './shared';

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
});

export function getPageImageUrl(page: InferPageType<typeof source>): {
  url: string;
  segments: string[];
} {
  const segments = [...page.slugs, 'image.png'];

  return {
    url: `${docsImageRoute}/${segments.join('/')}`,
    segments,
  };
}
