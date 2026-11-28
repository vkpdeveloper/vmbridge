// Where Boat sends people back after they connect Boat to VM Bridge. Boat only returns to addresses VM Bridge's one
// Boat app lists, and every install has its own, so this forwards Boat's answer to the install named in `state`
// (apps/server/src/providers/boat-sign-in.ts). The code is useless here: only that install has the PKCE verifier.

const installPath = "/admin/api/providers/boat/callback";

/** The install's origin, from the part of `state` before the dot, or null when it is not an http(s) origin. */
function installOrigin(state: string | null): string | null {
  const encoded = state?.split(".")[0];
  if (!encoded) return null;
  try {
    const text = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== text) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const origin = installOrigin(query.get("state"));
  if (!origin) {
    return new Response("This link did not come from VM Bridge. Connect Boat again from your VM Bridge dashboard.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(null, {
    status: 303,
    headers: { location: `${origin}${installPath}?${query}`, "referrer-policy": "no-referrer", "cache-control": "no-store" },
  });
}
