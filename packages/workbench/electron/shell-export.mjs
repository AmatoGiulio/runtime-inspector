import fs from "node:fs/promises";
import path from "node:path";

const KINDS = new Set(["tab", "page", "modal"]);
const HEADERS = new Set(["large", "inline", "hidden"]);
const ACTIONS = new Set(["none", "add", "search", "more"]);
const ID = /^[a-z][a-z0-9-]*$/;

export function validateShellProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("Project must be an object.");
  }
  if (typeof project.name !== "string" || !project.name.trim() || project.name.length > 60) {
    throw new Error("Project name must be between 1 and 60 characters.");
  }
  if (!Array.isArray(project.screens) || project.screens.length < 1 || project.screens.length > 16) {
    throw new Error("A project needs between 1 and 16 screens.");
  }
  const ids = new Set();
  for (const screen of project.screens) {
    if (!screen || typeof screen !== "object" || !ID.test(screen.id) || screen.id.length > 35 ||
        screen.id === "index" || screen.id === "_layout") {
      throw new Error("Invalid screen id (use lowercase letters, numbers and dashes; not index/_layout).");
    }
    if (ids.has(screen.id)) throw new Error("Duplicate screen id: " + screen.id);
    ids.add(screen.id);
    if (typeof screen.title !== "string" || !screen.title.trim() || screen.title.length > 80) {
      throw new Error("Invalid screen title: " + screen.id);
    }
    if (!KINDS.has(screen.kind) || !HEADERS.has(screen.header) || !ACTIONS.has(screen.action)) {
      throw new Error("Unsupported screen configuration: " + screen.id);
    }
    if (typeof screen.icon !== "string" || !/^[a-z0-9.]{1,45}$/.test(screen.icon)) {
      throw new Error("Invalid SF Symbol: " + screen.id);
    }
    if (screen.linkTo != null && typeof screen.linkTo !== "string") {
      throw new Error("Invalid navigation destination: " + screen.id);
    }
  }
  const tabs = project.screens.filter((s) => s.kind === "tab");
  if (tabs.length < 1 || tabs.length > 5) throw new Error("Choose between 1 and 5 tabs.");
  for (const screen of project.screens) {
    if (screen.linkTo && (!ids.has(screen.linkTo) || screen.linkTo === screen.id)) {
      throw new Error("Broken link from " + screen.id + " to " + screen.linkTo);
    }
  }
  return project;
}

function toSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ios-shell";
}

function screenRoute(screen) {
  return screen.kind === "tab" ? "/(tabs)/" + screen.id : "/" + screen.id;
}

function generateScreen(screen, screens) {
  const target = screens.find((item) => item.id === screen.linkTo);
  const route = target ? JSON.stringify(screenRoute(target)) : "undefined";
  const headerOptions = JSON.stringify({
    title: screen.title,
    headerShown: screen.header !== "hidden",
    headerLargeTitle: screen.header === "large"
  });
  const buttonIcon = { add: "plus", search: "magnifyingglass", more: "ellipsis.circle" }[screen.action];
  const imports = [
    "import { View, Text, Pressable, Alert, StyleSheet } from 'react-native';",
    "import { Stack, router } from 'expo-router';",
    ""
  ];
  const body = [
    "export default function Screen() {",
    "  const destination = " + route + ";",
    "  const open = () => destination ? router.push(destination as never) : Alert.alert('Shell Studio', 'Connect another screen in the editor.');",
    "  return (",
    "    <>",
    "      <Stack.Screen options={" + headerOptions + "} />"
  ];
  if (buttonIcon) {
    body.push(
      '      <Stack.Toolbar placement="right">',
      '        <Stack.Toolbar.Button icon=' + JSON.stringify(buttonIcon) + ' onPress={open} />',
      '      </Stack.Toolbar>'
    );
  }
  body.push(
    '      <View style={styles.container}>',
    '        <Text style={styles.eyebrow}>SHELL STUDIO / ' + screen.kind.toUpperCase() + '</Text>',
    '        <Text style={styles.title}>{' + JSON.stringify(screen.title) + '}</Text>',
    '        <Text style={styles.caption}>Your custom components go here.</Text>',
    '        {destination ? (',
    '          <Pressable onPress={open} style={styles.link} accessibilityRole="button">',
    '            <Text style={styles.linkText}>{' + JSON.stringify(target ? 'Open ' + target.title + '  →' : 'screen  →') + '}</Text>',
    '          </Pressable>',
    '        ) : null}',
    '      </View>',
    '    </>',
    '  );',
    '}',
    '',
    'const styles = StyleSheet.create({',
    '  container: { flex: 1, padding: 24, paddingTop: 44, backgroundColor: "#fafafa" },',
    '  eyebrow: { fontSize: 11, fontWeight: "600", letterSpacing: 2, color: "#929292" },',
    '  title: { fontSize: 30, fontWeight: "700", marginTop: 12, color: "#171717" },',
    '  caption: { marginTop: 12, fontSize: 15, color: "#777" },',
    '  link: { alignSelf: "flex-start", marginTop: 32, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: "#181818", borderRadius: 12 },',
    '  linkText: { color: "#fff", fontWeight: "600" }',
    '});',
    ''
  );
  return imports.concat(body).join("\n");
}

