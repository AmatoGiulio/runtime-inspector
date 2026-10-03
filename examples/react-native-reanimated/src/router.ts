import { useSyncExternalStore } from "react";
import { Linking } from "react-native";

export type Route = "home" | "product" | "like" | "sheet" | "welcome" | "lab";

const ROUTES: readonly Route[] = ["home", "product", "like", "sheet", "welcome", "lab"];

let current: Route = "home";
const listeners = new Set<() => void>();

export function navigate(route: Route): void {
  if (route === current) return;
  current = route;
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Route {
  return current;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Maps a deep link to a route. Takes the path after "/--/" when present (Expo Go),
 * otherwise the path after "://" (the authority is dropped for http(s)/exp(s) urls;
 * for a custom scheme such as myapp://like the first segment is already the path).
 * Query and hash are stripped. An empty path is "home"; an unknown path is undefined.
 */
export function routeFromUrl(url: string): Route | undefined {
  let path: string;
  const expoMarker = url.indexOf("/--/");
  if (expoMarker >= 0) {
    path = url.slice(expoMarker + 4);
  } else {
    const schemeEnd = url.indexOf("://");
    if (schemeEnd < 0) return undefined;
    const scheme = url.slice(0, schemeEnd).toLowerCase();
    const rest = url.slice(schemeEnd + 3);
    if (scheme === "http" || scheme === "https" || scheme === "exp" || scheme === "exps") {
      const slash = rest.indexOf("/");
      path = slash >= 0 ? rest.slice(slash + 1) : "";
    } else {
      path = rest;
    }
  }
  path = path.split("#")[0].split("?")[0].replace(/^\/+|\/+$/g, "");
  if (path === "") return "home";
  return (ROUTES as readonly string[]).includes(path) ? (path as Route) : undefined;
}

function handleUrl(url: string | null | undefined): void {
  if (!url) return;
  const route = routeFromUrl(url);
  if (route) navigate(route);
}

Linking.getInitialURL().then(handleUrl, () => {});
Linking.addEventListener("url", (event) => handleUrl(event.url));
