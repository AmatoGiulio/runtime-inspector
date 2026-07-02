export function getDevServerHost(scriptUrl: string | undefined): string | undefined {
  if (!scriptUrl) return undefined;

  try {
    const url = new URL(scriptUrl);
    return url.hostname || undefined;
  } catch {
    const match = scriptUrl.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/([^/:]+)/);
    return match?.[1];
  }
}

const TUNNEL_HOST_SUFFIXES = [
  ".exp.direct",
  ".ngrok.io",
  ".ngrok-free.app",
  ".trycloudflare.com",
  ".tunnelmole.net",
  ".loca.lt"
];

export function isTunnelUrl(url: string): boolean {
  const host = getDevServerHost(url);
  if (!host) return false;

  const lowerHost = host.toLowerCase();
  return TUNNEL_HOST_SUFFIXES.some((suffix) => lowerHost.endsWith(suffix));
}

export function resolveScriptUrl(rawUrls: Array<string | undefined>): {
  scriptUrl?: string;
  tunnelUrl?: string;
} {
  let tunnelUrl: string | undefined;

  for (const rawUrl of rawUrls) {
    if (!rawUrl) continue;
    const host = getDevServerHost(rawUrl);
    if (!host) continue;

    if (isTunnelUrl(rawUrl)) {
      tunnelUrl ??= rawUrl;
      continue;
    }

    return { scriptUrl: rawUrl };
  }

  return tunnelUrl ? { tunnelUrl } : {};
}

export function getBrokerCandidates(options: {
  scriptUrl?: string;
  platform?: string;
  defaultPort?: number;
}): string[] {
  const defaultPort = options.defaultPort ?? 4577;
  const candidates: string[] = [];

  const host = getDevServerHost(options.scriptUrl);
  if (host) {
    for (let i = 0; i < 5; i++) {
      candidates.push(`ws://${host}:${defaultPort + i}`);
    }
  }

  const loopback = options.platform === "android" ? "10.0.2.2" : "127.0.0.1";
  candidates.push(`ws://${loopback}:${defaultPort}`);

  return [...new Set(candidates)];
}
