import { useEffect, useState } from "react";
import { useRozeniteDevToolsClient } from "@rozenite/plugin-bridge";
import {
  createPanelSession,
  type PanelSession,
  type PanelState
} from "@runtime-inspector/panel-core";
import { InspectorPanel } from "@runtime-inspector/panel-dialkit";
import "@runtime-inspector/panel-dialkit/styles.css";
import {
  RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
  type RuntimeInspectorRozeniteEvents
} from "./shared";
import { createRozenitePanelSocket } from "./transport";
import "./styles.css";

export default function RuntimeInspectorPanel() {
  const client = useRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>({
    pluginId: RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID
  });
  const [session, setSession] = useState<PanelSession | null>(null);
  const [state, setState] = useState<PanelState | null>(null);

  useEffect(() => {
    if (!client) return;
    const nextSession = createPanelSession({
      url: "rozenite://runtime-inspector",
      clientId: "runtime-inspector-rozenite-panel",
      createSocket: () => createRozenitePanelSocket(client)
    });
    setSession(nextSession);
    setState(nextSession.getState());
    const unsubscribe = nextSession.subscribe(() => setState(nextSession.getState()));
    nextSession.connect();

    return () => {
      unsubscribe();
      nextSession.dispose();
      setSession(null);
      setState(null);
    };
  }, [client]);

  return (
    <main className="ri-shell">
      {session && state ? (
        // No broker on this transport, so no workspace can receive source.apply.
        <InspectorPanel session={session} state={state} theme="system" />
      ) : (
        <div className="ri-connecting">Connecting to the React Native app…</div>
      )}
    </main>
  );
}
