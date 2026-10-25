const UNSAFE_TARGET = /[\\\u0000-\u001f\u007f]/;

export function requestUrl(target: string | undefined, port: number): URL | null {
  if (target === undefined || !target.startsWith("/") || target.startsWith("//") || UNSAFE_TARGET.test(target)) return null;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const url = new URL(target, origin);
    return url.origin === origin && !decodeURIComponent(url.pathname).includes("\u0000") ? url : null;
  } catch {
    return null;
  }
}
