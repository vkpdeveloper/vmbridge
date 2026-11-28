// The bundle adds <style> tags at runtime (toasts, the canvas) and embeds its fonts as data: URLs. GitHub serves
// account avatars, and models.dev the logos of the AI providers OpenCode sessions use.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com https://models.dev",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders: Record<string, string> = {
  "content-security-policy": contentSecurityPolicy,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** For the dashboard and its API: keeps other pages, such as one on another port of this host, from framing them. */
export function withSecurityHeaders(response: Response): Response {
  // Copied as Headers, which keep every Set-Cookie, such as logout's two.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
