// Where Boat sends people back after they connect Boat to VM Bridge. Boat only returns to addresses VM Bridge's one
// Boat app lists, and every install has its own, so this hands Boat's answer to the install named in `state`
// (apps/server/src/providers/boat-sign-in.ts).
//
// It asks first instead of forwarding at once. Anyone can make a Boat sign-in link for VM Bridge's app with their own
// address in `state` and their own PKCE verifier, and a page that forwarded the code silently would hand them the
// person's Boat access. This page cannot tell a real install from a fake one, so it shows where the access is going
// and lets the person stop. A route, not a page, so the site's analytics never see the code in the address.

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

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function page(status: number, body: string) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Connect Boat | VM Bridge</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070708; color: #ededed; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 30rem; padding: 2rem 1rem; box-sizing: border-box; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; font-weight: 600; }
  p { margin: 0 0 1rem; color: #a1a1a1; }
  .origin { display: block; margin: 0 0 1rem; padding: .75rem 1rem; border: 1px solid #2a2a2a; border-radius: .5rem; background: #111; color: #fff; font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; }
  a.button { display: inline-block; padding: .6rem 1.1rem; border-radius: .5rem; background: #fff; color: #070708; font-weight: 600; text-decoration: none; }
  a.secondary { background: transparent; color: #ededed; border: 1px solid #2a2a2a; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}

export function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const origin = installOrigin(query.get("state"));
  if (!origin) {
    return page(400, `<h1>This link did not come from VM Bridge</h1><p>Connect Boat again from your VM Bridge dashboard.</p>`);
  }
  const target = `${origin}${installPath}?${query}`;
  const denied = query.get("error") === "access_denied";
  if (denied) {
    return page(200, `<h1>Boat access was not allowed</h1><p>Go back to your VM Bridge:</p><code class="origin">${escape(origin)}</code><div class="actions"><a class="button" href="${escape(target)}">Back to VM Bridge</a></div>`);
  }
  return page(
    200,
    `<h1>Finish connecting Boat</h1>
<p>This gives the VM Bridge at this address access to your Boat account:</p>
<code class="origin">${escape(origin)}</code>
<p>Only continue if this is your VM Bridge and you just clicked Connect Boat there. If not, close this page.</p>
<div class="actions"><a class="button" href="${escape(target)}">Continue</a><a class="button secondary" href="https://boat.dev">Cancel</a></div>`,
  );
}
