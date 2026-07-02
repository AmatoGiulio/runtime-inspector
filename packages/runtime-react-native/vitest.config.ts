import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "react-native": resolve(__dirname, "src/test/react-native-stub.ts")
    }
  }
});
