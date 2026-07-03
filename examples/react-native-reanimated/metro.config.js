const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// pnpm can install a second physical copy of peer dependencies under
// packages/runtime-react-native/node_modules. Reanimated (and React) must be
// singletons: mutables created by one copy are invisible to the other's
// runtime ("sv.addListener is not a function"). Force every import of these
// modules to resolve from this app's own dependency graph.
const singletons = ["react", "react-native", "react-native-reanimated"];

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSingleton = singletons.some(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`)
  );
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  if (isSingleton) {
    return resolve(
      { ...context, originModulePath: path.join(__dirname, "index.js") },
      moduleName,
      platform
    );
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
