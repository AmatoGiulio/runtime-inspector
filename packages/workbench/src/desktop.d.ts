export {};

declare global {
  interface RuntimeDesktopSimulator {
    udid: string;
    name: string;
    state: string;
    runtimeId: string;
    runtime: string;
    isAvailable: boolean;
    deviceTypeIdentifier?: string;
  }

  interface RuntimeDesktopDeviceChromeGeometry {
    screen: { widthPt: number; heightPt: number };
    /** Bezel thickness in points. */
    bezel: { top: number; right: number; bottom: number; left: number };
    /** Size in points of the composite's square corner slices. */
    cornerSlicePt: number;
    outerCornerRadiusPt?: number;
    compositeName: string;
    maskName?: string;
  }

  /** The real bezel of an iOS Simulator device type, rasterized from the local Xcode install. */
  interface RuntimeDesktopDeviceChrome {
    deviceTypeIdentifier: string;
    name: string;
    geometry: RuntimeDesktopDeviceChromeGeometry;
    compositeDataUrl: string;
    compositeSizePx: { width: number; height: number };
    /** Composite pixels per point. */
    compositeScale: number;
    maskDataUrl?: string;
  }

  interface RuntimeDesktopCrop {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
  }

  interface RuntimeDesktopCapturePreparation {
    device: RuntimeDesktopSimulator;
    source: {
      id: string;
      name: string;
      windowId: number;
    };
    crop?: RuntimeDesktopCrop;
    input: {
      ready: boolean;
      error?: string;
    };
  }

  interface RuntimeDesktopFramebufferPreparation {
    device: RuntimeDesktopSimulator;
    mode: string;
    targetFrameRate: number;
    input: {
      ready: boolean;
      error?: string;
    };
    bootstrapFrame?: RuntimeDesktopFramebufferFrame;
  }

  interface RuntimeDesktopFramebufferStatus {
    message: string;
    frameSource?: "simscreen-callbacks" | "seed-polling" | string;
    detail?: string;
  }

  interface RuntimeDesktopFramebufferFrame {
    sequence: number;
    capturedAtMs: number;
    receivedAtMs: number;
    encodeDurationUs: number;
    width: number;
    height: number;
    mimeType: string;
    bytes: ArrayBuffer;
  }

  interface RuntimeDesktopApi {
    platform: string;
    getInfo(): Promise<{
      platform: string;
      desktop: boolean;
      screenPermission: string;
    }>;
    listSimulators(): Promise<RuntimeDesktopSimulator[]>;
    prepareSimulatorCapture(udid?: string): Promise<RuntimeDesktopCapturePreparation>;
    startSimulatorFramebuffer(udid?: string): Promise<RuntimeDesktopFramebufferPreparation>;
    stopSimulatorFramebuffer(): Promise<boolean>;
    onSimulatorFramebufferFrame(
      callback: (frame: RuntimeDesktopFramebufferFrame) => void
    ): () => void;
    onSimulatorFramebufferStatus(
      callback: (status: RuntimeDesktopFramebufferStatus) => void
    ): () => void;
    onSimulatorFramebufferError(
      callback: (error: { message: string }) => void
    ): () => void;
    getDeviceChrome(udid: string): Promise<RuntimeDesktopDeviceChrome | null>;
    /** Opens `url` on the Simulator with `xcrun simctl openurl`; rejects with the validation message. */
    openSimulatorUrl(udid: string, url: string): Promise<boolean>;
    getScreenPermission(): Promise<string>;
    prepareSimulatorInput(): Promise<boolean>;
    sendSimulatorPointer(event: {
      type: "down" | "drag" | "up";
      x: number;
      y: number;
    }): void;
  }

  interface Window {
    runtimeDesktop?: RuntimeDesktopApi;
  }
}