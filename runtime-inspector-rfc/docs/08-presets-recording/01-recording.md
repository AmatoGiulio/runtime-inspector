# Recording

Recording captures changes over time.

## Use cases

- compare tuning sessions
- generate keyframes
- replay parameter exploration
- understand how a preset was reached

## Recording event

```ts
type RecordingEvent = {
  t: number;
  path: string;
  value: unknown;
  source: "user" | "runtime" | "preset";
};
```

## Timeline output

```json
[
  { "t": 0, "path": "motion.blur", "value": 10 },
  { "t": 120, "path": "motion.blur", "value": 18.4 },
  { "t": 240, "path": "motion.opacity", "value": 0.28 }
]
```

## MVP note

Recording is not required for the first implementation. Design messages now, implement later.
