# Testing the DialKit panels

The existing Runtime Inspector declarations in this example need no migration. DialKit runs in the browser and DevTools panels, not in the React Native runtime.

1. From the repository root, run `pnpm install` and `pnpm build`.
2. Start the example using its existing scripts and open the web panel through the CLI, or select Runtime Inspector inside Rozenite DevTools.
3. Drag a slider and release it; use arrow keys and the exact numeric field. Check that the app changes live and that the committed value and TypeScript export agree.
4. Enter a value outside a slider's declared range. Expect a visible validation reason and no clamped change on the device.
5. Change a toggle, color, spring parameter and Bézier coordinate; use the replay action. Save A/B snapshots and apply them.
6. Leave a color picker open and reload/disconnect the runtime. Expect its picker to close, controls to become read-only, and Apply A/B to disable. On republish, verify controls recover with current values.
7. With multiple schemas, switch between controls that share ids and ensure each updates only its own schema.

Run this checklist on a physical device for both transports before claiming hardware validation. Automated bridge/session tests do not prove DevTools/device behavior. See [DialKit integration](../../docs/dialkit.md) for mappings and limitations.
