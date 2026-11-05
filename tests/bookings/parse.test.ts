import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBookings, parseBookingDate } from "../../src/bookings/parse";

function card(id: number, action = "CancelReservation", status = "booked") {
  return `<div class="my-booking-item"><div id="list-res-${id}">
    <a href="/f/test">Test &amp; Club</a>
    <div class="text grey semi bold"><span>» Pickleball 1</span></div>
    <div><i class="icon-calendar"></i><div><div class="text black semi bold">Wed, Nov 11</div><div class="meta">07:30 AM - 08:30 AM</div></div></div>
    <span class="pbc_reservation_status_text">${status}</span>
    <div class="UserAvatar" data-tooltip="Test Player"></div>
    <div data-react-class="${action}"></div>
    <a href="/reservations/RES${id}">Details</a>
  </div></div>`;
}

function details(id: number, date: string) {
  return `<div data-react-class="ReservationDetails" data-react-props='{ "reservationRealId": ${id} }'></div>
    <div><i class="icon-calendar"></i><div class="content">${date} <div>07:30 AM - 08:30 AM</div></div></div>`;
}

test("extracts bookings and distinguishes cancel from leave", () => {
  const result = parseBookings(`<div id="reservations">${card(123)}${card(456, "LeaveReservation")}</div>`);
  assert.equal(result.bookings.length, 2);
  assert.deepEqual(result.bookings[0], { id: 123, reference: "RES123", facility: "Test & Club", court: "Pickleball 1", dateLabel: "Wed, Nov 11", time: "07:30 AM - 08:30 AM", status: "booked", canCancel: true, players: ["Test Player"] });
  assert.equal(result.bookings[1].canCancel, false);
});

test("valid empty list is distinct from login or unrecognized HTML", () => {
  assert.deepEqual(parseBookings('<div id="reservations"></div>').bookings, []);
  assert.throws(() => parseBookings('<input id="user_password">'));
  assert.throws(() => parseBookings('<html>Access denied</html>'));
});

test("fails on incomplete or changed reservation cards", () => {
  assert.throws(() => parseBookings(`<div id="reservations">${card(123).replace('class="meta"', 'class="changed"')}</div>`));
  assert.throws(() => parseBookings('<div id="reservations"><div class="my-booking-item">Unknown</div></div>'));
});

test("finds the next page", () => {
  assert.deepEqual(parseBookings('<div id="reservations"></div><div class="pagination"><a rel="next" href="/account/reservations?page=2">Next</a></div>').nextPages, ['/account/reservations?page=2']);
});

test("reads the explicit year from the matching detail page", () => {
  assert.equal(parseBookingDate(details(123, "Wednesday, Nov 11, 2026"), 123), "2026-11-11");
  assert.equal(parseBookingDate(details(123, "Friday, Jan 01, 2027"), 123), "2027-01-01");
  assert.throws(() => parseBookingDate(details(456, "Wednesday, Nov 11, 2026"), 123));
  assert.throws(() => parseBookingDate(details(123, "Date unavailable"), 123));
  assert.throws(() => parseBookingDate(details(123, "Wednesday, Feb 30, 2026"), 123));
});
