export function isRetryableContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("errcode" in error && typeof error.errcode === "number") {
    const code = error.errcode & 0xff;
    if (code === 5 || code === 6) return true;
  }
  return "code" in error && error.code === "FILE_LOCK_TIMEOUT";
}
