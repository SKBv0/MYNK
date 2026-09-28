const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** A bare media file name: no separators, no traversal; never a path the renderer could steer. */
export const isSafeFileName = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_FILE_NAME.test(value) && !value.includes('..');
