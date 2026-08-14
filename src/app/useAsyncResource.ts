import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export interface AsyncResource<T> {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Loads a view resource while preventing an older request from replacing newer state. */
export function useAsyncResource<T>(
  loader: () => Promise<T>,
  dependencies: readonly unknown[],
  fallback = 'Could not load data.',
): AsyncResource<T> {
  const generation = useRef(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await loader();
      if (request === generation.current) setData(result);
    } catch (caught) {
      if (request === generation.current)
        setError(errorMessage(caught, fallback));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, dependencies);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { data, error, loading, reload };
}
