export const NativeModules: {
  SourceCode?: {
    getConstants?: () => { scriptURL?: string };
    scriptURL?: string;
  };
} = {};

export const Platform: { OS?: string } = { OS: "ios" };

export const TurboModuleRegistry: { get?: (name: string) => unknown } = {};
