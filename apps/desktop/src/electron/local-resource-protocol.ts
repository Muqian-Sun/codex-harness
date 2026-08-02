import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const LOCAL_RESOURCE_SCHEME = "app";
export const LOCAL_RESOURCE_HOST = "harness";
export const RENDERER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const allowedExtensions = new Set([".css", ".html", ".js", ".png", ".svg"]);

export type LocalResourceFetch = (url: string) => Promise<Response>;

export function resolveLocalRendererPath(
  rendererRoot: string,
  requestUrl: string,
  method: string,
): string | undefined {
  if (!isAbsolute(rendererRoot) || rendererRoot.includes("\0") || method !== "GET") {
    return undefined;
  }
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== `${LOCAL_RESOURCE_SCHEME}:` ||
      url.hostname !== LOCAL_RESOURCE_HOST ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
      return undefined;
    }
    const resourceName = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
    const segments = resourceName.split("/");
    if (
      resourceName.length === 0 ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      !allowedExtensions.has(extname(resourceName))
    ) {
      return undefined;
    }
    const candidate = resolve(rendererRoot, resourceName);
    const childPath = relative(rendererRoot, candidate);
    if (childPath.length === 0 || childPath === ".." || childPath.startsWith(`..${sep}`)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

export function createLocalResourceHandler(
  rendererRoot: string,
  fetchFile: LocalResourceFetch,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const path = resolveLocalRendererPath(rendererRoot, request.url, request.method);
    if (path === undefined) {
      return notFound();
    }
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return notFound();
      }
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(rendererRoot),
        realpath(path),
      ]);
      const canonicalChild = relative(canonicalRoot, canonicalPath);
      if (
        canonicalChild.length === 0 ||
        canonicalChild === ".." ||
        canonicalChild.startsWith(`..${sep}`)
      ) {
        return notFound();
      }
      const fetched = await fetchFile(pathToFileURL(path).href);
      if (!fetched.ok || fetched.body === null) {
        return notFound();
      }
      const headers = new Headers(fetched.headers);
      headers.set("Content-Security-Policy", RENDERER_CONTENT_SECURITY_POLICY);
      headers.set("Cache-Control", "no-store");
      return new Response(fetched.body, {
        status: fetched.status,
        statusText: fetched.statusText,
        headers,
      });
    } catch {
      return notFound();
    }
  };
}

function notFound(): Response {
  return new Response(null, { status: 404, statusText: "Not Found" });
}
