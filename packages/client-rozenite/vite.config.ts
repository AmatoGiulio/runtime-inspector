import { defineConfig } from "vite";
import { rozenitePlugin } from "@rozenite/vite-plugin";

export default defineConfig({
  root: __dirname,
  plugins: [rozenitePlugin()],
  // @runtime-inspector/panel-react pins its own `react` devDependency
  // (18.3.1) for its own build/test, so pnpm gives it a private copy
  // distinct from this package's react (19.1.0). tsup builds panel-react
  // with `--external react`, so Vite has to resolve that bare "react"
  // import at bundle time — without dedupe it resolves panel-react's
  // private 18.3.1 copy, and two React module instances end up in the same
  // bundle, breaking the hooks dispatcher ("Invalid hook call") the moment
  // any component renders. Forcing dedupe collapses both resolutions onto
  // this package's single react/react-dom.
  resolve: {
    dedupe: ["react", "react-dom"]
  },
  base: "./",
  build: {
    outDir: "./dist",
    // `rozenite build` runs vite build twice into the same outDir — once for
    // the DevTools panel (dist/devtools, dist/rozenite.json) and once for the
    // react-native.ts entry point (dist/react-native). emptyOutDir: true
    // would wipe the first pass's output when the second pass runs.
    emptyOutDir: false,
    reportCompressedSize: false,
    minify: true,
    sourcemap: false
  },
  // Workspace packages ship pre-built ESM in dist/ (tsup output) with no
  // "main"/browser field trickery, so no special resolve/alias handling was
  // needed for @runtime-inspector/panel-core or panel-react to build cleanly
  // through the Rozenite/vite-plugin-react-native-web pipeline.
  server: {
    port: 8888
  }
});
