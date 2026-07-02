import { startBroker } from "./index.js";

const broker = startBroker();

console.log(
  `Runtime Inspector broker listening on ws://${broker.host}:${broker.port}`
);
