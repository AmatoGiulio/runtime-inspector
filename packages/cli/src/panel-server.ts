import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Serves the prebuilt web panel (`dist/panel`, copied from panel-web at build
 * time) when the CLI runs from an installed package, where panel-web's
 * sources and Vite are not available. The panel reads its broker URL and
 * session token from the query string, so nothing secret is baked into the
 * served files.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export function hasBundledPanel(panelDir: string): boolean {
  return existsSync(join(panelDir, "index.html"));
}

/** Absolute path of the file to serve for a request path, or undefined when it escapes `rootDir`. */
export function resolvePanelFile(rootDir: string, requestUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://panel.local").pathname);
  } catch {
    return undefined;
  }
  const root = resolve(rootDir);
  const candidate = resolve(root, `.${pathname}`);
  const inside = relative(root, candidate);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(root, "index.html");
}

export function startPanelServer(options: { rootDir: string; host: string; port: number }): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const file = resolvePanelFile(options.rootDir, request.url ?? "/");
    if (!file || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolvePromise(server));
  });
}
