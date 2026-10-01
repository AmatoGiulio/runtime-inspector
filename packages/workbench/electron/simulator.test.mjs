import test from "node:test";
import assert from "node:assert/strict";
import { flattenSimulatorDevices, runtimeLabel } from "./simulator.mjs";

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
