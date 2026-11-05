import type { Browser } from "webdriverio";
import { openFreshBrowser } from "./fresh-browser";
import { logInToPlayByPoint } from "./login";

export class BrowserLoginError extends Error {}

/** Retry browser startup/login only; this function never submits a booking. */
export async function logInWithFreshBrowser(
  credentialSet: string,
  dependencies = { open: openFreshBrowser, login: logInToPlayByPoint },
) {
  process.env.PLAYBYPOINT_CREDENTIAL_SET = credentialSet;
  let lastFailure = "Browser startup failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let browser: Browser | undefined;
    let stage = "starting a fresh browser";
    try {
      console.log(`Cred ${credentialSet} login attempt ${attempt}/3.`);
      browser = await dependencies.open();
      stage = "logging in";
      await dependencies.login(browser);
      return browser;
    } catch (error) {
      // WebDriver exceptions can include credential-bearing commands. Classify rather than dump them.
      const raw = error instanceof Error ? error.message : "";
      const reason = /sign in button was not visible/i.test(raw) ? "sign-in button did not become visible"
        : /UND_ERR|session|socket|connect/i.test(raw) ? "browser connection failed"
        : /still on the sign-in page/i.test(raw) ? "login stayed on the sign-in page"
        : "browser or login preparation failed";
      let page = "page unavailable";
      if (browser) {
        try {
          const title = await browser.getTitle();
          const url = new URL(await browser.getUrl());
          page = /just a moment|security verification/i.test(title) ? "security verification page"
            : url.origin === "https://app.playbypoint.com" ? `page ${url.pathname}` : "outside PlayByPoint";
        } catch { /* The session may already be disconnected. */ }
        await browser.deleteSession().catch(() => {});
      }
      lastFailure = `Cred ${credentialSet}: ${reason} while ${stage} (${page})`;
      console.warn(`${lastFailure}; attempt ${attempt}/3 failed.`);
    }
  }
  throw new BrowserLoginError(`${lastFailure}. Login failed after 3 fresh-browser attempts; no rebooking was submitted.`);
}
