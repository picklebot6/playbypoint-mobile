import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { load } from "cheerio";
import type { Browser } from "webdriverio";
import { cancelReservationAPI, CancellationError } from "../../src/browser/cancel-reservation";

function setup(options: {
  owner?: boolean; detailsId?: number; cancelId?: number; token?: boolean;
  status?: number; networkFailure?: boolean; loginRedirect?: boolean;
  detailsStatus?: number; detailsHtml?: string; responseError?: unknown; detailsNetworkFailure?: boolean;
} = {}) {
  const requests: { url: string; options: RequestInit }[] = [];
  const html = `<div data-react-class="ReservationDetails" data-react-props='${JSON.stringify({
    reservationRealId: options.detailsId ?? 123, user_is_owner: options.owner ?? true,
  })}'></div><div data-react-class="CancelReservation" data-react-props='${JSON.stringify({
    reservationId: options.cancelId ?? 123,
  })}'></div>${options.token === false ? "" : '<meta name="csrf-token" content="test-csrf">'}`;
  const browser = {
    switchFrame: async () => {},
    getUrl: async () => "https://app.playbypoint.com/account/reservations",
    setTimeout: async () => {},
    executeAsync: async (callback: Function, id: number) => new Promise(resolve => {
      runInNewContext(`(${callback.toString()})(id, done)`, {
        id, done: resolve, URL, AbortSignal,
        DOMParser: class {
          parseFromString(text: string) {
            const $ = load(text);
            return { querySelector: (selector: string) => $(selector).length ? {
              getAttribute: (name: string) => $(selector).attr(name) ?? null,
            } : null };
          }
        },
        fetch: async (url: string, init: RequestInit) => {
          requests.push({ url, options: init });
          if (init.method === "DELETE") {
            if (options.networkFailure) throw new Error("Network failure");
            return { status: options.status ?? 204, json: async () => ({ errors: options.responseError }) };
          }
          if (options.detailsNetworkFailure) throw new Error("Network failure");
          const status = options.detailsStatus ?? 200;
          return { ok: status >= 200 && status < 300, status,
            url: options.loginRedirect ? "https://app.playbypoint.com/users/sign_in" : `https://app.playbypoint.com${url}`,
            text: async () => options.detailsHtml ?? html };
        },
      });
    }),
  } as unknown as Browser;
  return { browser, requests };
}

test("cancels the verified reservation with session cookies and fresh CSRF token", async () => {
  const { browser, requests } = setup();
  assert.deepEqual(await cancelReservationAPI(browser, 123), { reservationId: 123, status: 204 });
  assert.deepEqual(requests.map(r => r.url), ["/reservations/123", "/api/reservations/123"]);
  assert.equal(requests[1].options.method, "DELETE");
  assert.equal(requests[1].options.credentials, "same-origin");
  assert.equal((requests[1].options.headers as Record<string, string>)["X-CSRF-Token"], "test-csrf");
  assert.equal(requests[1].options.body, undefined);
});

test("does not send DELETE for invalid IDs, wrong ownership, or mismatched reservations", async () => {
  const invalid = setup();
  for (const id of [0, -1, 1.5, NaN]) await assert.rejects(cancelReservationAPI(invalid.browser, id), /positive internal/);
  assert.equal(invalid.requests.length, 0);
  for (const options of [{ owner: false }, { detailsId: 456 }, { cancelId: 456 }]) {
    const { browser, requests } = setup(options);
    await assert.rejects(cancelReservationAPI(browser, 123), /cancellation was not sent/);
    assert.equal(requests.length, 1);
  }
});

test("does not send DELETE without CSRF or when redirected to login", async () => {
  for (const options of [{ token: false }, { loginRedirect: true }]) {
    const { browser, requests } = setup(options);
    await assert.rejects(cancelReservationAPI(browser, 123), /cancellation was not sent/);
    assert.equal(requests.length, 1);
  }
});

test("rejects unexpected responses without retrying", async () => {
  for (const status of [200, 401, 403, 422, 500]) {
    const { browser, requests } = setup({ status });
    await assert.rejects(cancelReservationAPI(browser, 123), new RegExp(`HTTP ${status}`));
    assert.equal(requests.filter(r => r.options.method === "DELETE").length, 1);
  }
});

test("reports an unknown outcome after a network failure without retrying", async () => {
  const { browser, requests } = setup({ networkFailure: true });
  await assert.rejects(cancelReservationAPI(browser, 123), /outcome is unknown/);
  assert.equal(requests.filter(r => r.options.method === "DELETE").length, 1);
});

test("exposes cancellation HTTP status and API validation errors", async () => {
  const { browser } = setup({ status: 422, responseError: ["Cancellation is not allowed"] });
  await assert.rejects(cancelReservationAPI(browser, 123), error => {
    assert(error instanceof CancellationError);
    assert.equal(error.httpStatus, 422);
    assert.equal(error.requestSent, true);
    assert.match(error.message, /HTTP 422.*Cancellation is not allowed/);
    assert(!error.message.includes("test-csrf"));
    return true;
  });
});

test("distinguishes a rejected details fetch from a cancellation request", async () => {
  const { browser, requests } = setup({ detailsStatus: 403 });
  await assert.rejects(cancelReservationAPI(browser, 123), error => {
    assert(error instanceof CancellationError);
    assert.equal(error.httpStatus, 403);
    assert.equal(error.requestSent, false);
    assert.match(error.message, /Reservation details.*HTTP 403/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test("reports changed details markup without submitting a cancellation", async () => {
  const { browser, requests } = setup({ detailsHtml: "<html>Security verification</html>" });
  await assert.rejects(cancelReservationAPI(browser, 123), /ReservationDetails is missing/);
  assert.equal(requests.length, 1);
});

test("reports the failed stage when the read-only details request fails", async () => {
  const { browser } = setup({ detailsNetworkFailure: true });
  await assert.rejects(cancelReservationAPI(browser, 123), error => {
    assert(error instanceof CancellationError);
    assert.equal(error.requestSent, false);
    assert.match(error.message, /loading reservation details; cancellation was not sent/);
    return true;
  });
});

test("treats a dropped browser command as an unknown cancellation outcome", async () => {
  const { browser } = setup();
  browser.executeAsync = (async () => { throw new Error("Session disconnected"); }) as typeof browser.executeAsync;
  await assert.rejects(cancelReservationAPI(browser, 123), error => {
    assert(error instanceof CancellationError);
    assert.equal(error.requestSent, true);
    assert.match(error.message, /browser command failed; outcome is unknown/);
    return true;
  });
});

test("a browser setup failure is reported before sending any request", async () => {
  const { browser, requests } = setup();
  browser.switchFrame = (async () => { throw new Error("Session disconnected"); }) as typeof browser.switchFrame;
  await assert.rejects(cancelReservationAPI(browser, 123), error => {
    assert(error instanceof CancellationError);
    assert.equal(error.requestSent, false);
    assert.match(error.message, /access the signed-in browser; cancellation was not sent/);
    return true;
  });
  assert.equal(requests.length, 0);
});
