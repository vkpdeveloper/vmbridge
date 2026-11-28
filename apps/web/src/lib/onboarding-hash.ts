const onboardingPath = "/dashboard/onboarding";

/** True when a tab already on onboarding receives a setup link fragment (`#code=...`) via hashchange. */
export function shouldReloadForOnboardingHash(pathname: string, hash: string): boolean {
  if (pathname.replace(/\/+$/, "") !== onboardingPath || !hash.startsWith("#")) return false;
  const code = new URLSearchParams(hash.slice(1)).get("code");
  return Boolean(code);
}

/** Reloads an open onboarding tab when a `#code=...` fragment is pasted into its address bar. */
export function installOnboardingHashReload(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  loc: Pick<Location, "pathname" | "hash" | "reload">,
): () => void {
  const onHashChange = () => {
    if (shouldReloadForOnboardingHash(loc.pathname, loc.hash)) loc.reload();
  };
  target.addEventListener("hashchange", onHashChange);
  return () => target.removeEventListener("hashchange", onHashChange);
}
