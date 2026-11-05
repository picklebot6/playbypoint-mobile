import type { Browser } from "webdriverio";

/** Cancel one owned reservation using the currently signed-in account. Never retries. */
export async function cancelReservationAPI(browser: Browser, reservationId: number) {
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    throw new Error("A positive internal reservation ID is required");
  }

  await browser.switchFrame(null);
  if (new URL(await browser.getUrl()).origin !== "https://app.playbypoint.com") {
    throw new Error("Sign in at app.playbypoint.com before cancelling a reservation");
  }
  await browser.setTimeout({ script: 45_000 });

  const result = await browser.executeAsync(async (
    id: number,
    done: (result: { status: number; error?: string }) => void,
  ) => {
    let cancellationStarted = false;
    try {
      // Fetch fresh ownership and CSRF data instead of trusting a saved booking list.
      const details = await fetch(`/reservations/${id}`, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!details.ok || new URL(details.url).origin !== "https://app.playbypoint.com" ||
          new URL(details.url).pathname.includes("sign_in")) {
        done({ status: details.status, error: "Could not load authenticated reservation details; cancellation was not sent" });
        return;
      }
      const page = new DOMParser().parseFromString(await details.text(), "text/html");
      const props = page.querySelector('[data-react-class="ReservationDetails"]')?.getAttribute("data-react-props");
      const reservation = props ? JSON.parse(props) : null;
      const cancelProps = page.querySelector('[data-react-class="CancelReservation"]')?.getAttribute("data-react-props");
      if (reservation?.reservationRealId !== id || reservation.user_is_owner !== true ||
          !cancelProps || JSON.parse(cancelProps).reservationId !== id) {
        done({ status: 0, error: "Reservation ownership or cancellation availability could not be confirmed; cancellation was not sent" });
        return;
      }
      const token = page.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
      if (!token) {
        done({ status: 0, error: "Missing CSRF token; cancellation was not sent" });
        return;
      }

      cancellationStarted = true;
      const response = await fetch(`/api/reservations/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "X-CSRF-Token": token,
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: AbortSignal.timeout(15_000),
      });
      // The observed cancellation endpoint returns 204 with no body.
      done(response.status === 204
        ? { status: 204 }
        : { status: response.status, error: `Cancellation returned HTTP ${response.status}; verify the booking before retrying` });
    } catch {
      done({ status: 0, error: cancellationStarted
        ? "Cancellation outcome is unknown; verify the booking before retrying"
        : "Could not validate reservation details; cancellation was not sent" });
    }
  }, reservationId).catch(() => {
    throw new Error("Cancellation command failed; outcome is unknown. Verify the booking before retrying");
  });

  if (result.error || result.status !== 204) {
    throw new Error(result.error ?? `Cancellation was not confirmed (HTTP ${result.status})`);
  }
  return { reservationId, status: 204 as const };
}
