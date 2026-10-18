// main/codex-session-cookie.ts — pure cookie-name check, usable without Electron.

/** Recognizes the ChatGPT session cookie, including chunked names (.0, .1, ...). */
export function isCodexSessionCookie(name: string): boolean {
  return name.startsWith('__Secure-next-auth.session-token');
}
