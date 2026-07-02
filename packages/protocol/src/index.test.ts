import { describe, expect, it } from "vitest";
import {
  PanelSchemaSchema,
  RIP_VERSION,
  createPatch,
  parseRIPMessage
} from "./index";

describe("Runtime Inspector Protocol", () => {
  it("parses a valid slider schema", () => {
    const schema = PanelSchemaSchema.parse({
      id: "card-transition",
      title: "Card Transition",
      groups: [
        {
          id: "motion",
          label: "Motion",
          controls: [
            {
              id: "scale",
              kind: "slider",
              label: "Scale",
              min: 0,
              max: 2,
              defaultValue: 1
            }
          ]
        }
      ]
    });

    expect(schema.groups[0]?.controls[0]?.kind).toBe("slider");
  });

  it("rejects an invalid control kind", () => {
    expect(() =>
      PanelSchemaSchema.parse({
        id: "bad",
        title: "Bad",
        groups: [
          {
            id: "bad",
            label: "Bad",
            controls: [{ id: "bad", kind: "unknown", label: "Bad" }]
          }
        ]
      })
    ).toThrow();
  });

  it("parses handshake and patch messages", () => {
    const hello = parseRIPMessage({
      type: "handshake.hello",
      protocolVersion: RIP_VERSION,
      role: "panel",
      clientId: "panel-test"
    });
    const patch = parseRIPMessage(createPatch("schema", "scale", 1.1));

    expect(hello.type).toBe("handshake.hello");
    expect(patch.type).toBe("control.patch");
  });
});
