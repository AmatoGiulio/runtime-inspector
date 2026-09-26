import { useRef } from "react";
import { Slider, Toggle, ColorControl } from "dialkit";
import type { PanelSession } from "@runtime-inspector/panel-core";
import {
  validateControlValue,
  type InspectorControl,
  type SpringValue,
  type CubicBezier,
} from "@runtime-inspector/protocol";

export interface InspectorControlProps {
  session: Pick<PanelSession, "setValue" | "commitValue" | "fireTrigger">;
  schemaId: string;
  control: InspectorControl;
  value: unknown;
  disabled: boolean;
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

function Control({
  session,
  schemaId,
  control,
  value,
  disabled,
}: InspectorControlProps) {
  const dirty = useRef(false);
  const current =
    value ?? ("defaultValue" in control ? control.defaultValue : undefined);
  function change(next: unknown) {
    if (disabled) return;
    session.setValue(schemaId, control.id, next);
    dirty.current = validateControlValue(control, next).ok;
  }
  function commit() {
    if (disabled || !dirty.current) return;
    dirty.current = false;
    session.commitValue(schemaId, control.id);
  }
  function discrete(next: unknown) {
    change(next);
    commit();
  }

  // DialKit components have no disabled prop. Unmounting is necessary: inert alone
  // does not cover ColorControl's imperative popover or an active pointer drag.
  if (disabled)
    return (
      <div className="ri-dial-control ri-dial-frozen" aria-disabled="true">
        <strong>{control.label}</strong>
        <output>
          {control.kind === "trigger"
            ? "Unavailable while stale"
            : JSON.stringify(current)}
        </output>
      </div>
    );

  let editor;
  switch (control.kind) {
    case "slider":
      editor = (
        <div
          onKeyDownCapture={(event) => {
            if (
              event.key === "Enter" &&
              (event.target as HTMLElement).getAttribute("role") === "slider"
            ) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget
                .querySelector<HTMLInputElement>(".ri-dial-exact input")
                ?.focus();
            }
          }}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
          onBlur={commit}
        >
          <Slider
            label={control.label}
            value={current as number}
            min={control.min}
            max={control.max}
            step={control.step ?? 0.01}
            unit={control.unit}
            onChange={change}
          />
          <label className="ri-dial-exact">
            Exact value
            <input
              type="number"
              aria-label={`${control.label} exact value`}
              step="any"
              value={current as number}
              onChange={(event) => {
                if (event.currentTarget.value !== "")
                  change(event.currentTarget.valueAsNumber);
              }}
            />
          </label>
        </div>
      );
      break;
    case "toggle":
      editor = (
        <Toggle
          label={control.label}
          checked={current as boolean}
          onChange={discrete}
        />
      );
      break;
    case "color":
      // The picker owns a DOM portal and exposes only onChange, not an end event.
      editor = (
        <ColorControl
          label={control.label}
          value={current as string}
          onChange={discrete}
        />
      );
      break;
    case "trigger":
      editor = (
        <button
          className="ri-dial-trigger"
          type="button"
          onClick={() => session.fireTrigger(schemaId, control.id)}
        >
          {control.label}
          <span>Run</span>
        </button>
      );
      break;
    case "spring": {
      const spring = current as SpringValue;
      editor = (
        <fieldset className="ri-dial-composite">
          <legend>{control.label}</legend>
          {(["damping", "stiffness", "mass"] as const).map((field) => (
            <label key={field}>
              {field}
              <input
                type="number"
                step="any"
                min={control.ranges?.[field]?.[0]}
                max={control.ranges?.[field]?.[1]}
                value={spring[field] ?? 1}
                onChange={(event) => {
                  if (event.currentTarget.value !== "")
                    change({
                      ...spring,
                      [field]: event.currentTarget.valueAsNumber,
                    });
                }}
                onBlur={commit}
                onKeyUp={(event) => {
                  if (event.key === "Enter") commit();
                }}
              />
            </label>
          ))}
        </fieldset>
      );
      break;
    }
    case "bezier": {
      const bezier = current as CubicBezier;
      editor = (
        <fieldset className="ri-dial-composite">
          <legend>{control.label}</legend>
          <BezierPreview value={bezier} />
          {(["x1", "y1", "x2", "y2"] as const).map((field, index) => (
            <label key={field}>
              {field}
              <input
                type="number"
                step="any"
                value={bezier[index]}
                onChange={(event) => {
                  if (event.currentTarget.value === "") return;
                  const next = [...bezier] as CubicBezier;
                  next[index] = event.currentTarget.valueAsNumber;
                  change(next);
                }}
                onBlur={commit}
                onKeyUp={(event) => {
                  if (event.key === "Enter") commit();
                }}
              />
            </label>
          ))}
        </fieldset>
      );
      break;
    }
  }
  return (
    <div className="ri-dial-control dialkit-root" data-theme="dark">
      {editor}
      {control.description ? (
        <p className="ri-dial-description">{control.description}</p>
      ) : null}
    </div>
  );
}

function BezierPreview({ value: [x1, y1, x2, y2] }: { value: CubicBezier }) {
  return (
    <svg
      className="ri-dial-bezier"
      viewBox="0 0 160 100"
      role="img"
      aria-label="Bezier curve preview"
    >
      <line x1="12" y1="88" x2={12 + x1 * 136} y2={88 - y1 * 76} />
      <line x1="148" y1="12" x2={12 + x2 * 136} y2={88 - y2 * 76} />
      <path
        d={`M 12 88 C ${12 + x1 * 136} ${88 - y1 * 76}, ${12 + x2 * 136} ${88 - y2 * 76}, 148 12`}
      />
    </svg>
  );
}
