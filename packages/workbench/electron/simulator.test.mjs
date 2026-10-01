import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenSimulatorDevices,
  normalizeSimulatorDeviceCrop,
  runtimeLabel
} from "./simulator.mjs";

test("runtimeLabel renders CoreSimulator iOS ids", () => {
  assert.equal(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-3"), "iOS 26.3");
});

test("flattenSimulatorDevices keeps available iOS devices and prioritizes booted/newer runtimes", () => {
  const devices = flattenSimulatorDevices({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-25-4": [
        {
          udid: "OLD",
          name: "iPhone 16 Pro",
          state: "Shutdown",
          isAvailable: true
        }
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
        {
          udid: "BOOTED",
          name: "iPhone 17 Pro Max",
          state: "Booted",
          isAvailable: true
        },
        {
          udid: "HIDDEN",
          name: "Unavailable Phone",
          state: "Shutdown",
          isAvailable: false
        }
      ],
      "com.apple.CoreSimulator.SimRuntime.tvOS-26-0": [
        {
          udid: "TV",
          name: "Apple TV",
          state: "Booted",
          isAvailable: true
        }
      ]
    }
  });

  assert.deepEqual(
    devices.map((device) => [device.udid, device.runtime, device.state]),
    [
      ["BOOTED", "iOS 26.3", "Booted"],
      ["OLD", "iOS 25.4", "Shutdown"]
    ]
  );
});

test("normalizeSimulatorDeviceCrop maps the AX device group into window-relative coordinates", () => {
  const crop = normalizeSimulatorDeviceCrop(
    {
      windowX: 100,
      windowY: 60,
      windowWidth: 500,
      windowHeight: 900,
      groupX: 205,
      groupY: 120,
      groupWidth: 290,
      groupHeight: 628
    },
    290 / 628
  );

  assert.ok(crop);
  assert.equal(crop.source, "accessibility");
  assert.ok(Math.abs(crop.x - 0.21) < 0.001);
  assert.ok(Math.abs(crop.y - 0.0666666667) < 0.001);
  assert.ok(Math.abs(crop.width - 0.58) < 0.001);
  assert.ok(Math.abs(crop.height - 0.6977777778) < 0.001);
});

test("normalizeSimulatorDeviceCrop rejects groups with the wrong aspect ratio", () => {
  const crop = normalizeSimulatorDeviceCrop(
    {
      windowX: 0,
      windowY: 0,
      windowWidth: 500,
      windowHeight: 900,
      groupX: 20,
      groupY: 20,
      groupWidth: 450,
      groupHeight: 300
    },
    0.46
  );

  assert.equal(crop, undefined);
});
