import { useRef, useState, type ReactNode } from "react";
import {
  ColorControl,
  EasingVisualization,
  Folder,
  Slider,
  SpringVisualization,
  Toggle,
} from "dialkit";
import type { PanelSession } from "@runtime-inspector/panel-core";
import {
  validateControlValue,
  type BezierControl,
  type CubicBezier,
  type InspectorControl,
  type SliderControl,
  type SpringControl,
  type SpringValue,
} from "@runtime-inspector/protocol";
import { CodeIcon } from "./icons";

export interface InspectorControlProps {
  session: Pick<PanelSession, "setValue" | "commitValue" | "fireTrigger">;
  schemaId: string;
  control: InspectorControl;
  value: unknown;
  disabled: boolean;
  /** Present only when the control carries a source anchor and a workspace can write it back. */
  onApplyToCode?: () => void;
}

/** Identity changes reset transient editor state, including DialKit's body-level popover. */
export function InspectorControlRow(props: InspectorControlProps) {
  const identity = useRef({ control: props.control, revision: 0 });
  if (identity.current.control !== props.control)
    identity.current = {
      control: props.control,
      revision: identity.current.revision + 1,
    };
  return (
    <Control
      key={JSON.stringify([
        props.schemaId,
        props.control.id,
        props.control.kind,
        props.disabled,
        identity.current.revision,
      ])}
      {...props}
    />
  );
}

interface Editing {
  change(next: unknown): void;
  commit(): void;
  discrete(next: unknown): void;
}

function Control({
  session,
  schemaId,
  control,
  value,
  disabled,
  onApplyToCode,
}: InspectorControlProps) {
  const dirty = useRef(false);
  const current =
    value ?? ("defaultValue" in control ? control.defaultValue : undefined);
  const editing: Editing = {
    change(next) {
      session.setValue(schemaId, control.id, next);
      dirty.current = validateControlValue(control, next).ok;
    },
    commit() {
      if (!dirty.current) return;
      dirty.current = false;
      session.commitValue(schemaId, control.id);
    },
    discrete(next) {
      editing.change(next);
      editing.commit();
    },
  };

  // DialKit components have no disabled prop. Unmounting is necessary: inert alone
  // does not cover ColorControl's imperative popover or an active pointer drag.
  if (disabled)
    return (
      <div className="ri-dial-control ri-dial-frozen" aria-disabled="true">
        <span>{control.label}</span>
        <output>
          {control.kind === "trigger"
            ? "Unavailable while stale"
            : formatFrozen(current)}
        </output>
      </div>
    );

  let editor: ReactNode;
  switch (control.kind) {
    case "slider":
      editor = (
        <ExactSlider
          control={control}
          value={current as number}
          editing={editing}
        />
      );
      break;
    case "toggle":
      editor = (
        <Toggle
          label={control.label}
          checked={current as boolean}
          onChange={editing.discrete}
        />
      );
      break;
    case "color":
      // The picker owns a DOM portal and exposes only onChange, not an end event.
      editor = (
        <ColorControl
          label={control.label}
          value={current as string}
          onChange={editing.discrete}
        />
      );
      break;
    case "trigger":
      editor = (
        <div className="dialkit-button-group">
          <button
            className="dialkit-button ri-dial-trigger"
            type="button"
            onClick={() => session.fireTrigger(schemaId, control.id)}
          >
            {control.label}
          </button>
        </div>
      );
      break;
    case "spring":
      editor = (
        <SpringEditor
          control={control}
          value={current as SpringValue}
          editing={editing}
        />
      );
      break;
    case "bezier":
      editor = (
        <BezierEditor
          control={control}
          value={current as CubicBezier}
          editing={editing}
        />
      );
      break;
  }

  return (
    <div
      className="ri-dial-control"
      data-kind={control.kind}
      title={control.description}
    >
      <div className="ri-dial-editor">{editor}</div>
      {onApplyToCode ? (
        <button
          className="ri-dial-apply"
          type="button"
          aria-label={`Apply ${control.label} to code`}
          title="Write this value back to source"
          onClick={onApplyToCode}
        >
          <CodeIcon />
        </button>
      ) : null}
    </div>
  );
}

/** Commits once a gesture on any nested DialKit slider ends. */
function GestureScope({
  editing,
  children,
  onKeyDownCapture,
}: {
  editing: Editing;
  children: ReactNode;
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      className="ri-dial-gesture"
      onKeyDownCapture={onKeyDownCapture}
      onPointerUp={editing.commit}
      onPointerCancel={editing.commit}
      onKeyUp={editing.commit}
      onBlur={editing.commit}
    >
      {children}
    </div>
  );
}

