import { describe, expect, it } from 'vitest';
import { JobFormLoadGuard } from './jobFormLoad';

describe('JobFormLoadGuard', () => {
  it('rejects an older route load after a newer load starts', () => {
    const guard = new JobFormLoadGuard();
    const firstJob = guard.begin();
    const secondJob = guard.begin();

    expect(guard.isCurrent(firstJob)).toBe(false);
    expect(guard.isCurrent(secondJob)).toBe(true);
  });

  it('invalidates an in-flight load when the effect is cleaned up', () => {
    const guard = new JobFormLoadGuard();
    const request = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(request)).toBe(false);
  });
});
