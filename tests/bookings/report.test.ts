import assert from "node:assert/strict";
import { test } from "node:test";
import { createBookingReport } from "../../src/bookings/report";
import type { ActiveBooking } from "../../src/browser/fetch-active-bookings";

const booking = (id: number, date: string): ActiveBooking => ({
  id, reference: `RES${id}`, date, dateLabel: date,
  facility: "Test Club", court: "Pickleball 1", time: "07:30 AM - 08:30 AM",
  status: "booked", canCancel: true, players: ["Test Player"],
});

test("selects only bookings one week from the Pacific current date", context => {
  // It is already Nov 5 UTC, but still Nov 4 in California.
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-05T01:00:00Z") });
  const matching = booking(2, "2026-11-11");
  const report = createBookingReport([booking(1, "2026-11-04"), matching, booking(3, "2026-11-12")], "2");
  assert.equal(report.targetDate, "2026-11-11");
  assert.equal(report.targetCount, 1);
  assert.deepEqual(report.targetBookings, [matching]);
  assert.equal(report.activeCount, 3);
});

test("uses the booking date helper across year rollover", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-29T20:00:00Z") });
  const report = createBookingReport([], "2");
  assert.equal(report.targetDate, "2027-01-05");
  assert.equal(report.targetCount, 0);
});

test("advances seven calendar days across daylight saving time", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-03-02T07:30:00Z") });
  assert.equal(createBookingReport([], "2").targetDate, "2026-03-08");
});
