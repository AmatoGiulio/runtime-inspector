// Development-only demo runtime: connects to the local broker as a runtime and
// imitates the example app's product reveal so the Workbench UI can be
// developed in a browser without a Simulator.
import { RIP_VERSION } from "@runtime-inspector/protocol";
import { AUTO_SCHEMA_ID, REPLAY_CONTROL_ID, createDemoState } from "./demo-runtime-model.mjs";

const BROKER_URL = process.env.RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const CLIENT_ID = "demo-runtime-auto";
const RECONNECT_MS = 1000;

let stopping = false;
let replaySeed = 0;
const sockets = new Set();
const timers = new Set();
const state = createDemoState();

function log(line) {
  console.log(`[demo-runtime] ${line}`);
}

function connect() {
  if (stopping) return;
  const socket = new WebSocket(BROKER_URL);
  sockets.add(socket);
  let published = false;

  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: RIP_VERSION,
        role: "runtime",
        clientId: CLIENT_ID,
        clientName: "Demo Runtime"
      })
    );
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === "handshake.accept" && !published) {
      published = true;
      log(`connected ${CLIENT_ID} -> ${BROKER_URL}`);
      socket.send(JSON.stringify({ type: "schema.publish", schema: state.schema() }));
      log(`published schema "${AUTO_SCHEMA_ID}" (${CLIENT_ID})`);
      return;
    }
    if (
      message.type === "control.trigger" &&
      message.schemaId === AUTO_SCHEMA_ID &&
      message.controlId === REPLAY_CONTROL_ID
    ) {
      replay(socket);
      return;
    }
    // control.patch / control.commit / control.batchPatch: tuned values apply on the next replay.
    state.applyControlMessage(message);
  };

  socket.onclose = () => {
    sockets.delete(socket);
    if (stopping) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      connect();
    }, RECONNECT_MS);
    timers.add(timer);
  };

  socket.onerror = () => {
    // onclose follows and schedules the reconnect.
  };
}

function replay(socket) {
  replaySeed += 1;
  const events = state.replayEvents({ nowMs: performance.now(), instanceSeed: replaySeed });
  log(`replay #${replaySeed}: ${events.length} animation.started messages`);
  for (const { delayMs, message } of events) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }, delayMs);
    timers.add(timer);
  }
}

connect();

process.on("SIGINT", () => {
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.close();
  log("stopped");
  setTimeout(() => process.exit(0), 50);
});
