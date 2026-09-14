import type { RIPMessage } from "@runtime-inspector/protocol";

export const RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID = "@runtime-inspector/panel-rozenite";
export const RIP_EVENT = "runtime-inspector:rip" as const;
export const RUNTIME_READY_EVENT = "runtime-inspector:ready" as const;

export interface RuntimeInspectorRozeniteEvents extends Record<string, unknown> {
  [RIP_EVENT]: { message: RIPMessage };
  [RUNTIME_READY_EVENT]: {
    protocolVersion: string;
    generationId: string;
  };
}
