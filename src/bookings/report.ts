import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import type { ActiveBooking } from "../browser/fetch-active-bookings";
import { getBookingDate } from "../browser/book-reservation";

const timezone = "America/Los_Angeles";
const reportPath = "reports/active-bookings.json";

export async function clearBookingReport() {
  await rm(reportPath, { force: true });
}

export function createBookingReport(activeBookings: ActiveBooking[], credentialSet: string) {
  const targetDate = getBookingDate();
  const targetBookings = activeBookings.filter(booking => booking.date === targetDate);
  const report = { fetchedAt: new Date().toISOString(), credentialSet, timezone, targetDate,
    activeCount: activeBookings.length, targetCount: targetBookings.length, activeBookings, targetBookings };
  return report;
}

export async function saveBookingReport(report: ReturnType<typeof createBookingReport>) {
  const { targetBookings, credentialSet, targetDate, timezone } = report;
  await mkdir("reports", { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`Credential set ${credentialSet}: ${report.targetCount} reservation(s) for ${targetDate}, one week from today (${timezone}).`);
  for (const booking of targetBookings) {
    console.log(`${booking.reference}: ${booking.date}, ${booking.time}, ${booking.court}, ${booking.facility}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `active_count=${report.activeCount}\ntarget_date=${targetDate}\ntarget_count=${report.targetCount}\nreport_path=reports/active-bookings.json\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = (value: unknown) => String(value).replace(/[&<>|\r\n]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "\r": " ", "\n": " " })[char]!);
    const rows = targetBookings.map(b => `| ${escape(b.reference)} | ${b.date} | ${escape(b.time)} | ${escape(b.court)} | ${escape(b.facility)} | ${b.canCancel ? "Yes" : "No"} |`).join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## PlayByPoint bookings for one week from today\n\nCredential set: ${credentialSet}. Target date: ${targetDate} (${timezone}).\n\n${report.targetCount} matching reservation(s) out of ${report.activeCount} booked reservation(s).\n\n` +
      (rows ? `| Reference | Date | Time | Court | Facility | Cancel control available |\n|---|---|---|---|---|---|\n${rows}\n` : "No reservations found for the target date.\n"));
  }
}
