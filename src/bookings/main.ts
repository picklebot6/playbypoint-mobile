import type { Browser } from "webdriverio";
import { BrowserLoginError, logInWithFreshBrowser } from "../browser/login-fresh-browser";
import { bookSavedReservationWithRetries, RebookingError } from "../browser/book-saved-reservation";
import { fetchActiveBookings } from "../browser/fetch-active-bookings";
import { clearBookingReport, createBookingReport, saveBookingReport } from "./report";
import { BookingPayloadError, logBookingPayloads } from "./booking-payload";
import { cancelReservationAPI, CancellationError } from "../browser/cancel-reservation";
import { createTransferPlan, saveTransferPlan } from "./transfer-plan";
import { navigateToBooking } from "../browser/navigate-to-booking";
import { resumeSavedTransfer } from "./resume";

let phase = "credential validation";

async function main() {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" }).format(new Date());
  if (day === "Friday") {
    console.log("Friday in America/Los_Angeles; skipping the transfer workflow.");
    return;
  }
  if (process.argv.includes("--resume")) {
    phase = "resuming the saved transfer under cred 1";
    await resumeSavedTransfer();
    return;
  }
  await clearBookingReport();
  const credentialSet = process.env.PLAYBYPOINT_CREDENTIAL_SET?.trim() || "2";
  if (!["1", "2", "3", "4"].includes(credentialSet)) throw new Error("Credential set must be 1, 2, 3, or 4");
  process.env.PLAYBYPOINT_CREDENTIAL_SET = credentialSet;
  const suffix = credentialSet === "1" ? "" : `_${credentialSet}`;
  const email = process.env[`PLAYBYPOINT_EMAIL${suffix}`];
  const password = process.env[`PLAYBYPOINT_PASSWORD${suffix}`];
  if (!email || !password) throw new Error(`Missing email or password for credential set ${credentialSet}`);
  if (credentialSet === "1") throw new Error("Select source credentials 2, 3, or 4; the destination is cred 1");

  console.log(`Starting booking lookup for credential set ${credentialSet}.`);
  phase = "Android Chrome startup";
  let browser: Browser | undefined;
  let plan: ReturnType<typeof createTransferPlan> | undefined;
  try {
    phase = "login";
    browser = await logInWithFreshBrowser(credentialSet);
    phase = "fetching active bookings";
    const activeBookings = await fetchActiveBookings(browser);
    const report = createBookingReport(activeBookings, credentialSet);
    phase = "saving the report";
    await saveBookingReport(report);
    phase = "selecting the reservation to transfer";
    if (report.targetCount === 0) {
      console.log(`No reservation for ${report.targetDate}; ending the workflow.`);
      return;
    }
    const booking = report.targetBookings[0];
    if (!booking.canCancel) {
      throw new BookingPayloadError(`Reservation ${booking.reference} cannot be cancelled by this account.`);
    }
    if (!process.env.PLAYBYPOINT_EMAIL || !process.env.PLAYBYPOINT_PASSWORD) {
      throw new Error("Missing destination cred 1 email or password");
    }
    phase = "constructing booking payloads";
    const requests = await logBookingPayloads([booking]);
    plan = createTransferPlan(credentialSet, report.targetDate, requests);
    phase = "storing replacement payloads";
    await saveTransferPlan(plan);

    const entry = plan.bookings[0];
    phase = `cancelling reservation ${entry.request.sourceReference}`;
    entry.status = "cancelling";
    await saveTransferPlan(plan);
    try {
      await cancelReservationAPI(browser, entry.request.sourceReservationId);
    } catch (error) {
      entry.status = "failed_or_unknown";
      if (error instanceof CancellationError) {
        entry.lastError = error.message;
        console.error(`Cancellation failed for ${entry.request.sourceReference} (internal ID ${entry.request.sourceReservationId}, HTTP ${error.httpStatus || "unavailable"}, request sent or possibly sent: ${error.requestSent}).`);
      }
      await saveTransferPlan(plan).catch(() => console.warn("Could not save cancellation failure details; the existing payload is preserved."));
      throw error;
    }
    entry.status = "cancelled";
    entry.cancellationConfirmed = true;
    await saveTransferPlan(plan);
    console.log(`Cancelled ${entry.request.sourceReference}; replacement payload saved in reports/transfer-bookings.json.`);

    phase = "closing the source browser";
    await browser.deleteSession().catch(() => console.warn("Source session cleanup failed; Chrome will be stopped before cred 1 login."));
    browser = undefined;
    phase = "logging in with cred 1 in a fresh browser";
    browser = await logInWithFreshBrowser("1");
    phase = "opening the cred 1 booking form";
    await navigateToBooking(browser);
    phase = `rebooking reservation ${entry.request.sourceReference} with cred 1`;
    entry.status = "rebooking";
    await saveTransferPlan(plan);
    try {
      const replacement = await bookSavedReservationWithRetries(browser, entry.request);
      entry.replacementReservationId = replacement.reservationId;
    } catch (error) {
      entry.status = "failed_or_unknown";
      if (error instanceof RebookingError) entry.lastError = error.message;
      await saveTransferPlan(plan);
      throw error;
    }
    entry.status = "rebooked";
    await saveTransferPlan(plan);
    console.log(`Rebooked ${entry.request.sourceReference} as reservation ${entry.replacementReservationId} under cred 1.`);
  } catch (error) {
    if (plan?.bookings[0] && error instanceof BrowserLoginError) {
      plan.bookings[0].lastError = error.message;
      await saveTransferPlan(plan).catch(() => console.warn("Could not save login failure details; the existing payload is preserved."));
    }
    throw error;
  } finally {
    process.env.PLAYBYPOINT_CREDENTIAL_SET = credentialSet;
    if (browser) await browser.deleteSession().catch(() => console.warn("Browser cleanup failed; preserving the transfer result."));
  }
}

if (require.main === module) {
  main().catch(error => {
    // Do not dump WebDriver errors: they can include credential-bearing commands.
    console.error(`Booking lookup failed during ${phase}. Check credentials, browser/network availability, and reservation page format.`);
    if (error instanceof BookingPayloadError || error instanceof RebookingError || error instanceof BrowserLoginError || error instanceof CancellationError) console.error(error.message);
    process.exitCode = 1;
  });
}
