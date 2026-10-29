/** Keep a stable error shape while retaining a caller-supplied abort reason. */
export default function createAbortError(signal: AbortSignal): Error {
  const error = new Error('The hashing operation was aborted');
  error.name = 'AbortError';
  let reason: unknown;
  try {
    reason = signal.reason;
  } catch (cause) {
    reason = cause;
  }
  if (reason !== undefined) {
    Object.defineProperty(error, 'cause', { value: reason, configurable: true });
  }
  return error;
}
