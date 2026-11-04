# Shell Studio — experimental iOS shell editor

A narrow proof of concept inside the existing Runtime Inspector desktop Workbench.

## What works in this spike

- Switch between **Motion** and **Shell Studio**, with the same real Simulator viewport and HID input.
- Add and remove screens of three kinds: **native tabs**, **stack push**, **native form sheets**.
- Reorder tabs, configure SF Symbols, native navigation header (large/inline/hidden), toolbar icon and one navigation target per screen.
- The app definition is stored in the editor's localStorage.
- Generate an independent Expo Router SDK 55 project into a user-selected **empty directory**.
- Keep an automatically synchronized, managed preview workspace at:
  ~/Library/Application Support/Runtime Inspector/shell-studio-live/
  (actual path is available through the **Copy preview launch command** button).
- When an Expo preview is running, file writes are observed by Metro; edits to existing pages should Fast Refresh, while route additions/removals may require a full reload.

## Try it on macOS

From the monorepo root on the feature branch:

    pnpm install
    pnpm build
    pnpm workbench:desktop

No Runtime Inspector broker is required to experiment with the Shell Studio editor; the
Motion side still uses the normal broker.

Click **Shell Studio** in the title bar. Add a tab, page or sheet, set properties and navigation links.
Shell Studio automatically creates/updates its private preview project after edits.

Click **Copy preview launch command**, paste it in another Terminal window and execute it.
The generated project installs its own dependencies and starts Expo in the iOS Simulator.

Return to the Workbench and click **Launch & Attach**, selecting the appropriate Simulator.
The central viewport is a real CoreSimulator framebuffer, not a DOM recreation.

**Export Expo project…** generates a separate, editable app in an empty directory. It will never overwrite an existing app or its files.

## SDK 55 compatibility and regression checks

Shell Studio deliberately targets **Expo SDK 55**. The generated native tabs import is
`expo-router/unstable-native-tabs` (the stable `expo-router/native-tabs` entry point
is for SDK 58+). This must be kept in sync with the exported package versions.

The CI runs both the Workbench suite and a **standalone iOS Metro bundle smoke test**:
it creates an Expo project using the real generator, installs dependencies outside
the monorepo, and runs `expo export --platform ios`. Changes to generated
navigation APIs must pass that test before merging.

To update an existing live preview, pull the feature branch and restart
`pnpm workbench:desktop`. **The managed preview now synchronizes automatically
when the desktop editor starts**, even before switching to Shell Studio. The
older SDK 55 native-tabs import is migrated on startup.

The Shell Studio sidebar displays the actual **Live preview** folder. Use
**Copy preview launch command** to run that exact project, avoiding a different
exported copy or the old Reanimated example. If you previously launched an app
from **Export Expo project…**, use **Repair exported Shell Studio app…** in the
sidebar and select its directory: it safely replaces the obsolete native-tabs
import *only if* that directory contains `shell-studio.json`. Other source files
are left alone. Restart Metro with `pnpm exec expo start --ios --clear` from
the app directory after a failed bundle.

If the error remains, first inspect the exact unresolved import and source path
in Metro's error text: `expo-router/native-tabs` means the source remains old,
while `expo-router/unstable-native-tabs` indicates that the app's installed
`expo-router` or its project directory may be wrong. The repair action also
reports the version found inside the selected project's `node_modules`.

## Engineering notes / boundaries

- This is deliberately a feature-branch experiment; Runtime Inspector motion semantics and its existing workbench remain separate.
- Screen selection on the left edits the **project schema**. It does **not yet navigate** the running app or select native view objects by touching the Simulator.
- A toolbar action currently opens the selected destination, or an explanatory alert when unconnected. It is a placeholder for a future native-action schema.
- Existing code outside the generated preview manifest is preserved, but generated screens are rewritten on edit: put persistent custom UI outside those files. On export, all files are yours.
- The live preview is first launched manually; Shell Studio does not yet manage Metro child-process lifecycle or watch for a running app.
- The framebuffer + HID helpers rely on **private Xcode Simulator frameworks**, currently designed for Apple Silicon/macOS. Compatibility and packaging remain experimental.
- React Native / Expo app behavior must be manually confirmed on Xcode Simulator. Generator tests do not substitute for an end-to-end simulator run.

## Tests

    pnpm --filter @runtime-inspector/workbench test

The generator suite checks route output, native tabs/sheets, validation, safety against overwriting user files, and incremental sync.

## Next slice

1. Map Shell Studio-selected screen IDs to actual Expo Router navigation in the running preview via a narrow runtime bridge.
2. Add a structural component library (search bar, header buttons, native menus, drawers/sidebar) backed by native component APIs.
3. Add real view-selection metadata in the runtime to map a simulator tap to Inspector properties.
4. Introduce a robust live Metro/Simulator launcher and code-import story for existing projects.
