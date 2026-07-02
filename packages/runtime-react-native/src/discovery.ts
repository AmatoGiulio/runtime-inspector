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
