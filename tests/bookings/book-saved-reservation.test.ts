import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Browser } from "webdriverio";
import { bookSavedReservationAPI, bookSavedReservationWithRetries } from "../../src/browser/book-saved-reservation";
import { reservationToBookingRequest } from "../../src/bookings/booking-payload";

const request = reservationToBookingRequest({
  id: 123, reference: "RES123", facility: "iTennis/iPickle Cerritos", court: "Pickleball 1",
  date: "2026-11-11", dateLabel: "Wed, Nov 11", time: "07:30 AM - 08:30 AM",
  status: "booked", canCancel: true, players: ["Player One", "Player Two"],
}, { "Player One": 101, "Player Two": 202 });

function setup(options: { token?: boolean; status?: number; body?: unknown; rawText?: string; networkFailure?: boolean; failFirst?: number } = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const pauses: number[] = [];
  const frames: unknown[] = [];
  const frame = { waitForExist: async () => {} };
  const browser = {
    pause: async (milliseconds: number) => { pauses.push(milliseconds); },
    switchFrame: async (value: unknown) => { frames.push(value); },
    $: () => ({ getElement: async () => frame, waitForExist: async () => {} }),
    setTimeout: async () => {},
    executeAsync: (callback: Function, url: string, payload: unknown) => new Promise(resolve => {
      runInNewContext(`(${callback.toString()})(url, payload, done)`, {
        url, payload, done: resolve, AbortSignal, location: { origin: "https://app.playbypoint.com" },
        document: { querySelector: () => options.token === false ? null : { getAttribute: () => "fresh-cred-1-csrf" } },
        fetch: async (url: string, init: RequestInit) => {
          requests.push({ url, init });
          if (options.networkFailure) throw new Error("Network failure");
          const status = requests.length <= (options.failFirst ?? 0) ? 422 : options.status ?? 200;
          return { status, ok: status >= 200 && status < 300,
            text: async () => options.rawText ?? JSON.stringify(options.body ?? { location: { status: "booked", id: 456 } }) };
        },
      });
    }),
  } as unknown as Browser;
  return { browser, requests, frames, frame, pauses };
}

test("submits the saved payload once with the fresh session token in the prepared booking form", async () => {
  const { browser, requests, frames } = setup();
  assert.deepEqual(await bookSavedReservationAPI(browser, request), { reservationId: 456 });
  assert.deepEqual(frames, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, request.url);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.equal((requests[0].init.headers as Record<string, string>)["X-CSRF-Token"], "fresh-cred-1-csrf");
  assert.deepEqual(JSON.parse(requests[0].init.body as string), request.payload);
});

test("does not submit without a fresh token or with an unexpected saved endpoint", async () => {
  const { browser, requests } = setup({ token: false });
  await assert.rejects(bookSavedReservationAPI(browser, request), /booking was not sent/);
  await assert.rejects(bookSavedReservationAPI(browser, { ...request, url: "https://other.example/booking" }), /Invalid saved/);
  assert.equal(requests.length, 0);
});

test("requires a confirmed replacement ID and booked status without retrying", async () => {
  for (const options of [{ status: 422 }, { body: {} }, { body: { location: { status: "pending", id: 456 } } }]) {
    const { browser, requests } = setup(options);
    await assert.rejects(bookSavedReservationAPI(browser, request), /not confirmed/);
    assert.equal(requests.length, 1);
  }
});

test("network failure reports an uncertain result without resubmitting", async () => {
  const { browser, requests } = setup({ networkFailure: true });
  await assert.rejects(bookSavedReservationAPI(browser, request), /outcome is unknown/);
  assert.equal(requests.length, 1);
});

test("reports a missing booking form token as a preparation failure before submission", async () => {
  const { browser, requests } = setup();
  browser.$ = (() => ({ waitForExist: async () => { throw new Error("Timeout"); } })) as typeof browser.$;
  await assert.rejects(bookSavedReservationAPI(browser, request), /waiting for the booking form CSRF token; booking was not sent/);
  assert.equal(requests.length, 0);
});

test("includes API validation errors in the diagnostic", async () => {
  const { browser } = setup({ status: 422, body: { errors: ["Court is unavailable"] } });
  await assert.rejects(bookSavedReservationAPI(browser, request), /HTTP 422.*Court is unavailable/);
});

test("distinguishes a non-JSON response from a network failure", async () => {
  const { browser, requests } = setup({ status: 403, rawText: "<html>Sign in</html>" });
  await assert.rejects(bookSavedReservationAPI(browser, request), /non-JSON response \(HTTP 403\)/);
  assert.equal(requests.length, 1);
});

test("delays 30 seconds before the first attempt and stops immediately on success", async () => {
  const { browser, requests, pauses } = setup();
  assert.deepEqual(await bookSavedReservationWithRetries(browser, request), { reservationId: 456 });
  assert.deepEqual(pauses, [30_000]);
  assert.equal(requests.length, 1);
});

test("retries failures with a 30-second delay before each attempt", async () => {
  const { browser, requests, pauses } = setup({ failFirst: 2 });
  assert.deepEqual(await bookSavedReservationWithRetries(browser, request), { reservationId: 456 });
  assert.deepEqual(pauses, [30_000, 30_000, 30_000]);
  assert.equal(requests.length, 3);
});

test("fails after exactly five unsuccessful attempts", async () => {
  const { browser, requests, pauses } = setup({ status: 422 });
  await assert.rejects(bookSavedReservationWithRetries(browser, request), /failed after 5 attempts/);
  assert.deepEqual(pauses, Array(5).fill(30_000));
  assert.equal(requests.length, 5);
});
