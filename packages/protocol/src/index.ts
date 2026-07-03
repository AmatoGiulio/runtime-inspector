import { z } from "zod";

export const RIP_VERSION = "0.3";

export type RuntimeRole = "runtime";
export type PanelRole = "panel";
export type RIPRole = RuntimeRole | PanelRole;

export interface HandshakeHello {
  type: "handshake.hello";
  protocolVersion: string;
  role: RIPRole;
  clientId: string;
  clientName?: string;
  token?: string;
}

export interface HandshakeAccept {
  type: "handshake.accept";
  protocolVersion: string;
  brokerId: string;
  clientId: string;
}

export interface BaseControl<TKind extends string, TValue> {
  id: string;
  kind: TKind;
  label: string;
  description?: string;
  defaultValue: TValue;
  value?: TValue;
  binding?: string;
}

export interface SliderControl extends BaseControl<"slider", number> {
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

export interface ToggleControl extends BaseControl<"toggle", boolean> {}

export interface ColorControl extends BaseControl<"color", string> {
  format?: "hex" | "rgba";
}

export type CubicBezier = [number, number, number, number];

export interface BezierControl extends BaseControl<"bezier", CubicBezier> {
  presets?: Array<{ label: string; value: CubicBezier }>;
}

export interface SpringValue {
  damping: number;
  stiffness: number;
  mass?: number;
}

export interface SpringControl extends BaseControl<"spring", SpringValue> {
  ranges?: {
    damping?: [number, number];
    stiffness?: [number, number];
    mass?: [number, number];
  };
}

export interface TriggerControl {
  id: string;
  kind: "trigger";
  label: string;
  description?: string;
  binding?: string;
}

export type InspectorControl =
  | SliderControl
  | ToggleControl
  | ColorControl
  | BezierControl
  | SpringControl
  | TriggerControl;

export type ValueControl = Exclude<InspectorControl, TriggerControl>;

export function isValueControl(control: InspectorControl): control is ValueControl {
  return control.kind !== "trigger";
}

export interface ControlGroup {
  id: string;
  label: string;
  description?: string;
  controls: InspectorControl[];
}

export interface PanelSchema {
  id: string;
  title: string;
  description?: string;
  version?: string;
  groups: ControlGroup[];
}

export interface ControlPatch {
  type: "control.patch";
  schemaId: string;
  controlId: string;
  value: unknown;
  source?: "panel" | "runtime" | "preset";
  timestamp?: number;
}

export interface BatchPatch {
  type: "control.batchPatch";
  schemaId: string;
  patches: Array<Omit<ControlPatch, "type" | "schemaId">>;
  source?: "panel" | "runtime" | "preset";
  timestamp?: number;
  committed?: boolean;
}

export interface ControlTrigger {
  type: "control.trigger";
  schemaId: string;
  controlId: string;
  source?: "panel" | "runtime" | "preset";
  timestamp?: number;
}

export interface ControlCommit {
  type: "control.commit";
  schemaId: string;
  controlId: string;
  value: unknown;
  source?: "panel" | "runtime" | "preset";
  timestamp?: number;
}

export interface SchemaDispose {
  type: "schema.dispose";
  schemaId: string;
  source?: "runtime";
}

export interface PresetExport {
  schemaId: string;
  schemaVersion?: string;
  name: string;
  exportedAt: string;
  values: Record<string, unknown>;
}

export interface SchemaMessage {
  type: "schema.publish";
  schema: PanelSchema;
}

export interface RuntimeStatusMessage {
  type: "runtime.status";
  online: boolean;
  clientId?: string;
  schemaId?: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
  cause?: unknown;
}

export type RIPMessage =
  | HandshakeHello
  | HandshakeAccept
  | SchemaMessage
  | ControlPatch
  | BatchPatch
  | ControlTrigger
  | ControlCommit
  | SchemaDispose
  | RuntimeStatusMessage
  | ErrorMessage;

const roleSchema = z.union([z.literal("runtime"), z.literal("panel")]);

export const HandshakeHelloSchema = z.object({
  type: z.literal("handshake.hello"),
  protocolVersion: z.string(),
  role: roleSchema,
  clientId: z.string().min(1),
  clientName: z.string().optional(),
  token: z.string().optional()
});

export const HandshakeAcceptSchema = z.object({
  type: z.literal("handshake.accept"),
  protocolVersion: z.string(),
  brokerId: z.string().min(1),
  clientId: z.string().min(1)
});

const baseControlSchema = {
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  binding: z.string().optional()
};

const finiteNumberSchema = z.number().finite();

export const SliderControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("slider"),
  defaultValue: finiteNumberSchema,
  value: finiteNumberSchema.optional(),
  min: finiteNumberSchema,
  max: finiteNumberSchema,
  step: finiteNumberSchema.positive().optional(),
  unit: z.string().optional()
});

