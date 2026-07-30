export const MAX_UPDATE_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Canonicalize a release URL only when it is credential-free HTTPS with no fragment. */
export function validateUpdateDownloadUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function updateFetchOptions(signal: AbortSignal): RequestInit {
  return {
    redirect: 'error',
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { accept: 'application/octet-stream' },
  };
}

export function assertUpdateResponseUrl(
  requestedUrl: string,
  responseUrl: string,
  redirected: boolean,
): void {
  if (redirected) throw new Error('Update download redirects are not allowed.');
  if (!responseUrl) return;
  const canonicalResponse = validateUpdateDownloadUrl(responseUrl);
  if (canonicalResponse !== requestedUrl) {
    throw new Error('The update response URL changed unexpectedly.');
  }
}

export function isAllowedUpdateSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_UPDATE_DOWNLOAD_BYTES
  );
}

export function parseUpdateContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function assertUpdateResponseBounds(
  contentLength: string | null,
  expectedSize: number | null,
): number {
  const declared = parseUpdateContentLength(contentLength);
  if (declared !== null && declared > MAX_UPDATE_DOWNLOAD_BYTES) {
    throw new Error('The update download exceeds the maximum allowed size.');
  }
  if (declared !== null && expectedSize !== null && declared !== expectedSize) {
    throw new Error('The update server returned an unexpected artifact size.');
  }
  return declared ?? expectedSize ?? 0;
}

export function assertUpdateTransferredBytes(
  transferred: number,
  expectedSize: number | null,
): void {
  if (!Number.isSafeInteger(transferred) || transferred < 0) {
    throw new Error('The update download reported an invalid size.');
  }
  if (transferred > MAX_UPDATE_DOWNLOAD_BYTES) {
    throw new Error('The update download exceeds the maximum allowed size.');
  }
  if (expectedSize !== null && transferred > expectedSize) {
    throw new Error('The update download exceeded its declared artifact size.');
  }
}
