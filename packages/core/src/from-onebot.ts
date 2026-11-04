import type {
  OneBotAtSegment,
  OneBotFileSegment,
  OneBotImageSegment,
  OneBotSegment,
  UnifiedSegment,
} from '@omni-relay/shared-types';

export interface OneBotSegmentResolver {
  toNativeUserId(onebotId: number): string | null;
}

export interface OneBotSegmentConversionResult {
  segments: UnifiedSegment[];
  warnings: string[];
}

/** Matches a CQ code: `[CQ:type,key=value,...]`. */
const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

const HTTP_URL = /^https?:\/\//i;

type FileSegment = Extract<UnifiedSegment, { type: 'file' }>;
type MentionSegment = Extract<UnifiedSegment, { type: 'mention' }>;

/** Reverses the CQ string escaping rules. */
export function decodeCqText(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** Converts OneBot segments into unified segments, collecting lossy-conversion warnings. */
export function onebotSegmentsToUnified(
  segments: readonly OneBotSegment[],
  resolver: OneBotSegmentResolver,
): OneBotSegmentConversionResult {
  const converted: UnifiedSegment[] = [];
  const warnings: string[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text': {
        const text = decodeCqText(readString(segment.data, 'text') ?? '');
        if (text.length > 0) {
          converted.push({ type: 'text', text });
        }
        break;
      }
      case 'at': {
        const rawId = readString(segment.data, 'qq') ?? '';
        if (rawId === 'all') {
          warnings.push('at_all_unsupported');
          break;
        }
        const onebotId = Number(rawId);
        const nativeUserId = Number.isFinite(onebotId) ? resolver.toNativeUserId(onebotId) : null;
        if (nativeUserId === null || nativeUserId.length === 0) {
          warnings.push(`unknown_user:${rawId}`);
          break;
        }
        const mention: MentionSegment = { type: 'mention', userId: nativeUserId };
        const name = readString(segment.data, 'name');
        if (name !== undefined && name.length > 0) {
          mention.displayName = name;
        }
        converted.push(mention);
        break;
      }
      case 'image': {
        const url = readString(segment.data, 'url') ?? readString(segment.data, 'file');
        if (url === undefined || !HTTP_URL.test(url)) {
          warnings.push('image_requires_url');
          break;
        }
        converted.push({ type: 'image', url });
        break;
      }
      case 'file': {
        const filename = readString(segment.data, 'name') ?? readString(segment.data, 'file');
        const url = readString(segment.data, 'url') ?? readString(segment.data, 'file');
        if (url === undefined || !HTTP_URL.test(url)) {
          warnings.push('file_requires_url');
          break;
        }
        const file: FileSegment = { type: 'file', url, filename: filename ?? url };
        const size = readNumber(segment.data, 'file_size');
        if (size !== undefined) {
          file.size = size;
        }
        converted.push(file);
        break;
      }
      case 'reply': {
        const id = readString(segment.data, 'id');
        if (id === undefined || id.length === 0) {
          warnings.push('unsupported_segment:reply');
          break;
        }
        converted.push({ type: 'reply', messageId: id });
        break;
      }
      default:
        warnings.push(`unsupported_segment:${segment.type}`);
    }
  }
  return { segments: converted, warnings };
}

/** Parses a OneBot CQ-coded message string into segments. */
export function parseCqString(message: string): OneBotSegment[] {
  if (message.length === 0) {
    return [];
  }
  const segments: OneBotSegment[] = [];
  let cursor = 0;
  CQ_PATTERN.lastIndex = 0;
  let match = CQ_PATTERN.exec(message);
  while (match !== null) {
    const index = match.index;
    if (index > cursor) {
      segments.push({ type: 'text', data: { text: decodeCqText(message.slice(cursor, index)) } });
    }
    const type = match[1] ?? '';
    const params = parseCqParams(match[2] ?? '');
    segments.push(buildCqSegment(type, params));
    cursor = index + match[0].length;
    match = CQ_PATTERN.exec(message);
  }
  if (cursor < message.length) {
    segments.push({ type: 'text', data: { text: decodeCqText(message.slice(cursor)) } });
  }
  return segments;
}

function parseCqParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = raw.startsWith(',') ? raw.slice(1) : raw;
  if (body.length === 0) {
    return params;
  }
  for (const pair of body.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    if (key.length === 0) {
      continue;
    }
    params[key] = decodeCqText(pair.slice(separator + 1));
  }
  return params;
}

function buildCqSegment(type: string, params: Record<string, string>): OneBotSegment {
  switch (type) {
    case 'text':
      return { type: 'text', data: { text: params.text ?? '' } };
    case 'at': {
      const data: OneBotAtSegment['data'] = { qq: params.qq ?? '' };
      if (params.name !== undefined) {
        data.name = params.name;
      }
      return { type: 'at', data };
    }
    case 'image': {
      const data: OneBotImageSegment['data'] = { file: params.file ?? params.url ?? '' };
      if (params.url !== undefined) {
        data.url = params.url;
      }
      const size = params.file_size !== undefined ? Number(params.file_size) : Number.NaN;
      if (Number.isFinite(size)) {
        data.file_size = size;
      }
      return { type: 'image', data };
    }
    case 'file': {
      const data: OneBotFileSegment['data'] = { file: params.file ?? params.url ?? '' };
      if (params.url !== undefined) {
        data.url = params.url;
      }
      if (params.name !== undefined) {
        data.name = params.name;
      }
      const size = params.file_size !== undefined ? Number(params.file_size) : Number.NaN;
      if (Number.isFinite(size)) {
        data.file_size = size;
      }
      return { type: 'file', data };
    }
    case 'reply':
      return { type: 'reply', data: { id: params.id ?? '' } };
    default:
      return { type, data: { ...params } };
  }
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