export const ToggleControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("toggle"),
  defaultValue: z.boolean(),
  value: z.boolean().optional()
});

export const ColorControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("color"),
  defaultValue: z.string(),
  value: z.string().optional(),
  format: z.union([z.literal("hex"), z.literal("rgba")]).optional()
});

export const CubicBezierSchema = z.tuple([
  finiteNumberSchema,
  finiteNumberSchema,
  finiteNumberSchema,
  finiteNumberSchema
]);

export const BezierControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("bezier"),
  defaultValue: CubicBezierSchema,
  value: CubicBezierSchema.optional(),
  presets: z
    .array(z.object({ label: z.string(), value: CubicBezierSchema }))
    .optional()
});

export const SpringValueSchema = z.object({
  damping: finiteNumberSchema,
  stiffness: finiteNumberSchema,
  mass: finiteNumberSchema.optional()
});

export const SpringControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("spring"),
  defaultValue: SpringValueSchema,
  value: SpringValueSchema.optional(),
  ranges: z
    .object({
      damping: z.tuple([finiteNumberSchema, finiteNumberSchema]).optional(),
      stiffness: z.tuple([finiteNumberSchema, finiteNumberSchema]).optional(),
      mass: z.tuple([finiteNumberSchema, finiteNumberSchema]).optional()
    })
    .optional()
});

export const TriggerControlSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("trigger"),
  label: z.string().min(1),
  description: z.string().optional(),
  binding: z.string().optional()
});

export const InspectorControlSchema = z.discriminatedUnion("kind", [
  SliderControlSchema,
  ToggleControlSchema,
  ColorControlSchema,
  BezierControlSchema,
  SpringControlSchema,
  TriggerControlSchema
]);

export const ControlGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  controls: z.array(InspectorControlSchema)
});

export const PanelSchemaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  groups: z.array(ControlGroupSchema)
});

export const ControlPatchSchema = z.object({
  type: z.literal("control.patch"),
  schemaId: z.string().min(1),
  controlId: z.string().min(1),
  value: z.unknown(),
  source: z.union([z.literal("panel"), z.literal("runtime"), z.literal("preset")]).optional(),
  timestamp: z.number().optional()
});

export const BatchPatchSchema = z.object({
  type: z.literal("control.batchPatch"),
  schemaId: z.string().min(1),
  patches: z.array(
    z.object({
      controlId: z.string().min(1),
      value: z.unknown(),
      source: z.union([z.literal("panel"), z.literal("runtime"), z.literal("preset")]).optional(),
      timestamp: z.number().optional()
    })
  ),
  source: z.union([z.literal("panel"), z.literal("runtime"), z.literal("preset")]).optional(),
  timestamp: z.number().optional(),
  committed: z.boolean().optional()
});

export const ControlTriggerSchema = z.object({
  type: z.literal("control.trigger"),
  schemaId: z.string().min(1),
  controlId: z.string().min(1),
  source: z.union([z.literal("panel"), z.literal("runtime"), z.literal("preset")]).optional(),
  timestamp: z.number().optional()
});

export const ControlCommitSchema = z.object({
  type: z.literal("control.commit"),
  schemaId: z.string().min(1),
  controlId: z.string().min(1),
  value: z.unknown(),
  source: z.union([z.literal("panel"), z.literal("runtime"), z.literal("preset")]).optional(),
  timestamp: z.number().optional()
});

export const SchemaDisposeSchema = z.object({
  type: z.literal("schema.dispose"),
  schemaId: z.string().min(1),
  source: z.literal("runtime").optional()
});

export const PresetExportSchema = z.object({
  schemaId: z.string().min(1),
  schemaVersion: z.string().optional(),
  name: z.string().min(1),
  exportedAt: z.string(),
  values: z.record(z.unknown())
});

export const SchemaMessageSchema = z.object({
  type: z.literal("schema.publish"),
  schema: PanelSchemaSchema
});

export const RuntimeStatusMessageSchema = z.object({
  type: z.literal("runtime.status"),
  online: z.boolean(),
  clientId: z.string().optional(),
  schemaId: z.string().optional()
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  cause: z.unknown().optional()
});

export const RIPMessageSchema = z.discriminatedUnion("type", [
  HandshakeHelloSchema,
  HandshakeAcceptSchema,
  SchemaMessageSchema,
  ControlPatchSchema,
  BatchPatchSchema,
  ControlTriggerSchema,
  ControlCommitSchema,
  SchemaDisposeSchema,
  RuntimeStatusMessageSchema,
  ErrorMessageSchema
]);

function checkStructuralRequirements(input: unknown): void {
  if (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    (input as { type: unknown }).type === "control.commit" &&
    !Object.prototype.hasOwnProperty.call(input, "value")
  ) {
    throw new Error("control.commit requires a value field");
  }
}

