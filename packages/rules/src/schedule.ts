import type { ScheduleConfig } from '@omni-relay/shared-types';

interface LocalClock {
  hour: number;
  minute: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  isoWeekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function readLocalClock(timeZone: string, at: Date): LocalClock | null {
  try {
    const parts = getFormatter(timeZone).formatToParts(at);
    let year = 1970;
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    for (const part of parts) {
      switch (part.type) {
        case 'year':
          year = Number(part.value);
          break;
        case 'month':
          month = Number(part.value);
          break;
        case 'day':
          day = Number(part.value);
          break;
        case 'hour':
          hour = Number(part.value);
          break;
        case 'minute':
          minute = Number(part.value);
          break;
        default:
          break;
      }
    }
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    // The wall-clock date is rebuilt in UTC so the weekday never shifts again.
    const jsWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { hour, minute, isoWeekday: jsWeekday === 0 ? 7 : jsWeekday };
  } catch {
    return null;
  }
}

function parseTimeOfDay(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const hourText = match[1];
  const minuteText = match[2];
  if (hourText === undefined || minuteText === undefined) {
    return null;
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/**
 * Returns true when `at` falls inside the rule schedule.
 *
 * Missing fields mean "no restriction"; the timezone defaults to UTC and
 * `startTime`/`endTime` may wrap past midnight.
 */
export function isWithinSchedule(schedule: ScheduleConfig | undefined, at: Date): boolean {
  if (schedule === undefined) {
    return true;
  }
  const weekdays = schedule.weekdays;
  const hasWeekdays = weekdays !== undefined && weekdays.length > 0;
  const hasTimeWindow = schedule.startTime !== undefined || schedule.endTime !== undefined;
  if (!hasWeekdays && !hasTimeWindow) {
    return true;
  }
  const clock = readLocalClock(schedule.timezone ?? 'UTC', at);
  if (clock === null) {
    return false;
  }
  if (hasWeekdays && weekdays !== undefined && !weekdays.includes(clock.isoWeekday)) {
    return false;
  }
  if (!hasTimeWindow) {
    return true;
  }
  const start = parseTimeOfDay(schedule.startTime);
  const end = parseTimeOfDay(schedule.endTime);
  if (start === null && end === null) {
    return true;
  }
  const current = clock.hour * 60 + clock.minute;
  if (start !== null && end !== null) {
    if (start === end) {
      return true;
    }
    if (start < end) {
      return current >= start && current < end;
    }
    return current >= start || current < end;
  }
  if (start !== null) {
    return current >= start;
  }
  return end !== null && current < end;
}
