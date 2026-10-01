import { useEffect } from "react";
import type { RuntimeProbeDescriptor, RuntimeProbeValue } from "@runtime-inspector/protocol";
import { registerRuntimeProbe, type RuntimeProbeSource } from "./recording";

export interface RuntimeProbeOptions {
  label?: string;
  group?: string;
  unit?: string;
}

export function useRuntimeProbe(
  schemaId: string,
  id: string,
  source: RuntimeProbeSource,
  options: RuntimeProbeOptions = {}
) {
  const initialValue = source.value as RuntimeProbeValue;
  const valueType = typeof initialValue === "boolean" ? "boolean" : "number";
  const descriptor: RuntimeProbeDescriptor = {
    id,
    valueType,
    ...(options.label ? { label: options.label } : {}),
    ...(options.group ? { group: options.group } : {}),
    ...(options.unit ? { unit: options.unit } : {})
  };

  useEffect(
    () => registerRuntimeProbe(schemaId, descriptor, source),
    [schemaId, id, source, options.label, options.group, options.unit]
  );
}
