import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { load } from "cheerio";
import type { Browser } from "webdriverio";
import { cancelReservationAPI } from "../../src/browser/cancel-reservation";

function setup(options: {
  owner?: boolean; detailsId?: number; cancelId?: number; token?: boolean;
  status?: number; networkFailure?: boolean; loginRedirect?: boolean;
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
            return { status: options.status ?? 204 };
          }
          return { ok: true, status: 200,
            url: options.loginRedirect ? "https://app.playbypoint.com/users/sign_in" : `https://app.playbypoint.com${url}`,
            text: async () => html };
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
