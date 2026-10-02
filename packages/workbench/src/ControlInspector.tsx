import type { PanelSession } from "@runtime-inspector/panel-core";
import type { InspectorControl } from "@runtime-inspector/protocol";
import { InspectorControlRow } from "@runtime-inspector/panel-dialkit";
import { DialKitScope } from "./DialKitScope";

interface ControlInspectorProps {
  schemaId: string;
  control: InspectorControl;
  value: unknown;
  stale: boolean;
  session: Pick<PanelSession, "setValue" | "commitValue" | "fireTrigger">;
  onApplySource(): void;
}

export function ControlInspector({
  schemaId,
  control,
  value,
  stale,
  session,
  onApplySource
}: ControlInspectorProps) {
  const sourceBacked = "source" in control && Boolean(control.source);

  return (
    <div className="control-inspector">
      <div className="control-inspector-head">
        <div>
          <div className="control-inspector-name">{control.label}</div>
          <div className="control-inspector-kind">{control.kind}</div>
        </div>
        {stale ? <span className="control-stale">stale</span> : null}
      </div>

      {control.description ? (
        <div className="control-description">{control.description}</div>
      ) : null}

      <div className="control-editor">
        <DialKitScope>
          <InspectorControlRow
            session={session}
            schemaId={schemaId}
            control={control}
            value={value}
            disabled={stale}
            onApplyToCode={
              control.kind !== "trigger" && sourceBacked ? onApplySource : undefined
            }
          />
        </DialKitScope>
      </div>

      <div className="control-meta">
        <Meta label="Binding" value={control.binding ?? "—"} />
        {"unit" in control ? <Meta label="Unit" value={control.unit ?? "—"} /> : null}
        <Meta label="Source" value={sourceBacked ? "write-back available" : "runtime only"} />
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="control-meta-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
