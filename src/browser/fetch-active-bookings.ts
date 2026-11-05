import type { Browser } from "webdriverio";
import { parseBookings, parseBookingDate, type Booking } from "../bookings/parse";

const origin = "https://app.playbypoint.com";

export type ActiveBooking = Booking & { date: string };

async function fetchPage(browser: Browser, path: string): Promise<string> {
  const url = new URL(path, origin);
  if (url.origin !== origin || !/^\/(account\/reservations|reservations\/)/.test(url.pathname)) {
    throw new Error("Unexpected reservation URL");
  }
  const response = await browser.executeAsync(async (url: string, done: (value: { status: number; url: string; html: string; error?: string }) => void) => {
    try {
      const result = await fetch(url, { credentials: "same-origin", headers: { Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
      done({ status: result.status, url: result.url, html: await result.text() });
    } catch {
      done({ status: 0, url, html: "", error: "Reservation request failed or timed out" });
    }
  }, url.href);
  if (response.error || response.status !== 200 || new URL(response.url).pathname.includes("sign_in")) {
    throw new Error(response.error ?? `Reservation request failed (HTTP ${response.status}); check login.`);
  }
  return response.html;
}

export async function fetchActiveBookings(browser: Browser): Promise<ActiveBooking[]> {
  // Use the app origin and its authenticated session for all reservation requests.
  await browser.switchFrame(null);
  await browser.url(`${origin}/account/reservations`);
  const bookingsById = new Map<number, Booking>();
  const pending = ["/account/reservations"];
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.shift()!;
    const url = new URL(path, origin);
    if (url.origin !== origin || url.pathname !== "/account/reservations") throw new Error("Unexpected pagination URL");
    if (visited.has(url.href)) continue;
    if (visited.size >= 100) throw new Error("Reservation pagination exceeded 100 pages");
    visited.add(url.href);
    const page = parseBookings(await fetchPage(browser, url.href));
    page.bookings.forEach(booking => bookingsById.set(booking.id, booking));
    pending.push(...page.nextPages);
  }
  const activeBookings: ActiveBooking[] = [];
  for (const booking of bookingsById.values()) {
    if (booking.status !== "booked") continue;
    const date = parseBookingDate(await fetchPage(browser, `/reservations/${booking.id}`), booking.id);
    activeBookings.push({ ...booking, date });
  }
  return activeBookings;
}
