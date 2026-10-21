# @runtime-inspector/babel-plugin

Development-only Babel instrumentation for [Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector). It exposes annotated Reanimated `useSharedValue` declarations and discovers supported animation call sites so they can be tuned live.

## Install

~~~bash
npm install --save-dev @runtime-inspector/babel-plugin@alpha
~~~

Recommended: install the [CLI](https://www.npmjs.com/package/@runtime-inspector/cli) as well and run `npx runtime-inspector init` to configure Babel and Metro. Otherwise add the plugin to your app's Babel config, **before** Reanimated/worklets plugins when present (those stay last):

~~~js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["@runtime-inspector/babel-plugin"]
  };
};
~~~

## Opt in to a shared value

~~~ts
// @inspect min=8 max=48 step=1 label="Card radius"
const cardRadius = useSharedValue(28);
~~~

The transformed declaration keeps returning the same shared value while registering a control in the development inspector. For numeric values, `min` and `max` are required; `step`, `unit`, and `label` are optional.

The plugin also detects supported `withSpring`, `withTiming`, and `withDelay` assignments in component code, with source anchors for supported edits. Animations launched from worklets or gesture callbacks are not all discoverable.

Instrumentation is disabled for production Babel builds. The plugin is not a substitute for installing [@runtime-inspector/react-native](https://www.npmjs.com/package/@runtime-inspector/react-native) in your app.

## Links

[Detailed examples and limits](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) · [Repository](https://github.com/AmatoGiulio/runtime-inspector)

**Status:** alpha, APIs may change. MIT license.
