import { CardTransitionLab } from "./src/CardTransitionLab";
import { ProductRevealDemo } from "./src/ProductRevealDemo";

/** "demo" is the screen shown in recordings; "lab" is the developer test card used by the viewport benchmark. */
const SCREEN = "demo" as "demo" | "lab";

export default function App() {
  return SCREEN === "demo" ? <ProductRevealDemo /> : <CardTransitionLab />;
}