export function generateShellFiles(input) {
  const project = validateShellProject(input);
  const tabs = project.screens.filter((screen) => screen.kind === "tab");
  const others = project.screens.filter((screen) => screen.kind !== "tab");
  const files = {};
  const slug = toSlug(project.name);

  files["package.json"] = JSON.stringify({
    name: slug,
    version: "1.0.0",
    private: true,
    main: "expo-router/entry",
    scripts: { start: "expo start", ios: "expo start --ios" },
    dependencies: {
      expo: "~55.0.32",
      "expo-router": "~55.0.18",
      react: "19.2.0",
      "react-native": "0.83.0",
      "react-native-screens": "~4.23.0",
      "react-native-safe-area-context": "~5.6.0",
      "expo-linking": "~55.0.17",
      "expo-constants": "~55.0.17"
    },
    devDependencies: { typescript: "~5.9.2", "@types/react": "~19.2.0" }
  }, null, 2) + "\n";
  files["app.json"] = JSON.stringify({
    expo: {
      name: project.name,
      slug,
      scheme: "shell-" + slug,
      plugins: ["expo-router"],
      experiments: { typedRoutes: true },
      ios: { supportsTablet: true }
    }
  }, null, 2) + "\n";
  files["tsconfig.json"] = JSON.stringify({
    extends: "expo/tsconfig.base",
    compilerOptions: { strict: true, baseUrl: "." },
    include: ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
  }, null, 2) + "\n";
  files["expo-env.d.ts"] = "/// <reference types=\"expo/types\" />\n";
  files["shell-studio.json"] = JSON.stringify(project, null, 2) + "\n";
  files["README.md"] = [
    "# " + project.name,
    "",
    "Generated by Shell Studio (experimental) for iOS using Expo SDK 55.",
    "",
    "Run:",
    "",
    "    pnpm install",
    "    pnpm exec expo install --fix",
    "    pnpm ios",
    "",
    "The native iOS Simulator launches the application. Navigation and tabs are real.",
    "Edit src/app to replace the placeholder content. Requires macOS, Xcode and a compatible iOS Simulator.",
    ""
  ].join("\n");

  files["src/app/_layout.tsx"] = [
    "import { Stack } from 'expo-router';",
    "export default function RootLayout() {",
    "  return <Stack>",
    '    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />',
    ...others.map((s) => {
      const opt = { title: s.title, presentation: s.kind === "modal" ? "formSheet" : "card", ...(s.kind === "modal" ? { sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true } : {}), headerLargeTitle: s.header === "large", headerShown: s.header !== "hidden" };
      return '    <Stack.Screen name=' + JSON.stringify(s.id) + ' options={' + JSON.stringify(opt) + '} />';
    }),
    "  </Stack>;",
    "}",
    ""
  ].join("\n");

  files["src/app/index.tsx"] = [
    "import { Redirect } from 'expo-router';",
    "export default function Index() {",
    "  return <Redirect href=" + JSON.stringify("/(tabs)/" + tabs[0].id) + " />;",
    "}",
    ""
  ].join("\n");

  files["src/app/(tabs)/_layout.tsx"] = [
    "import { NativeTabs } from 'expo-router/unstable-native-tabs';",
    "export default function TabsLayout() {",
    "  return <NativeTabs>",
    ...tabs.map((s) => [
      "    <NativeTabs.Trigger name=" + JSON.stringify(s.id) + ">",
      "      <NativeTabs.Trigger.Label>" + escapeJsx(s.title) + "</NativeTabs.Trigger.Label>",
      '      <NativeTabs.Trigger.Icon sf=' + JSON.stringify(s.icon) + " />",
      "    </NativeTabs.Trigger>"
    ].join("\n")),
    "  </NativeTabs>;",
    "}",
    ""
  ].join("\n");

  for (const screen of project.screens) {
    const file = screen.kind === "tab"
      ? "src/app/(tabs)/" + screen.id + "/index.tsx"
      : "src/app/" + screen.id + ".tsx";
    files[file] = generateScreen(screen, project.screens);
    if (screen.kind === "tab") {
      files["src/app/(tabs)/" + screen.id + "/_layout.tsx"] = [
        "import { Stack } from 'expo-router';",
        "export default function TabStack() {",
        "  return <Stack />;",
        "}",
        ""
      ].join("\n");
    }
  }
  return files;
}

