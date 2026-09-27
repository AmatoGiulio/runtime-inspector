import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createPanelSession } from "@runtime-inspector/panel-core";
import { InspectorPanel } from "@runtime-inspector/panel-dialkit";
import "@runtime-inspector/panel-dialkit/styles.css";
import "./styles.css";

const brokerUrl = import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const panelToken =
  new URLSearchParams(window.location.search).get("token") ?? import.meta.env.VITE_RI_TOKEN;

const session = createPanelSession({
  url: brokerUrl,
  token: panelToken,
  clientId: "panel-web"
});
session.connect();

function App() {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  return (
    <main className="shell">
      <InspectorPanel
        session={session}
        state={state}
        theme="dark"
        canApplySource
        emptyHint="Start the app with Runtime Inspector enabled. Controls appear here as soon as it publishes a schema."
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