export function parseRIPMessage(input: unknown): RIPMessage {
  checkStructuralRequirements(input);
  return RIPMessageSchema.parse(input) as RIPMessage;
}

export function safeParseRIPMessage(data: unknown): RIPMessage | undefined {
  try {
    const raw = typeof data === "string" ? data : String(data);
    const parsed = JSON.parse(raw);
    checkStructuralRequirements(parsed);
    return RIPMessageSchema.parse(parsed) as RIPMessage;
  } catch {
    return undefined;
  }
}

export type ValidationErrorCode =
  | "WRONG_TYPE"
  | "OUT_OF_RANGE"
  | "MALFORMED_VALUE"
  | "UNKNOWN_KIND";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; message: string };

const VALID: ValidationResult = { ok: true };

function invalid(code: ValidationErrorCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

/**
 * Single source of truth for control value validation. Returns a structured
 * result describing *why* a value is invalid, not just whether it is.
 */
export function validateControlValue(control: InspectorControl, value: unknown): ValidationResult {
  const got = typeof value === "string" ? `string` : typeof value;
  switch (control.kind) {
    case "slider": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return invalid(
          "WRONG_TYPE",
          `slider "${control.id}" expects a finite number between ${control.min} and ${control.max}, got ${JSON.stringify(value)}`
        );
      }
      if (
        (typeof control.min === "number" && value < control.min) ||
        (typeof control.max === "number" && value > control.max)
      ) {
        return invalid(
          "OUT_OF_RANGE",
          `slider "${control.id}" expects a finite number between ${control.min} and ${control.max}, got ${JSON.stringify(value)}`
        );
      }
      return VALID;
    }
    case "toggle":
      if (typeof value !== "boolean") {
        return invalid("WRONG_TYPE", `toggle "${control.id}" expects a boolean, got ${got}`);
      }
      return VALID;
    case "color":
      if (typeof value !== "string") {
        return invalid("WRONG_TYPE", `color "${control.id}" expects a string, got ${got}`);
      }
      return VALID;
    case "bezier": {
      if (!Array.isArray(value)) {
        return invalid(
          "WRONG_TYPE",
          `bezier "${control.id}" expects a 4-tuple of finite numbers, got ${JSON.stringify(value)}`
        );
      }
      if (value.length !== 4) {
        return invalid(
          "MALFORMED_VALUE",
          `bezier "${control.id}" expects a 4-tuple of finite numbers, got ${JSON.stringify(value)} (wrong length)`
        );
      }
      if (!value.every((part) => typeof part === "number" && Number.isFinite(part))) {
        return invalid(
          "MALFORMED_VALUE",
          `bezier "${control.id}" expects a 4-tuple of finite numbers, got ${JSON.stringify(value)} (contains a non-finite value)`
        );
      }
      return VALID;
    }
    case "spring": {
      const parsed = SpringValueSchema.safeParse(value);
      if (!parsed.success) {
        return invalid(
          "MALFORMED_VALUE",
          `spring "${control.id}" expects an object with finite damping/stiffness (and optional finite mass), got ${JSON.stringify(value)}`
        );
      }
      const { damping, stiffness, mass } = parsed.data;
      if (
        !Number.isFinite(damping) ||
        !Number.isFinite(stiffness) ||
        (mass !== undefined && !Number.isFinite(mass))
      ) {
        return invalid(
          "MALFORMED_VALUE",
          `spring "${control.id}" expects an object with finite damping/stiffness (and optional finite mass), got ${JSON.stringify(value)} (contains a non-finite field)`
        );
      }
      return VALID;
    }
    case "trigger":
      return VALID;
    default:
      return invalid(
        "UNKNOWN_KIND",
        `control "${(control as { id: string }).id}" has an unknown kind and cannot be validated`
      );
  }
}

export function isValidControlValue(control: InspectorControl, value: unknown): boolean {
  return validateControlValue(control, value).ok;
}

export function describeInvalidValue(control: InspectorControl, value: unknown): string {
  const result = validateControlValue(control, value);
  if (result.ok) {
    return `control "${control.id}" has a valid value`;
  }
  return result.message;
}

export function createPatch(
  schemaId: string,
  controlId: string,
  value: unknown
): ControlPatch {
  return {
    type: "control.patch",
    schemaId,
    controlId,
    value,
    source: "panel",
    timestamp: Date.now()
  };
}

export function createTrigger(schemaId: string, controlId: string): ControlTrigger {
  return {
    type: "control.trigger",
    schemaId,
    controlId,
    source: "panel",
    timestamp: Date.now()
  };
}

export function createCommit(
  schemaId: string,
  controlId: string,
  value: unknown
): ControlCommit {
  return {
    type: "control.commit",
    schemaId,
    controlId,
    value,
    source: "panel",
    timestamp: Date.now()
  };
}
