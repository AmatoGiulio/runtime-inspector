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
  }

  interface Window {
    runtimeDesktop?: RuntimeDesktopApi;
  }
}
