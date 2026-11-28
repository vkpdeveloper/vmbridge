import { describe, expect, test } from "bun:test";
import { installOnboardingHashReload, shouldReloadForOnboardingHash } from "./onboarding-hash.ts";

describe("shouldReloadForOnboardingHash", () => {
  test("reloads when a setup code fragment is pasted into an existing onboarding tab", () => {
    expect(shouldReloadForOnboardingHash("/dashboard/onboarding", "#code=abc123")).toBe(true);
    expect(shouldReloadForOnboardingHash("/dashboard/onboarding/", "#code=abc123")).toBe(true);
    expect(shouldReloadForOnboardingHash("/dashboard/onboarding", "#foo=1&code=abc123")).toBe(true);
  });

  test("ignores empty codes, unrelated fragments, and non-onboarding paths", () => {
    expect(shouldReloadForOnboardingHash("/dashboard/onboarding", "")).toBe(false);
    expect(shouldReloadForOnboardingHash("/dashboard/onboarding", "#code=")).toBe(false);
    expect(shouldReloadForOnboardingHash("/dashboard/onboarding", "#section")).toBe(false);
    expect(shouldReloadForOnboardingHash("/dashboard", "#code=abc123")).toBe(false);
  });
});

describe("installOnboardingHashReload", () => {
  test("reloads once when hashchange delivers a setup code on onboarding and ignores empty hashes", () => {
    const target = new EventTarget();
    let reloads = 0;
    const loc = {
      pathname: "/dashboard/onboarding",
      hash: "",
      reload: () => {
        reloads += 1;
      },
    };
    const dispose = installOnboardingHashReload(target, loc);
    try {
      target.dispatchEvent(new Event("hashchange"));
      expect(reloads).toBe(0);

      loc.hash = "#code=abc123";
      target.dispatchEvent(new Event("hashchange"));
      expect(reloads).toBe(1);

      loc.pathname = "/dashboard";
      target.dispatchEvent(new Event("hashchange"));
      expect(reloads).toBe(1);
    } finally {
      dispose();
    }

    loc.pathname = "/dashboard/onboarding/";
    loc.hash = "#code=xyz789";
    target.dispatchEvent(new Event("hashchange"));
    expect(reloads).toBe(1);
  });
});