/**
 * DialKit's own value editor clamps and rounds typed input. Exact entry is
 * offered separately (Enter on the slider, or double-click) so an out-of-range
 * number reaches RIP validation and is rejected with a reason instead.
 */
function ExactSlider({
  control,
  value,
  editing,
}: {
  control: SliderControl;
  value: number;
  editing: Editing;
}) {
  const [exact, setExact] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelled = useRef(false);

  function open() {
    cancelled.current = false;
    setDraft(String(value));
    setExact(true);
  }
  function close() {
    setExact(false);
    if (cancelled.current || draft.trim() === "") return;
    const next = Number(draft);
    editing.change(next);
    editing.commit();
  }

  return (
    <GestureScope
      editing={editing}
      onKeyDownCapture={(event) => {
        if (
          event.key === "Enter" &&
          (event.target as HTMLElement).getAttribute("role") === "slider"
        ) {
          event.preventDefault();
          event.stopPropagation();
          open();
        }
      }}
    >
      <div onDoubleClick={open}>
        <Slider
          label={control.label}
          value={value}
          min={control.min}
          max={control.max}
          step={control.step ?? inferStep(control.min, control.max)}
          unit={control.unit}
          onChange={editing.change}
        />
      </div>
      {exact ? (
        <input
          className="ri-dial-exact"
          type="text"
          inputMode="decimal"
          autoFocus
          aria-label={`${control.label} exact value`}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={close}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelled.current = true;
              event.currentTarget.blur();
            }
          }}
        />
      ) : null}
    </GestureScope>
  );
}

const SPRING_FIELDS = [
  { key: "stiffness", label: "Stiffness", range: [1, 1000], step: 1 },
  { key: "damping", label: "Damping", range: [1, 100], step: 0.5 },
  { key: "mass", label: "Mass", range: [0.1, 10], step: 0.1 },
] as const;

function SpringEditor({
  control,
  value,
  editing,
}: {
  control: SpringControl;
  value: SpringValue;
  editing: Editing;
}) {
  const mass = value.mass ?? 1;
  return (
    <Folder title={control.label} defaultOpen>
      <GestureScope editing={editing}>
        <SpringVisualization
          spring={{
            type: "spring",
            stiffness: value.stiffness,
            damping: value.damping,
            mass,
          }}
          isSimpleMode={false}
        />
        {SPRING_FIELDS.map((field) => {
          const current = field.key === "mass" ? mass : value[field.key];
          const [min, max] = displayRange(
            control.ranges?.[field.key] ?? field.range,
            current,
          );
          return (
            <Slider
              key={field.key}
              label={field.label}
              value={current}
              min={min}
              max={max}
              step={field.step}
              onChange={(next) => editing.change({ ...value, [field.key]: next })}
            />
          );
        })}
      </GestureScope>
    </Folder>
  );
}

const BEZIER_FIELDS = [
  { label: "x1", range: [0, 1] },
  { label: "y1", range: [-1, 2] },
  { label: "x2", range: [0, 1] },
  { label: "y2", range: [-1, 2] },
] as const;

function BezierEditor({
  control,
  value,
  editing,
}: {
  control: BezierControl;
  value: CubicBezier;
  editing: Editing;
}) {
  return (
    <Folder title={control.label} defaultOpen>
      <GestureScope editing={editing}>
        <EasingVisualization
          easing={{ type: "easing", duration: 0.3, ease: value }}
          onChange={(ease) => editing.change([...ease] as CubicBezier)}
        />
        {BEZIER_FIELDS.map((field, index) => {
          const [min, max] = displayRange(field.range, value[index]);
          return (
            <Slider
              key={field.label}
              label={field.label}
              value={value[index]}
              min={min}
              max={max}
              step={0.01}
              onChange={(next) => {
                const updated = [...value] as CubicBezier;
                updated[index] = next;
                editing.change(updated);
              }}
            />
          );
        })}
      </GestureScope>
    </Folder>
  );
}

/** Display ranges widen to include the current value, so a slider never misrepresents it. */
function displayRange(
  range: readonly [number, number],
  current: number,
): [number, number] {
  return [Math.min(range[0], current), Math.max(range[1], current)];
}

function inferStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span >= 100) return 1;
  if (span >= 10) return 0.1;
  return 0.01;
}

function formatFrozen(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
