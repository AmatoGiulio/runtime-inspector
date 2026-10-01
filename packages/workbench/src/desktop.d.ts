export {};

declare global {
  interface RuntimeDesktopSimulator {
    udid: string;
    name: string;
    state: string;
    runtimeId: string;
    runtime: string;
    isAvailable: boolean;
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