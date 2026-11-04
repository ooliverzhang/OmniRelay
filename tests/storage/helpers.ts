import { openStorage, type Storage } from '@omni-relay/storage';

export interface TestClock {
  now: () => Date;
  advance: (ms: number) => Date;
  set: (iso: string) => Date;
}

export const DEFAULT_TEST_NOW = '2026-01-01T00:00:00.000Z';

export function createClock(start: string = DEFAULT_TEST_NOW): TestClock {
  let current = new Date(start);
  return {
    now: () => current,
    advance(ms: number): Date {
      current = new Date(current.getTime() + ms);
      return current;
    },
    set(iso: string): Date {
      current = new Date(iso);
      return current;
    },
  };
}

export function createStorage(now?: () => Date): Storage {
  return openStorage(
    now === undefined ? { sqlitePath: ':memory:' } : { sqlitePath: ':memory:', now },
  );
}
