import assert from "node:assert/strict";
import { test } from "node:test";
import { reservationToBookingRequest } from "../../src/bookings/booking-payload";
import type { ActiveBooking } from "../../src/browser/fetch-active-bookings";

const booking: ActiveBooking = {
  id: 123, reference: "RES123", facility: "iTennis/iPickle Cerritos",
  court: "Pickleball 1", dateLabel: "Wed, Nov 11", date: "2026-11-11",
  time: "07:30 AM - 08:30 AM", status: "booked", canCancel: true,
  players: ["Player One", "Player Two"],
};
const playerIds = { "Player One": 101, "Player Two": 202 };

test("converts the source reservation into the existing booking API payload", () => {
  assert.deepEqual(reservationToBookingRequest(booking, playerIds), {
    sourceReservationId: 123, sourceReference: "RES123", method: "POST",
    url: "/api/courts/5595/booking_player",
    payload: {
      reservation: {
        date: "2026-11-11", hour_start: 27000, hour_end: 30600,
        reservation_type: 2, public_game: false, min_ntrp: 1, max_ntrp: 7,
        kind: "reservation", ntrp_verified: false,
      },
      payment: {
        method: "card", payment_intent_id: "", card_details: {}, coupon: { code: "" },
        booking_package_purchase_id: null, moment: "now",
      },
      user_ids: [101, 202], user_excluded_ids: [],
      user_ids_guest_names: { player0: { name: null }, player1: { name: null } },
      reservation_fees: [], users_fees: { player0: { fees: [null] }, player1: { fees: [null] } },
      auto_fill_courts: false, free_fare_players: [], guest_pass_users: [],
      booking_package_applies_to_user_ids: [],
    },
  });
});

test("retains afternoon times and court rather than substituting preferences", () => {
  const request = reservationToBookingRequest({ ...booking, court: "Pickleball 9", time: "08:00 PM - 10:00 PM" }, playerIds);
  assert.equal(request.url, "/api/courts/5603/booking_player");
  assert.equal(request.payload.reservation.hour_start, 72000);
  assert.equal(request.payload.reservation.hour_end, 79200);
});

test("rejects incomplete player data and unsupported reservation formats", () => {
  assert.throws(() => reservationToBookingRequest(booking, {}), /No player ID/);
  assert.throws(() => reservationToBookingRequest({ ...booking, players: [] }, playerIds), /exactly two/);
  assert.throws(() => reservationToBookingRequest({ ...booking, facility: "Other Club" }, playerIds), /Unsupported facility/);
  assert.throws(() => reservationToBookingRequest({ ...booking, court: "Unknown" }, playerIds), /Unrecognized court/);
  assert.throws(() => reservationToBookingRequest({ ...booking, time: "Unknown" }, playerIds), /Unrecognized time/);
});
