import { registerRootComponent } from "expo";
// Registers the Runtime Inspector tab in React Native DevTools (dev only; inert without Rozenite).
import "@runtime-inspector/panel-rozenite";
import App from "./App";

registerRootComponent(App);
