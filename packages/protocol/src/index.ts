import { z } from "zod";

export const RIP_VERSION = "0.1";

export type RuntimeRole = "runtime";
export type PanelRole = "panel";
export type RIPRole = RuntimeRole | PanelRole;

export interface HandshakeHello {
  type: "handshake.hello";
  protocolVersion: string;
  role: RIPRole;
  clientId: string;
  clientName?: string;
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

export type InspectorControl =
  | SliderControl
  | ToggleControl
  | ColorControl
  | BezierControl
  | SpringControl;

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
  | ErrorMessage;

const roleSchema = z.union([z.literal("runtime"), z.literal("panel")]);

export const HandshakeHelloSchema = z.object({
  type: z.literal("handshake.hello"),
  protocolVersion: z.string(),
  role: roleSchema,
  clientId: z.string().min(1),
  clientName: z.string().optional()
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

export const SliderControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("slider"),
  defaultValue: z.number(),
  value: z.number().optional(),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
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
  z.number(),
  z.number(),
  z.number(),
  z.number()
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
  damping: z.number(),
  stiffness: z.number(),
  mass: z.number().optional()
});

export const SpringControlSchema = z.object({
  ...baseControlSchema,
  kind: z.literal("spring"),
  defaultValue: SpringValueSchema,
  value: SpringValueSchema.optional(),
  ranges: z
    .object({
      damping: z.tuple([z.number(), z.number()]).optional(),
      stiffness: z.tuple([z.number(), z.number()]).optional(),
      mass: z.tuple([z.number(), z.number()]).optional()
    })
    .optional()
});

export const InspectorControlSchema = z.discriminatedUnion("kind", [
  SliderControlSchema,
  ToggleControlSchema,
  ColorControlSchema,
  BezierControlSchema,
  SpringControlSchema
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
  timestamp: z.number().optional()
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
  ErrorMessageSchema
]);

export function parseRIPMessage(input: unknown): RIPMessage {
  return RIPMessageSchema.parse(input) as RIPMessage;
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
