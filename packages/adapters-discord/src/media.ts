import { BridgeError } from '@omni-relay/shared-types';

export interface DownloadedMedia {
  data: Uint8Array;
  contentType: string;
  size: number;
  filename: string;
}

export interface DownloadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Downloads outbound media (OneBot image/file segments) so it can be re-uploaded
 * to Discord. Platform temporary URLs are never persisted as permanent links.
 */
export async function downloadMedia(
  url: string,
  filenameHint: string | undefined,
  options: DownloadOptions = {},
): Promise<DownloadedMedia> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new BridgeError({
      code: 'attachment_unavailable',
      message: `media_download_failed: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}`,
      retryable: false,
      cause: error,
    });
  }

  if (!response.ok) {
    throw new BridgeError({
      code: response.status === 404 ? 'attachment_unavailable' : 'platform_unavailable',
      message: `media_download_http_${response.status}`,
      retryable: response.status >= 500,
    });
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new BridgeError({
      code: 'message_too_large',
      message: `media_too_large: ${buffer.byteLength} > ${maxBytes}`,
      retryable: false,
    });
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return {
    data: buffer,
    contentType,
    size: buffer.byteLength,
    filename: filenameHint ?? guessFilename(url, contentType),
  };
}

function guessFilename(url: string, contentType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').pop();
    if (last && last.length > 0) {
      return decodeURIComponent(last);
    }
  } catch {
    // fall through
  }
  const extension = contentType.split('/')[1] ?? 'bin';
  return `attachment.${extension}`;
}
