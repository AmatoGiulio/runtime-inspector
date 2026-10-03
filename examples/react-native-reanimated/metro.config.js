const { getDefaultConfig } = require("expo/metro-config");
const { withRuntimeInspector } = require("@runtime-inspector/react-native/metro");
module.exports = withRuntimeInspector(getDefaultConfig(__dirname));
