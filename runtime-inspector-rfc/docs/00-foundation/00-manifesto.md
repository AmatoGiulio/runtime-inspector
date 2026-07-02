# Manifesto

Modern UI development has evolved dramatically.

Modern UI tooling has not.

React Native lets developers build native applications using a declarative model. Reanimated, Skia, native modules, shaders, layout engines and platform APIs allow increasingly rich interfaces. Yet the workflow for refining motion and interaction is still slow, fragmented and imprecise.

A developer changes a value, saves the file, waits for Fast Refresh, triggers the interaction again, judges the result, and repeats. This is acceptable for simple values. It breaks down for subtle motion systems, spring tuning, glass effects, shader parameters, list inertia, keyboard interactions, bottom sheets, layout transitions and complex component libraries.

The correct value for a motion parameter is often not found by typing numbers. It is found by moving, feeling, comparing and iterating.

Runtime Inspector exists to make runtime tuning direct.

It introduces a declarative protocol between an application runtime and an external control surface. The app declares what can be inspected or changed. The panel renders controls dynamically. The user manipulates those controls. The runtime updates immediately.

This is not a visual app builder.
This is not a Figma clone.
This is not a replacement for React DevTools.
This is not a Storybook alternative.

Runtime Inspector is a development instrument for shaping runtime behavior.

The most important part is not the panel.
The most important part is the protocol.

If the protocol is designed well, the panel can be Web today, Desktop tomorrow, a VS Code extension later, and a DevTools plugin after that. React Native can be the first runtime, not the only runtime.

The project starts with React Native because the pain is concrete there: small device screens, mobile-only behavior, native animation systems, real device constraints and a poor tuning loop.

The long-term goal is broader: a common language for runtime-editable controls.
