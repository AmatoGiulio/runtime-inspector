# Developer Experience

## Install

```sh
npm install @runtime-inspector/react-native
npm install -D @runtime-inspector/cli
```

## Start

```sh
npx runtime-inspector dev
```

## App setup

```ts
if (__DEV__) {
  RuntimeInspector.connect({
    url: "ws://localhost:4877/runtime"
  });
}
```

## Panel setup

Open:

```txt
http://localhost:4878
```

## Desired workflow

1. Run app
2. Run inspector
3. Open panel
4. Tune values
5. Export preset
6. Paste preset in code
7. Remove temporary controls if desired
