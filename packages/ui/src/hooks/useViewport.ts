import { useEffect, useState } from 'react';

/** Form factor is decided by the viewport, not by the entry point: one UI, one entry. */
export type ViewportKind = 'desktop' | 'mobile';

const MOBILE_QUERY = '(max-width: 768px)';

function matches(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
}

/** Live viewport kind (matchMedia); renders default to desktop in non-browser tests. */
export function useViewport(): ViewportKind {
  const [mobile, setMobile] = useState(matches);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setMobile(event.matches);
    setMobile(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return mobile ? 'mobile' : 'desktop';
}
