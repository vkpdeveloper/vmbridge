// VM Bridge's Cloudflare Worker. It stays small: it checks the secrets, serves the dashboard page and sends the
// dashboard's API, T3's and OpenCode's routes and watch links to the one Durable Object that runs the bridge. The dashboard's files are Workers
// Static Assets, served without running this code.
import { isT3Path } from "../gateway/http.ts";
import { isOpenCodeRequest } from "../gateway/opencode.ts";
import { withSecurityHeaders } from "../security-headers.ts";
import { isWatchPath } from "../watch/watch.ts";
import { secretProblems, setupPage, type Env } from "./env.ts";

export { BridgeObject } from "./bridge.ts";

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const pages = new Set(["/dashboard", "/dashboard/onboarding"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // workers.dev is HTTPS-only already. A custom domain may not be, and the dashboard cookie is HTTPS-only.
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.protocol = "https:";
      return redirect(url.href, 308);
    }
    const problems = secretProblems(env);
    if (problems.length > 0) return setupPage(problems);

    const path = url.pathname;
    if (path === "/") return redirect("/dashboard");
    // The browser keeps the fragment (a pairing link's #token=) across the redirect.
    if (path.startsWith("/dashboard/") && path.endsWith("/")) return redirect(`${path.replace(/\/+$/, "")}${url.search}`);
    if (pages.has(path) && (request.method === "GET" || request.method === "HEAD")) {
      const page = await env.ASSETS.fetch(new Request(new URL("/dashboard/index.html", url).href, { method: request.method }));
      const response = withSecurityHeaders(page);
      response.headers.set("cache-control", "no-cache");
      return response;
    }
    if (path.startsWith("/admin/api/") || isT3Path(path) || isOpenCodeRequest(request) || isWatchPath(path)) return env.BRIDGE.getByName("bridge").fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
