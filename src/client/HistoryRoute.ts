// Mirrors the optional worker prefix the game route allows (e.g. /w1/history),
// so the page resolves on worker hosts too.
const HISTORY_PATH_REGEX = /^\/(?:w\d+\/)?history\/?$/;

export function matchHistoryPath(pathname: string): boolean {
  return HISTORY_PATH_REGEX.test(pathname);
}
