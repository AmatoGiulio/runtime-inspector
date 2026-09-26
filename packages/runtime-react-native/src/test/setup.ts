import { afterEach, beforeEach, vi } from "vitest";

// Declaration tests must not connect to a developer's running broker. Transport
// tests override this default with their own controllable socket implementation.
class OfflineWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = OfflineWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(_data: string) {}

  close() {
    this.readyState = OfflineWebSocket.CLOSED;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", OfflineWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
