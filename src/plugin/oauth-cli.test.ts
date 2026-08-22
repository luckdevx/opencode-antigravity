import { describe, expect, it } from "vitest";

import {
  extractOAuthCallbackParams,
  getStateFromAuthorizationUrl,
  parseOAuthCallbackInput,
} from "./oauth-cli";

describe("oauth-cli helpers", () => {
  describe("getStateFromAuthorizationUrl", () => {
    it("extracts state parameter from valid URL", () => {
      const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=xyz&state=state-12345&scope=foo";
      expect(getStateFromAuthorizationUrl(url)).toBe("state-12345");
    });

    it("returns empty string when state is missing", () => {
      const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=xyz";
      expect(getStateFromAuthorizationUrl(url)).toBe("");
    });

    it("returns empty string for invalid URL", () => {
      expect(getStateFromAuthorizationUrl("not-a-url")).toBe("");
    });
  });

  describe("extractOAuthCallbackParams", () => {
    it("extracts code and state from URL", () => {
      const url = new URL("http://localhost:8085/?code=4/0AX4XfWh&state=expected-state");
      expect(extractOAuthCallbackParams(url)).toEqual({
        code: "4/0AX4XfWh",
        state: "expected-state",
      });
    });

    it("returns null when code is missing", () => {
      const url = new URL("http://localhost:8085/?state=expected-state");
      expect(extractOAuthCallbackParams(url)).toBeNull();
    });

    it("returns null when state is missing", () => {
      const url = new URL("http://localhost:8085/?code=4/0AX4XfWh");
      expect(extractOAuthCallbackParams(url)).toBeNull();
    });
  });

  describe("parseOAuthCallbackInput", () => {
    it("parses full callback URL", () => {
      const result = parseOAuthCallbackInput(
        "http://localhost:8085/?code=auth-code-123&state=state-xyz",
        "fallback-state",
      );
      expect(result).toEqual({ code: "auth-code-123", state: "state-xyz" });
    });

    it("uses fallback state when user pastes bare code", () => {
      const result = parseOAuthCallbackInput("4/0AX4XfWh_simple_code", "fallback-state-999");
      expect(result).toEqual({ code: "4/0AX4XfWh_simple_code", state: "fallback-state-999" });
    });

    it("returns error when empty input is provided", () => {
      const result = parseOAuthCallbackInput("   ", "fallback-state");
      expect(result).toEqual({ error: "Missing authorization code" });
    });

    it("returns error when user pastes bare code but fallback state is missing", () => {
      const result = parseOAuthCallbackInput("4/0AX4XfWh_simple_code", "");
      expect(result).toHaveProperty("error");
    });
  });
});
