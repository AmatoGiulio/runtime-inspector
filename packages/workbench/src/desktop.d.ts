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

  interface RuntimeDesktopCapturePreparation {
    device: RuntimeDesktopSimulator;
    source: {
      id: string;
      name: string;
      windowId: number;
    };
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
    getScreenPermission(): Promise<string>;
    getInputPermission(): Promise<boolean>;
    requestInputPermission(): Promise<boolean>;
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