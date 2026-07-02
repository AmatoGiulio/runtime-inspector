module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      "@runtime-inspector/babel-plugin",
      "react-native-reanimated/plugin"
    ]
  };
};