function escapeJsx(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


/**
 * Synchronizes only files that Shell Studio itself generated. Other user files are untouched.
 * This directory is managed by the application, not an arbitrary chosen workspace.
 */
export async function syncShellProject(project, directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("Preview directory must be absolute.");
  }
  const files = generateShellFiles(project);
  await fs.mkdir(directory, { recursive: true });
  const manifestName = ".shell-studio-generated.json";
  const currentEntries = await fs.readdir(directory);
  if (!currentEntries.includes(manifestName) && currentEntries.length > 0) {
    throw new Error("Preview directory is not managed by Shell Studio.");
  }
  let oldPaths = [];
  if (currentEntries.includes(manifestName)) {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, manifestName), "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(safeRelativePath)) {
      throw new Error("Invalid Shell Studio preview manifest.");
    }
    oldPaths = parsed;
  }
  for (const relative of oldPaths) {
    if (Object.prototype.hasOwnProperty.call(files, relative)) continue;
    await fs.unlink(path.join(directory, relative)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  let changedFiles = 0;
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const previous = await fs.readFile(destination, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (previous !== contents) {
      await fs.writeFile(destination, contents, "utf8");
      changedFiles++;
    }
  }
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify(Object.keys(files), null, 2) + "\n");
  return { directory, fileCount: Object.keys(files).length, changedFiles };
}

function safeRelativePath(value) {
  return typeof value === "string" && !path.isAbsolute(value) &&
    value !== "" && value !== "." && value.split(/[\/\\]/).every((part) => part !== ".." && part !== "");
}

/**
 * Repairs a legacy generated app without rewriting its components or user-owned code.
 * This is intentionally narrower than a new export: change only the SDK 55 native-tabs
 * entrypoint, and only after detecting the Shell Studio project marker.
 */
export async function repairShellProject(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("Repair requires an absolute Shell Studio project directory.");
  }
  const marker = path.join(directory, "shell-studio.json");
  let definition;
  try {
    definition = JSON.parse(await fs.readFile(marker, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Not a Shell Studio project: shell-studio.json is missing from " + directory);
    }
    throw error;
  }
  validateShellProject(definition);
  const layoutPath = path.join(directory, "src", "app", "(tabs)", "_layout.tsx");
  const content = await fs.readFile(layoutPath, "utf8");
  const oldImport = "from 'expo-router/native-tabs'";
  const correctImport = "from 'expo-router/unstable-native-tabs'";
  let repaired = false;
  if (content.includes(oldImport)) {
    await fs.writeFile(layoutPath, content.replaceAll(oldImport, correctImport), "utf8");
    repaired = true;
  } else if (!content.includes(correctImport)) {
    throw new Error("Unexpected tab layout: no supported Expo Router import found.");
  }

  // Check the actual package installed in this project, not in the Workbench.
  const modulePath = path.join(directory, "node_modules", "expo-router");
  let installedRouter;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(modulePath, "package.json"), "utf8"));
    installedRouter = manifest.version;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // A path-resolution check is more actionable than silently clearing Metro's cache.
  // pnpm may make expo-router a symlink; fs.access resolves it transparently.
  let nativeTabsAvailable = false;
  for (const candidate of ["unstable-native-tabs.js", "unstable-native-tabs.ts", "unstable-native-tabs.tsx", "unstable-native-tabs"]) {
    try {
      await fs.access(path.join(modulePath, candidate));
      nativeTabsAvailable = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { directory, repaired, installedRouter, nativeTabsAvailable };
}

/** Never overwrite user code. Pick an empty directory for an export. */
export async function writeShellProject(project, directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("Choose an absolute export directory.");
  }
  const files = generateShellFiles(project);
  const entries = await fs.readdir(directory);
  if (entries.length !== 0) throw new Error("Export directory is not empty. Choose an empty folder.");
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents, { flag: "wx", encoding: "utf8" });
  }
  return { directory, fileCount: Object.keys(files).length };
}
