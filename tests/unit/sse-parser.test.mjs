import { describe, expect, it } from "vitest";
import { parseSseBlock } from "../../scripts/opencode-companion.mjs";

describe("parseSseBlock", () => {
  it("parses valid JSON data events", () => {
    expect(parseSseBlock('data: {"payload":"ok"}')).toEqual({
      done: false,
      payload: { payload: "ok" }
    });
  });

  it("returns done true for [DONE]", () => {
    expect(parseSseBlock("data: [DONE]")).toEqual({
      done: true,
      payload: "[DONE]"
    });
  });

  it("returns null for an empty block", () => {
    expect(parseSseBlock("")).toBeNull();
  });

  it("skips non-data lines", () => {
    expect(parseSseBlock('id: 7\nevent: message\ndata: {"hello":"world"}')).toEqual({
      done: false,
      payload: { hello: "world" }
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseSseBlock("data: {not-json}")).toBeNull();
  });
});
