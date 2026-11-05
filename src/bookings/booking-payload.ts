import { createBookingPayload, getCourtId } from "../browser/book-reservation";
import { loadPlayerIds, type PlayerIds } from "../browser/player-ids";
import type { ActiveBooking } from "../browser/fetch-active-bookings";

export class BookingPayloadError extends Error {}

export function reservationToBookingRequest(booking: ActiveBooking, playerIds: PlayerIds) {
  // The existing booking automation's court ID mapping is specific to Cerritos.
  if (booking.facility !== "iTennis/iPickle Cerritos") {
    throw new BookingPayloadError(`Unsupported facility for reservation ${booking.reference}: ${booking.facility}`);
  }
  const court = booking.court.match(/^Pickleball\s+(\d+)$/)?.[1];
  if (!court) throw new BookingPayloadError(`Unrecognized court for reservation ${booking.reference}`);
  const courtId = getCourtId(court);
  if (booking.players.length !== 2 || new Set(booking.players).size !== 2) {
    throw new BookingPayloadError(`Reservation ${booking.reference} must have exactly two distinct named players to use the existing booking payload.`);
  }
  for (const player of booking.players) {
    if (!Number.isSafeInteger(playerIds[player]) || playerIds[player] <= 0) {
      throw new BookingPayloadError(`No player ID configured for ${player} in reservation ${booking.reference}`);
    }
  }
  const time = booking.time.replace(/\s/g, "");
  if (!/^\d{1,2}:\d{2}(?:AM|PM)-\d{1,2}:\d{2}(?:AM|PM)$/i.test(time)) {
    throw new BookingPayloadError(`Unrecognized time for reservation ${booking.reference}: ${booking.time}`);
  }
  const payload = createBookingPayload(time, booking.players[0], booking.players[1], playerIds);
  // Preserve the retrieved reservation date, including if a run crosses midnight.
  payload.reservation.date = booking.date;
  return {
    sourceReservationId: booking.id,
    sourceReference: booking.reference,
    method: "POST" as const,
    url: `/api/courts/${courtId}/booking_player`,
    payload,
  };
}

export async function logBookingPayloads(bookings: ActiveBooking[]) {
  if (!bookings.length) {
    console.log("No reservations for the target date; no booking payloads to construct.");
    return [];
  }
  const playerIds = await loadPlayerIds();
  const requests = bookings.map(booking => reservationToBookingRequest(booking, playerIds));
  for (const request of requests) {
    console.log(`Booking request preview for ${request.sourceReference}:`);
    console.log(JSON.stringify(request, null, 2));
  }
  return requests;
}
