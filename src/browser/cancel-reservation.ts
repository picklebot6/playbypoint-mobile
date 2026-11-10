import type { Browser } from "webdriverio";

export class CancellationError extends Error {
  constructor(message: string, readonly requestSent = false, readonly httpStatus = 0) {
    super(message);
  }
}

/** Cancel one owned reservation using the currently signed-in account. Never retries. */
export async function cancelReservationAPI(browser: Browser, reservationId: number) {
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    throw new CancellationError("A positive internal reservation ID is required; cancellation was not sent");
  }

  try {
    await browser.switchFrame(null);
    if (new URL(await browser.getUrl()).origin !== "https://app.playbypoint.com") {
      throw new CancellationError("Sign in at app.playbypoint.com before cancelling a reservation; cancellation was not sent");
    }
    await browser.setTimeout({ script: 45_000 });
  } catch (error) {
    if (error instanceof CancellationError) throw error;
    throw new CancellationError("Could not access the signed-in browser; cancellation was not sent");
  }

  const result = await browser.executeAsync(async (
    id: number,
    done: (result: { status: number; error?: string; requestSent?: boolean }) => void,
  ) => {
    let cancellationStarted = false;
    let stage = "loading reservation details";
    try {
      // Fetch fresh ownership and CSRF data instead of trusting a saved booking list.
      const details = await fetch(`/reservations/${id}`, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!details.ok || new URL(details.url).origin !== "https://app.playbypoint.com" ||
          new URL(details.url).pathname.includes("sign_in")) {
        const reason = new URL(details.url).pathname.includes("sign_in") ? "redirected to sign-in" : "could not load authenticated reservation details";
        done({ status: details.status, error: `Reservation details: ${reason} (HTTP ${details.status}); cancellation was not sent` });
        return;
      }
      stage = "reading reservation details";
      const page = new DOMParser().parseFromString(await details.text(), "text/html");
      const props = page.querySelector('[data-react-class="ReservationDetails"]')?.getAttribute("data-react-props");
      const reservation = props ? JSON.parse(props) : null;
      const cancelProps = page.querySelector('[data-react-class="CancelReservation"]')?.getAttribute("data-react-props");
      if (!reservation) {
        done({ status: details.status, error: "ReservationDetails is missing from the details page; cancellation was not sent" });
        return;
      }
      if (reservation.reservationRealId !== id) {
        done({ status: 0, error: "Reservation ID did not match the requested booking; cancellation was not sent" });
        return;
      }
      if (reservation.user_is_owner !== true) {
        done({ status: 0, error: "The signed-in account is not the reservation owner; cancellation was not sent" });
        return;
      }
      if (!cancelProps || JSON.parse(cancelProps).reservationId !== id) {
        done({ status: 0, error: "The matching CancelReservation control is unavailable; cancellation was not sent" });
        return;
      }
      const token = page.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
      if (!token) {
        done({ status: 0, error: "Missing CSRF token; cancellation was not sent" });
        return;
      }

      cancellationStarted = true;
      stage = "submitting the cancellation";
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
      if (response.status === 204) {
        done({ status: 204, requestSent: true });
        return;
      }
      let detail = "";
      try {
        const body = await response.json();
        const reason = body?.errors ?? body?.error ?? body?.message;
        if (reason) detail = `: ${JSON.stringify(reason).slice(0, 1000)}`;
      } catch { /* HTML and empty responses are diagnosed by HTTP status only. */ }
      done({ status: response.status, requestSent: true,
        error: `Cancellation returned HTTP ${response.status}${detail}; verify the booking before retrying` });
    } catch {
      done({ status: 0, requestSent: cancellationStarted, error: cancellationStarted
        ? `Cancellation outcome is unknown while ${stage}; verify the booking before retrying`
        : `Failed while ${stage}; cancellation was not sent` });
    }
  }, reservationId).catch(() => {
    throw new CancellationError("Cancellation browser command failed; outcome is unknown. Verify the booking before retrying", true);
  });

  if (result.error || result.status !== 204) {
    throw new CancellationError(result.error ?? `Cancellation was not confirmed (HTTP ${result.status})`, result.requestSent ?? false, result.status);
  }
  return { reservationId, status: 204 as const };
}
