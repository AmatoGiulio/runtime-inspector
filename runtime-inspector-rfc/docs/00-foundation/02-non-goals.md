# Non-goals

Strong non-goals keep the project focused.

## Runtime Inspector is not Figma

Figma is a design tool. Runtime Inspector is a runtime tuning tool.

It does not attempt to design entire screens visually. It controls values that already exist in a running app.

## Runtime Inspector is not Framer

It does not replace motion prototyping tools. It connects directly to the real runtime and the real implementation.

## Runtime Inspector is not Lottie

It does not export timeline animations as assets. It tunes runtime parameters and can record sessions, but the source of truth remains application code and presets.

## Runtime Inspector is not React DevTools

It does not inspect component trees as its primary job. It inspects declared runtime controls.

## Runtime Inspector is not Storybook

Storybook isolates components. Runtime Inspector controls behavior inside the actual app context.

## Runtime Inspector is not a production dependency

The first version should be development-only. Production builds should remove or disable the runtime server and control registry unless explicitly configured otherwise.

## Runtime Inspector is not a low-code builder

It should not generate full app screens or business logic. It may generate presets, configuration objects, code snippets and protocol schemas.
