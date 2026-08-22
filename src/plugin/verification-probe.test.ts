import { describe, expect, it } from "vitest";

import {
  clearStoredAccountVerificationRequired,
  decodeEscapedText,
  extractVerificationErrorDetails,
  markStoredAccountVerificationRequired,
  normalizeGoogleVerificationUrl,
  selectBestVerificationUrl,
} from "./verification-probe";

describe("verification-probe helpers", () => {
  describe("decodeEscapedText", () => {
    it("decodes html entities and unicode escapes", () => {
      expect(decodeEscapedText("foo&amp;bar")).toBe("foo&bar");
      expect(decodeEscapedText("\\u0041\\u0042")).toBe("AB");
    });
  });

  describe("normalizeGoogleVerificationUrl", () => {
    it("accepts valid accounts.google.com URLs", () => {
      const url =
        "https://accounts.google.com/signin/continue?continue=https%3A%2F%2Fconsole.cloud.google.com";
      expect(normalizeGoogleVerificationUrl(url)).toBe(url);
    });

    it("rejects non-Google hostnames", () => {
      expect(normalizeGoogleVerificationUrl("https://evil.com/phish")).toBeUndefined();
    });

    it("handles empty or invalid string safely", () => {
      expect(normalizeGoogleVerificationUrl("")).toBeUndefined();
      expect(normalizeGoogleVerificationUrl("not a url")).toBeUndefined();
    });
  });

  describe("selectBestVerificationUrl", () => {
    it("prefers URL containing plt= and signin/continue", () => {
      const urls = [
        "https://accounts.google.com/service=cloudcode",
        "https://accounts.google.com/signin/continue?plt=123",
        "https://accounts.google.com/continue=xyz",
      ];
      const best = selectBestVerificationUrl(urls);
      expect(best).toContain("plt=");
    });

    it("returns undefined for empty input list", () => {
      expect(selectBestVerificationUrl([])).toBeUndefined();
    });
  });

  describe("extractVerificationErrorDetails", () => {
    it("detects validation_required in JSON body", () => {
      const body = JSON.stringify({
        error: {
          code: 403,
          message: "Account verification required",
          details: [
            { reason: "validation_required", url: "https://accounts.google.com/signin/continue?plt=1" },
          ],
        },
      });

      const extracted = extractVerificationErrorDetails(body);
      expect(extracted.validationRequired).toBe(true);
      expect(extracted.verifyUrl).toContain("accounts.google.com");
    });

    it("detects validation_required in raw text with escaped characters", () => {
      const rawText =
        'data: {"error":"validation_required","url":"https:\\u002f\\u002faccounts.google.com\\u002fverify"}';
      const extracted = extractVerificationErrorDetails(rawText);
      expect(extracted.validationRequired).toBe(true);
    });

    it("returns validationRequired=false for standard 403 permission denied", () => {
      const extracted = extractVerificationErrorDetails("Permission denied for resource");
      expect(extracted.validationRequired).toBe(false);
    });
  });

  describe("mark and clear verification on stored accounts", () => {
    it("marks an account as verification required and disables it", () => {
      const account: { enabled?: boolean; verificationRequired?: boolean; verificationUrl?: string } = {
        enabled: true,
      };
      const changed = markStoredAccountVerificationRequired(
        account,
        "Google check",
        "https://accounts.google.com/verify",
      );

      expect(changed).toBe(true);
      expect(account.enabled).toBe(false);
      expect(account.verificationRequired).toBe(true);
      expect(account.verificationUrl).toBe("https://accounts.google.com/verify");
    });

    it("clears verification and re-enables account when requested", () => {
      const account = {
        enabled: false,
        verificationRequired: true,
        verificationRequiredReason: "Check",
        verificationUrl: "https://accounts.google.com/verify",
      };

      const { changed, wasVerificationRequired } = clearStoredAccountVerificationRequired(account, true);

      expect(changed).toBe(true);
      expect(wasVerificationRequired).toBe(true);
      expect(account.enabled).toBe(true);
      expect(account.verificationRequired).toBe(false);
      expect(account.verificationUrl).toBeUndefined();
    });
  });
});
