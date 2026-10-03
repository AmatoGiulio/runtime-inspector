"use strict";
// Resolved in place of "@runtime-inspector/react-native" by withRuntimeInspector() when Rozenite
// is enabled (see src/metro.ts). Exposes the SDK unchanged, then registers the React Native
// DevTools panel, so the app needs no `import "@runtime-inspector/panel-rozenite"`.
module.exports = require("./dist/index.js");
require("@runtime-inspector/panel-rozenite");
