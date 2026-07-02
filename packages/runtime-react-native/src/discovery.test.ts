import { describe, expect, it } from "vitest";
import { getBrokerCandidates, getDevServerHost } from "./discovery";

describe("getDevServerHost", () => {
  it("parses a host from a URL with a port", () => {
    expect(
      getDevServerHost("http://192.168.1.23:8081/index.bundle?platform=ios&dev=true")
    ).toBe("192.168.1.23");
  });

  it("parses a host from a URL without a port", () => {
    expect(getDevServerHost("http://example.com/index.bundle")).toBe("example.com");
  });

  it("returns undefined for a garbage string", () => {
    expect(getDevServerHost("not a url")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(getDevServerHost(undefined)).toBeUndefined();
  });
});

describe("getBrokerCandidates", () => {
  it("builds an ordered candidate list from a LAN scriptUrl", () => {
    const candidates = getBrokerCandidates({
      scriptUrl: "http://192.168.1.23:8081/index.bundle?platform=ios&dev=true",
      platform: "ios",
      defaultPort: 4577
    });

    expect(candidates).toEqual([
      "ws://192.168.1.23:4577",
      "ws://192.168.1.23:4578",
      "ws://192.168.1.23:4579",
      "ws://192.168.1.23:4580",
      "ws://192.168.1.23:4581",
      "ws://127.0.0.1:4577"
    ]);
  });

  it("falls back to the android loopback", () => {
    const candidates = getBrokerCandidates({
      scriptUrl: "http://192.168.1.23:8081/index.bundle",
      platform: "android",
      defaultPort: 4577
    });

    expect(candidates[candidates.length - 1]).toBe("ws://10.0.2.2:4577");
  });

  it("falls back to the 127.0.0.1 loopback by default", () => {
    const candidates = getBrokerCandidates({
      scriptUrl: undefined,
      defaultPort: 4577
    });

    expect(candidates).toEqual(["ws://127.0.0.1:4577"]);
  });

  it("de-duplicates when the scriptUrl host equals the loopback", () => {
    const candidates = getBrokerCandidates({
      scriptUrl: "http://127.0.0.1:8081/index.bundle",
      platform: "ios",
      defaultPort: 4577
    });

    expect(candidates).toEqual([
      "ws://127.0.0.1:4577",
      "ws://127.0.0.1:4578",
      "ws://127.0.0.1:4579",
      "ws://127.0.0.1:4580",
      "ws://127.0.0.1:4581"
    ]);
  });
});
