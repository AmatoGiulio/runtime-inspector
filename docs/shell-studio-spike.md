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
