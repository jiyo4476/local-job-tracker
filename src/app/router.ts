import { useEffect, useState } from 'preact/hooks';

export type Route =
  | { name: 'jobs'; query?: string }
  | { name: 'job-new' }
  | { name: 'job-detail'; id: number }
  | { name: 'job-edit'; id: number }
  | { name: 'companies' };

const DEFAULT_ROUTE: Route = { name: 'jobs' };

export function parseHash(hash: string): Route {
  const [pathPart, queryPart] = hash.replace(/^#\/?/, '').split('?');
  const segments = (pathPart ?? '').split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart ?? '');

  if (segments[0] === 'companies') {
    return { name: 'companies' };
  }

  if (segments[0] === 'jobs') {
    if (segments[1] === 'new') return { name: 'job-new' };

    const id = segments[1] === undefined ? undefined : Number(segments[1]);
    if (id !== undefined && Number.isFinite(id)) {
      if (segments[2] === 'edit') return { name: 'job-edit', id };
      return { name: 'job-detail', id };
    }

    const query = params.get('q') ?? undefined;
    return query ? { name: 'jobs', query } : { name: 'jobs' };
  }

  return DEFAULT_ROUTE;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  return route;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
