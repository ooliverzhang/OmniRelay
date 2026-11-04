import { describe, expect, it } from 'vitest';

import { isWithinSchedule } from '@omni-relay/rules';

/** 2026-01-05 is a Monday. */
const MONDAY_NOON = new Date('2026-01-05T12:00:00.000Z');

describe('isWithinSchedule', () => {
  it('treats a missing schedule as always active', () => {
    expect(isWithinSchedule(undefined, MONDAY_NOON)).toBe(true);
    expect(isWithinSchedule({}, MONDAY_NOON)).toBe(true);
  });

  it('checks ISO weekdays', () => {
    expect(isWithinSchedule({ weekdays: [1, 2, 3, 4, 5] }, MONDAY_NOON)).toBe(true);
    expect(isWithinSchedule({ weekdays: [6, 7] }, MONDAY_NOON)).toBe(false);
  });

  it('checks a same-day window', () => {
    expect(isWithinSchedule({ startTime: '09:00', endTime: '17:00' }, MONDAY_NOON)).toBe(true);
    expect(
      isWithinSchedule({ startTime: '09:00', endTime: '17:00' }, new Date('2026-01-05T08:59:00Z')),
    ).toBe(false);
    expect(
      isWithinSchedule({ startTime: '09:00', endTime: '17:00' }, new Date('2026-01-05T17:00:00Z')),
    ).toBe(false);
  });

  it('supports windows that cross midnight', () => {
    const schedule = { startTime: '22:00', endTime: '06:00' };
    expect(isWithinSchedule(schedule, new Date('2026-01-05T23:30:00Z'))).toBe(true);
    expect(isWithinSchedule(schedule, new Date('2026-01-06T05:59:00Z'))).toBe(true);
    expect(isWithinSchedule(schedule, new Date('2026-01-05T12:00:00Z'))).toBe(false);
    expect(isWithinSchedule(schedule, new Date('2026-01-06T06:00:00Z'))).toBe(false);
  });

  it('handles a start-only or end-only window', () => {
    expect(isWithinSchedule({ startTime: '09:00' }, MONDAY_NOON)).toBe(true);
    expect(isWithinSchedule({ startTime: '13:00' }, MONDAY_NOON)).toBe(false);
    expect(isWithinSchedule({ endTime: '13:00' }, MONDAY_NOON)).toBe(true);
    expect(isWithinSchedule({ endTime: '11:00' }, MONDAY_NOON)).toBe(false);
  });

  it('resolves the configured timezone', () => {
    // 01:00 UTC is 09:00 in Asia/Shanghai.
    const at = new Date('2026-01-05T01:00:00.000Z');
    expect(
      isWithinSchedule({ timezone: 'Asia/Shanghai', startTime: '09:00', endTime: '10:00' }, at),
    ).toBe(true);
    expect(
      isWithinSchedule({ timezone: 'Asia/Shanghai', startTime: '10:00', endTime: '11:00' }, at),
    ).toBe(false);
  });

  it('resolves the weekday in the configured timezone', () => {
    // 2026-01-04T20:00Z is Monday 04:00 in Asia/Shanghai.
    const at = new Date('2026-01-04T20:00:00.000Z');
    expect(isWithinSchedule({ timezone: 'Asia/Shanghai', weekdays: [1] }, at)).toBe(true);
    expect(isWithinSchedule({ timezone: 'Asia/Shanghai', weekdays: [7] }, at)).toBe(false);
    expect(isWithinSchedule({ timezone: 'UTC', weekdays: [7] }, at)).toBe(true);
  });

  it('rejects unknown timezones instead of throwing', () => {
    expect(
      isWithinSchedule(
        { timezone: 'Not/AZone', startTime: '00:00', endTime: '23:59' },
        MONDAY_NOON,
      ),
    ).toBe(false);
  });

  it('ignores malformed time strings', () => {
    expect(isWithinSchedule({ startTime: 'noon' }, MONDAY_NOON)).toBe(true);
  });
});
