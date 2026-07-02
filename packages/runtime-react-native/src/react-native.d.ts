declare module "react-native" {
  export const NativeModules: {
    SourceCode?: {
      getConstants?: () => { scriptURL?: string };
      scriptURL?: string;
    };
  };
  export const Platform: { OS?: string };
  export const TurboModuleRegistry: {
    get?: (name: string) => unknown;
  };
}
