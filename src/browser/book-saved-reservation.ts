import type { Browser } from "webdriverio";
import type { reservationToBookingRequest } from "../bookings/booking-payload";

export class RebookingError extends Error {}

export async function bookSavedReservationWithRetries(
  browser: Browser,
  request: ReturnType<typeof reservationToBookingRequest>,
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`Rebooking attempt ${attempt}/5: waiting 30 seconds before submitting.`);
    await browser.pause(30_000);
    try {
      return await bookSavedReservationAPI(browser, request);
    } catch (error) {
      const message = error instanceof RebookingError ? error.message : "Rebooking failed";
      console.warn(`Rebooking attempt ${attempt}/5 failed: ${message}`);
      if (attempt === 5) {
        throw new RebookingError(`Rebooking failed after 5 attempts: ${message}`);
      }
    }
  }
  throw new RebookingError("Rebooking failed after 5 attempts");
}

/** Submit once in the booking form context prepared by navigateToBooking. */
export async function bookSavedReservationAPI(
  browser: Browser,
  request: ReturnType<typeof reservationToBookingRequest>,
) {
  if (request.method !== "POST" || !/^\/api\/courts\/\d+\/booking_player$/.test(request.url)) {
    throw new RebookingError("Invalid saved booking endpoint; booking was not sent");
  }
  const preparation = "waiting for the booking form CSRF token";
  try {
    await browser.$('meta[name="csrf-token"]').waitForExist({ timeout: 30_000 });
    await browser.setTimeout({ script: 45_000 });
  } catch {
    throw new RebookingError(`Failed while ${preparation}; booking was not sent`);
  }

  const result = await browser.executeAsync(async (
    url: string,
    payload: unknown,
    done: (result: { reservationId?: number; error?: string }) => void,
  ) => {
    if (location.origin !== "https://app.playbypoint.com") {
      done({ error: "The booking form is not open at app.playbypoint.com; booking was not sent" });
      return;
    }
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
    if (!token) {
      done({ error: "Missing cred 1 CSRF token; booking was not sent" });
      return;
    }
    try {
      const response = await fetch(url, {
        method: "POST", credentials: "same-origin", redirect: "error",
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        done({ error: `Rebooking returned a non-JSON response (HTTP ${response.status}); verify cred 1's reservations before retrying` });
        return;
      }
      const id = body?.location?.id;
      if (response.ok && body?.location?.status === "booked" && Number.isSafeInteger(id) && id > 0) {
        done({ reservationId: id });
      } else {
        const reason = body?.errors ?? body?.error ?? body?.message;
        const detail = reason ? `: ${JSON.stringify(reason).slice(0, 1000)}` : "";
        done({ error: `Rebooking was not confirmed (HTTP ${response.status})${detail}; verify the reservation before retrying` });
      }
    } catch {
      done({ error: "Rebooking outcome is unknown; verify cred 1's reservations before retrying" });
    }
  }, request.url, request.payload).catch(() => {
    throw new RebookingError("Rebooking command failed; outcome is unknown. Verify cred 1's reservations before retrying");
  });
  if (result.error || !result.reservationId) throw new RebookingError(result.error ?? "No replacement reservation ID returned");
  return { reservationId: result.reservationId };
}
