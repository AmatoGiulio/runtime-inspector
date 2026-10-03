// Development-only demo runtime: connects to the local broker as a runtime and
// imitates the example app's product reveal so the Workbench UI can be
// developed in a browser without a Simulator. A second connection publishes the
// reserved `scenes` schema (RFC 0006) and answers scene opens.
import { RIP_VERSION } from "@runtime-inspector/protocol";
import {
  AUTO_SCHEMA_ID,
  DEMO_SCENES,
  REPLAY_CONTROL_ID,
  SCENES_SCHEMA_ID,
  createDemoState,
  likeBurstEvents,
  scenesSchema
} from "./demo-runtime-model.mjs";

const BROKER_URL = process.env.RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const CLIENT_ID = "demo-runtime-auto";
const SCENES_CLIENT_ID = "demo-runtime-scenes";
const RECONNECT_MS = 1000;
const NAVIGATION_MS = 300;

let stopping = false;
let replaySeed = 0;
let activeSceneId = "product-reveal";
const sockets = new Set();
const timers = new Set();
const state = createDemoState();

function log(line) {
  console.log(`[demo-runtime] ${line}`);
}

function later(delayMs, callback) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delayMs);
  timers.add(timer);
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** One runtime connection: handshake, publish `schema()` once accepted, hand every other message to `onMessage`. */
function connect({ clientId, clientName, schema, onMessage }) {
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
        clientId,
        clientName
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
      log(`connected ${clientId} -> ${BROKER_URL}`);
      const current = schema();
      send(socket, { type: "schema.publish", schema: current });
      log(`published schema "${current.id}" (${clientId})`);
      return;
    }
    onMessage(socket, message);
  };

  socket.onclose = () => {
    sockets.delete(socket);
    if (stopping) return;
    later(RECONNECT_MS, () => connect({ clientId, clientName, schema, onMessage }));
  };

  socket.onerror = () => {
    // onclose follows and schedules the reconnect.
  };
}

function emit(socket, events) {
  for (const { delayMs, message } of events) {
    later(delayMs, () => send(socket, message));
  }
}

function replay(socket) {
  replaySeed += 1;
  const events = state.replayEvents({ nowMs: performance.now(), instanceSeed: replaySeed });
  log(`replay #${replaySeed}: ${events.length} animation.started messages`);
  emit(socket, events);
}

/** The scene is on screen: report `playing`, then emit its motion. */
function playScene(socket, sceneId) {
  replaySeed += 1;
  const nowMs = performance.now();
  send(socket, { type: "scene.status", sceneId, phase: "playing", atRuntimeMs: nowMs });
  const events =
    sceneId === "like-burst"
      ? likeBurstEvents({ nowMs, instanceSeed: replaySeed })
      : state.replayEvents({ nowMs, instanceSeed: replaySeed });
  log(`scene "${sceneId}" #${replaySeed}: ${events.length} animation.started messages`);
  emit(socket, events);
}

function openScene(socket, sceneId) {
  if (!DEMO_SCENES.some((scene) => scene.id === sceneId)) return;
  if (sceneId === activeSceneId) {
    playScene(socket, sceneId);
    return;
  }
  send(socket, {
    type: "scene.status",
    sceneId,
    phase: "navigating",
    atRuntimeMs: performance.now()
  });
  later(NAVIGATION_MS, () => {
    activeSceneId = sceneId;
    // Republished in place on the same socket, like the runtime SDK.
    send(socket, { type: "schema.publish", schema: scenesSchema(activeSceneId) });
    playScene(socket, sceneId);
  });
}

connect({
  clientId: CLIENT_ID,
  clientName: "Demo Runtime",
  schema: () => state.schema(),
  onMessage(socket, message) {
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
  }
});

connect({
  clientId: SCENES_CLIENT_ID,
  clientName: "Demo Runtime Scenes",
  schema: () => scenesSchema(activeSceneId),
  onMessage(socket, message) {
    if (message.type === "control.trigger" && message.schemaId === SCENES_SCHEMA_ID) {
      openScene(socket, message.controlId);
    }
  }
});

process.on("SIGINT", () => {
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.close();
  log("stopped");
  setTimeout(() => process.exit(0), 50);
});
