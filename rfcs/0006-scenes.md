# RFC 0006 — Scenes: navigable motion entry points

- Status: proposed, 2026-10-03
- Author: orchestrator session, 2026-10-03
- Base: `feat/runtime-workbench-desktop`
- Affects: `protocol` (additive), `runtime-react-native`, `transport-ws` (tests only), `panel-core`, `client-mcp`, `workbench`, example app, docs
- Breaking: no — one optional field on `TriggerControl`, one new Lifecycle message; tolerant readers ignore both

## Motivation

The Workbench can show, edit and replay the animations of the screen that happens to be on the device. It cannot get to any other screen. Today the developer navigates the app by hand in the embedded Simulator, and **Play** fires "the first trigger whose id contains `replay`", which is wrong as soon as two screens declare one. The example app even switches screens with a constant in `App.tsx`.

An app's motion lives in a handful of moments: the product page reveal, the like burst, the onboarding intro, the sheet opening. A developer working on motion thinks in those moments, not in routes. This RFC makes them first-class: a **scene** is a named moment of motion — where to go, and what to play once there. Every client can list scenes and open one: the app navigates there through its own deep link (or a navigation callback), waits until the screen is mounted, and plays the motion. The Workbench turns scenes into a navigator; the MCP client into tools an agent can drive.

Route navigation alone already exists elsewhere (for example an IDE URL bar for Expo Router). A scene is different: it targets a moment of motion and ends with that motion playing, so it is the natural unit for the timeline.

## Decisions

### 1. A scene is a trigger in the reserved `scenes` schema

The runtime publishes scenes as a regular schema with the reserved id `scenes` (title `Scenes`), the same way Runtime Values live in the reserved `auto` schema:

- one `ControlGroup` per scene group, in first-declaration order (`id` and `label` are the group name; scenes without a group go to a group with id `scenes` and label `Scenes`);
- one `trigger` control per scene, in declaration order: `id` = scene id, `label` = title, optional `description`;
- an additive optional field on `TriggerControl`, `scene`, that marks the trigger as a scene and carries what a navigator needs.

Firing the trigger (`control.trigger { schemaId: "scenes", controlId: <sceneId> }`) **opens** the scene (decision 3).

Why a schema and not a new state message:

- the runtime transport opens one broker connection per schema, and the broker routes panel commands by `schemaId`; a schema gives scenes their own connection, exactly-once command routing, broker caching, late-join replay and stale handling with no transport change;
- every existing client already works: the web panel and React Native DevTools render a **Scenes** folder of buttons, and the MCP `trigger` tool opens a scene.

### 2. `TriggerControl.scene`

```ts
interface SceneDescriptor {
  /** Absolute deep link to the scene, resolved by the runtime (decision 4). Absent when none resolves. */
  url?: string;
  /** True while a `useScene` binding for this scene is mounted and active (the scene is on screen). */
  active: boolean;
  /** True when the runtime can bring the scene on screen by itself: it is active, or it has a url or an open() callback. */
  reachable: boolean;
}

interface TriggerControl {
  // ...existing fields
  scene?: SceneDescriptor;
}
```

Validation: `url`, when present, is a non-empty string; `active` and `reachable` are required booleans inside `scene`. A client that does not know the field ignores it (and old parsers strip it — see Compatibility).

`active` and `reachable` change as the user moves through the app. The runtime republishes the `scenes` schema **in place** on its open connection when they change (decision 6); there is no separate "scene state" message.

### 3. Opening a scene

When the runtime receives a trigger for a scene:

1. **On screen.** If a binding for the scene is active, call its play function now and emit `scene.status` `playing`.
2. **Reachable.** Otherwise, if the scene declares `open()`, call it; else if it has a resolved `url`, call React Native `Linking.openURL(url)`; emit `scene.status` `navigating`. If neither exists, emit `failed` / `UNREACHABLE`.
3. **Wait for mount.** Wait until a binding for the scene becomes active, at most `timeoutMs` (default 5000). On timeout emit `failed` / `MOUNT_TIMEOUT`, with a reason that names the url or callback that was used.
4. **Play once.** One frame after the binding becomes active, call its play function and emit `playing`. If the screen already ran that play function by itself since it became active (an entrance animation in a mount effect), it is **not** called again; `playing` is emitted with the time of that run. This prevents a double entrance and duplicate rows on the timeline.

A rejected `open()` promise, a thrown `open()`, or a rejected `Linking.openURL` emits `failed` / `NAVIGATION_FAILED`. A play function that throws emits `failed` / `PLAY_FAILED` (and the error is reported in development). A new open while another is pending supersedes it: the pending one emits `failed` / `SUPERSEDED`.

Only one open is pending at a time. Opening is best-effort and dev-only, like every other Runtime Inspector behavior.

### 4. Links

A scene declares either an absolute link (`myapp://product/42`, `https://…`) or a path (`/product/42`). The runtime resolves a path to an absolute `url` when it publishes, in this order:

1. `configureScenes({ linkPrefix })`, when set (`myapp://` + `product/42`);
2. `createURL(path)` from `expo-linking`, when that module is installed (guarded `require`; the SDK ships CJS for exactly this reason);
3. Expo Go's experience url, `<experienceUrl>/--<path>` (the same native constant broker discovery already reads);
4. otherwise no `url`, and one development warning per scene explaining how to fix it.

