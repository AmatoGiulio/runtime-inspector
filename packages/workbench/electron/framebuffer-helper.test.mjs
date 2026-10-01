import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSimulatorFramebufferStatusLine,
  SimulatorFramebufferParser
} from "./framebuffer-helper.mjs";

function frameBuffer({
  payload,
  width = 640,
  height = 1380,
  sequence = 7,
  capturedAtMs = 1_700_000_000_000,
  encodeDurationUs = 4200
}) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x52494642, 0);
  header.writeUInt32BE(body.length, 4);
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  header.writeUInt32BE(sequence, 16);
  header.writeBigUInt64BE(BigInt(capturedAtMs), 20);
  header.writeUInt32BE(encodeDurationUs, 28);
  return Buffer.concat([header, body]);
}

test("SimulatorFramebufferParser decodes fragmented framed JPEG payloads", () => {
  const frames = [];
  const parser = new SimulatorFramebufferParser((frame) => frames.push(frame));
  const encoded = frameBuffer({ payload: [1, 2, 3, 4], sequence: 11 });

  parser.push(encoded.subarray(0, 7));
  parser.push(encoded.subarray(7, 18));
  parser.push(encoded.subarray(18));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].sequence, 11);
  assert.equal(frames[0].width, 640);
  assert.equal(frames[0].height, 1380);
  assert.equal(frames[0].capturedAtMs, 1_700_000_000_000);
  assert.equal(frames[0].encodeDurationUs, 4200);
  assert.deepEqual([...frames[0].bytes], [1, 2, 3, 4]);
});

test("SimulatorFramebufferParser decodes multiple frames in one chunk", () => {
  const frames = [];
  const parser = new SimulatorFramebufferParser((frame) => frames.push(frame));

  parser.push(
    Buffer.concat([
      frameBuffer({ payload: [9], sequence: 1 }),
      frameBuffer({ payload: [8, 7], sequence: 2 })
    ])
  );

  assert.deepEqual(
    frames.map((frame) => frame.sequence),
    [1, 2]
  );
});

test("parseSimulatorFramebufferStatusLine reads SimScreen callback mode", () => {
  assert.deepEqual(
    parseSimulatorFramebufferStatusLine("RI_STATUS:frame-source=simscreen-callbacks"),
    {
      message: "frame-source=simscreen-callbacks",
      frameSource: "simscreen-callbacks",
      detail: undefined
    }
  );
});

test("parseSimulatorFramebufferStatusLine keeps polling fallback detail", () => {
  assert.deepEqual(
    parseSimulatorFramebufferStatusLine(
      "RI_STATUS:frame-source=seed-polling fallback=SimScreen descriptor unavailable"
    ),
    {
      message: "frame-source=seed-polling fallback=SimScreen descriptor unavailable",
      frameSource: "seed-polling",
      detail: "fallback=SimScreen descriptor unavailable"
    }
  );
});
