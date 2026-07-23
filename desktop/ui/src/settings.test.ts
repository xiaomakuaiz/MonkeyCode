import { describe, expect, it } from "vitest";

import { modelsToConfig } from "./settings";
import type { HostModel } from "./types";

describe("modelsToConfig", () => {
  it("persists only fields supported by the engine schema", () => {
    const legacy = {
      name: "  local  ",
      provider: "anthropic",
      base_url: "https://gateway.test",
      api_key: "secret",
      model: "model-1",
      context_window: 42,
      vision: true,
      source: "baizhi",
      skip_tls_verify: true,
    } as HostModel & { skip_tls_verify: boolean };

    const [saved] = modelsToConfig([legacy], 0);

    expect(saved).toEqual({
      name: "local",
      provider: "anthropic",
      base_url: "https://gateway.test",
      api_key: "secret",
      model: "model-1",
      default: true,
      context_window: 42,
      vision: true,
      source: "baizhi",
    });
    expect(saved).not.toHaveProperty("skip_tls_verify");
  });
});
