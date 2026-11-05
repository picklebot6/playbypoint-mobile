import { BrowserLoginError, logInWithFreshBrowser } from "../browser/login-fresh-browser";
import { navigateToBooking } from "../browser/navigate-to-booking";
import { fetchActiveBookings } from "../browser/fetch-active-bookings";
import { bookSavedReservationWithRetries, RebookingError } from "../browser/book-saved-reservation";
import { loadPlayerIds } from "../browser/player-ids";
import { reservationToBookingRequest } from "./booking-payload";
import { loadTransferPlan, saveTransferPlan } from "./transfer-plan";
import type { Browser } from "webdriverio";

export async function resumeSavedTransfer() {
  const plan = await loadTransferPlan();
  const entry = plan.bookings?.[0];
  if (plan.bookings?.length !== 1 || !entry?.cancellationConfirmed) {
    throw new RebookingError("Resume requires one saved reservation with confirmed cancellation");
  }
  if (entry.replacementReservationId) {
    console.log(`Already rebooked as reservation ${entry.replacementReservationId}; nothing to resume.`);
    return;
  }
  if (!process.env.PLAYBYPOINT_EMAIL || !process.env.PLAYBYPOINT_PASSWORD) {
    throw new RebookingError("Missing cred 1 credentials");
  }
  const previousCredentials = process.env.PLAYBYPOINT_CREDENTIAL_SET;
  process.env.PLAYBYPOINT_CREDENTIAL_SET = "1";
  let browser: Browser | undefined;
  try {
    browser = await logInWithFreshBrowser("1");
    const existing = await fetchActiveBookings(browser);
    const playerIds = await loadPlayerIds();
    const wanted = entry.request;
    // Do not submit again if the previous request actually succeeded.
    for (const booking of existing.filter(b => b.date === wanted.payload.reservation.date && b.facility === "iTennis/iPickle Cerritos")) {
      const current = reservationToBookingRequest(booking, playerIds);
      if (current.url !== wanted.url || current.payload.reservation.hour_start !== wanted.payload.reservation.hour_start ||
          current.payload.reservation.hour_end !== wanted.payload.reservation.hour_end) continue;
      if (!booking.canCancel || JSON.stringify([...current.payload.user_ids].sort()) !== JSON.stringify([...wanted.payload.user_ids].sort())) {
        throw new RebookingError("A reservation already exists for the saved slot with different ownership or players; verify it before proceeding");
      }
      entry.status = "rebooked";
      entry.replacementReservationId = booking.id;
      entry.lastError = null;
      await saveTransferPlan(plan);
      console.log(`Cred 1 already owns matching reservation ${booking.reference}; no booking was submitted.`);
      return;
    }
    await navigateToBooking(browser);
    entry.status = "rebooking";
    await saveTransferPlan(plan);
    const replacement = await bookSavedReservationWithRetries(browser, wanted);
    entry.replacementReservationId = replacement.reservationId;
    entry.status = "rebooked";
    entry.lastError = null;
    await saveTransferPlan(plan);
    console.log(`Rebooked saved reservation as ${replacement.reservationId} under cred 1.`);
  } catch (error) {
    entry.status = "failed_or_unknown";
    if (error instanceof RebookingError || error instanceof BrowserLoginError) entry.lastError = error.message;
    await saveTransferPlan(plan);
    throw error;
  } finally {
    if (previousCredentials === undefined) delete process.env.PLAYBYPOINT_CREDENTIAL_SET;
    else process.env.PLAYBYPOINT_CREDENTIAL_SET = previousCredentials;
    if (browser) await browser.deleteSession().catch(() => console.warn("Browser cleanup failed; preserving the transfer result."));
  }
}
