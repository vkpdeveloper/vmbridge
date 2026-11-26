import page from "@vmbridge/web/index.html";
import watchPage from "@vmbridge/web/watch.html";
import { withSecurityHeaders } from "../security-headers.ts";

const pages = { "/dashboard": page, "/dashboard/onboarding": page };

/**
 * Bun.serve cannot add headers to an HTML import's routes, so the dashboard is bundled and served by a server only
 * this process talks to, and every listener passes its responses on with the security headers. Its bundled files
 * (script, styles, icons) are then there on every listener from the start, the tunnel's included. The watch page
 * (see watch/watch.ts) is bundled there too, at a path only this process asks for: the bridge serves it under each
 * link's own address, with its own headers.
 *
 * In development each listener serves the pages itself, without the headers: Bun's hot reloading needs its own socket
 * and an inline script, which would not get through. The watch page is then at `/watch/<anything>`, token or not.
 */
export async function openDashboard(development: boolean) {
  if (development) {
    return {
      routes: { ...pages, "/watch/:token": watchPage },
      fetch: null,
      watchPage: async () => new Response("The watch page is served by the dev routes.", { status: 503 }),
      stop: async () => {},
    };
  }
  const files = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    routes: { ...pages, "/watch-page": watchPage },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  // Bun adds the bundled files' routes only once the page was served.
  await Promise.all(["/dashboard", "/watch-page"].map((path) => fetch(new URL(path, files.url)).then((response) => response.arrayBuffer(), () => {})));
  return {
    routes: {},
    fetch: async (request: Request) => {
      const { pathname, search } = new URL(request.url);
      // Only the path and query go onto the files server's address. Resolving the path against it instead would let
      // a request for `//host/x` name another host, and this server would fetch it for anyone.
      const target = new URL(files.url);
      target.pathname = pathname;
      target.search = search;
      const etag = request.headers.get("if-none-match");
      const response = await fetch(target, {
        method: request.method,
        headers: etag ? { "if-none-match": etag } : {},
        redirect: "manual",
      });
      return withSecurityHeaders(response);
    },
    watchPage: () => fetch(new URL("/watch-page", files.url)),
    stop: () => files.stop(true),
  };
}
