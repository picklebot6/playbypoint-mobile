import assert from "node:assert/strict";
import { test } from "node:test";
import type { Browser } from "webdriverio";
import { BrowserLoginError, logInWithFreshBrowser } from "../../src/browser/login-fresh-browser";

function session(cleanupFails = false) {
  let closed = 0;
  return {
    browser: {
      getTitle: async () => "Sign in to PlayByPoint",
      getUrl: async () => "https://app.playbypoint.com/users/sign_in",
      deleteSession: async () => { closed++; if (cleanupFails) throw new Error("Session gone"); },
    } as unknown as Browser,
    closed: () => closed,
  };
}

test("restarts the browser when the sign-in form fails to appear", async context => {
  const previous = process.env.PLAYBYPOINT_CREDENTIAL_SET;
  context.after(() => { if (previous === undefined) delete process.env.PLAYBYPOINT_CREDENTIAL_SET; else process.env.PLAYBYPOINT_CREDENTIAL_SET = previous; });
  const first = session();
  const second = session();
  let opened = 0;
  const browser = await logInWithFreshBrowser("1", {
    open: async () => ++opened === 1 ? first.browser : second.browser,
    login: async current => {
      assert.equal(process.env.PLAYBYPOINT_CREDENTIAL_SET, "1");
      if (current === first.browser) throw new Error("Sign in button was not visible within 30 seconds");
    },
  });
  assert.equal(browser, second.browser);
  assert.equal(opened, 2);
  assert.equal(first.closed(), 1);
  assert.equal(second.closed(), 0);
});

test("stops after three login attempts and exposes only safe diagnostic details", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const current = session();
  let opened = 0;
  await assert.rejects(logInWithFreshBrowser("1", {
    open: async () => { opened++; return current.browser; },
    login: async () => { throw new Error("Failed credential command: private-test-password"); },
  }), error => {
    assert(error instanceof BrowserLoginError);
    assert.match(error.message, /failed after 3 fresh-browser attempts/);
    assert.match(error.message, /page \/users\/sign_in/);
    assert(!error.message.includes("private-test-password"));
    return true;
  });
  assert.equal(opened, 3);
  assert.equal(current.closed(), 3);
  assert(!warnings.join(" ").includes("private-test-password"));
});

test("a disconnected cleanup does not prevent a fresh login retry", async () => {
  const broken = session(true);
  const ready = session();
  let opened = 0;
  const browser = await logInWithFreshBrowser("1", {
    open: async () => ++opened === 1 ? broken.browser : ready.browser,
    login: async current => { if (current === broken.browser) throw new Error("UND_ERR_CLOSED"); },
  });
  assert.equal(browser, ready.browser);
  assert.equal(opened, 2);
});

test("browser startup failures are bounded to three attempts", async () => {
  let opened = 0;
  await assert.rejects(logInWithFreshBrowser("1", {
    open: async () => { opened++; throw new Error("Connection refused"); },
    login: async () => { assert.fail("Login must not run without a browser"); },
  }), /starting a fresh browser.*Login failed after 3/);
  assert.equal(opened, 3);
});