The published `url` is absolute so a client can show it, copy it, or open it on the device from outside the app (for example `simctl openurl` when the runtime is not connected). The runtime itself opens it with `Linking.openURL`, so the app's own linking configuration (React Navigation, Expo Router, or hand-written) decides where it lands. `open()` is the escape hatch for state a url cannot express.

### 5. `scene.status` — Lifecycle event

Runtime → panels. Never cached, never replayed. Reports the progress of an open.

```ts
interface SceneStatus {
  type: "scene.status";
  sceneId: string;
  phase: "navigating" | "playing" | "failed";
  /** Same monotonic runtime clock as `animation.started.startedAtRuntimeMs`. */
  atRuntimeMs: number;
  /** Present iff phase is "failed". */
  code?: "UNREACHABLE" | "NAVIGATION_FAILED" | "MOUNT_TIMEOUT" | "PLAY_FAILED" | "SUPERSEDED";
  /** Human-readable explanation, present iff phase is "failed". */
  reason?: string;
}
```

`playing.atRuntimeMs` is the time the scene's play function ran. A client that shows "the motion of this scene" can ignore animations whose call time is earlier, which keeps an unrelated burst just before the navigation out of the scene's timeline.

### 6. Runtime API

```ts
// Declare scenes up front (module scope) so they are listed before their screen is visited.
defineScenes({
  "product-reveal": { title: "Product reveal", group: "Store", link: "/product" },
  "like-burst": { title: "Like", group: "Store", link: "/product", description: "Heart pop on like" },
});
defineScene("welcome", { title: "Welcome", group: "Onboarding", open: () => router.push("/welcome") });

// Bind the motion where it lives. Returns a stable function that runs the latest `play`.
const play = useScene("product-reveal", () => {
  coverOpacity.value = withTiming(1, { duration: 320 });
  // ...
});
useEffect(() => play(), []); // an entrance: the scene knows it already ran

// Apps that keep screens mounted while hidden (stack navigators) pass focus:
useScene("product-reveal", play, { active: useIsFocused() });

// Apps without Expo linking:
configureScenes({ linkPrefix: "myapp://", timeoutMs: 5000 });
```

- `defineScene(id, declaration)` / `defineScenes(map)` merge per field; a later call overrides the fields it sets. `useScene(id, play, options)` may also carry `title`, `group`, `link`, `description`; those only fill fields no declaration has set, so a scene can be declared where it is bound (listed once visited).
- An undeclared `useScene` id declares itself, titled from its id.
- If several bindings of one scene are mounted, the most recently activated active one plays.
- The `scenes` schema connects lazily on the first declaration and is republished **in place** (debounced) on every change: the runtime sends a fresh `schema.publish` on the open connection instead of disposing and reconnecting, so a navigation never drops the `scene.status` that follows it. A connection that is still opening sends the latest schema when it opens.
- Production builds: every function is a no-op; `useScene` returns a function that calls `play`.

### 7. Clients

- **panel-core** derives the scene list from the `scenes` schema (scene, group, stale flag), records the last `scene.status` per scene, and offers `openScene(sceneId)` (a `fireTrigger` on the `scenes` schema; blocked while the schema is stale, like every trigger).
- **Workbench** shows a Scenes navigator: groups, the scene on screen, opening/failed state, the last frame of each scene as a thumbnail, keyboard navigation, copy link, and opening the url on the Simulator when the runtime is not connected. **Play** replays the selected scene (or the one on screen), not the first `replay` trigger. The timeline shows the scene's motion from its `playing` time.
- **MCP** adds `list_scenes` and `open_scene`. `open_scene` waits for `playing` or `failed` and returns the animations observed in the following moment, so an agent can reason about timing and then tune with the existing tools.
- Web panel and React Native DevTools need no change (a folder of buttons).

## Protocol summary

| Message / field | Family | Direction | Broker |
| --- | --- | --- | --- |
| `TriggerControl.scene` (optional) | part of `schema.publish` (State) | runtime → panels | cached and replayed with the schema |
| `scene.status` | Lifecycle event | runtime → panels | forwarded to panels; never cached, never replayed |

Opening a scene uses the existing `control.trigger` (Command). No new command message.

## Compatibility

Additive under docs/protocol-stability.md: a new optional field and a new message type; no `RIP_VERSION` bump. Parsers that predate this RFC strip `scene` from triggers (zod drops unknown keys) and drop `scene.status`; a broker from before this RFC therefore forwards scenes as plain triggers. Broker, runtime and panels in this repository ship together, so the field survives end to end here.

## Out of scope

- Reporting the app's current route or url. A scene knows whether it is on screen, not where the app is.
- Automatic scenes inferred from navigation state or from the components of discovered animations.
- Restoring arbitrary application state before playing; a scene's play function is responsible for its own starting pose.
- Persisting scenes across reloads; declarations are code.
- Deep links into the Workbench itself (`runtime-inspector://…`), which need a packaged desktop app.

## Test plan

- Protocol: fixtures for a `schema.publish` with scene triggers, each `scene.status` phase, and invalid cases (failed without code, code without failed, unknown phase, unknown code, scene without `active`).
- Runtime: declaration merge; auto-declaration; schema shape and order; link resolution order; open when active / by `open()` / by `Linking.openURL`; mount wait and timeout; no double play after an entrance; supersede; play error; in-place republish keeps the same socket; production no-op.
- Broker: `scene.status` reaches panels, is not cached, is not replayed to a late panel; a `control.trigger` on `scenes` reaches only the scenes connection.
- panel-core, MCP, Workbench: their own unit tests; then the example app on the iOS Simulator through the desktop Workbench.
