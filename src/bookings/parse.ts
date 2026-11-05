import { load } from "cheerio";

export type Booking = {
  id: number;
  reference: string;
  facility: string;
  court: string;
  dateLabel: string;
  time: string;
  status: string;
  canCancel: boolean;
  players: string[];
};

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

export function parseBookings(html: string) {
  const $ = load(html);
  if (!$("#reservations").length || $("#user_password").length) {
    throw new Error("Expected the authenticated My Bookings page; login may have expired or the page changed.");
  }
  const bookings: Booking[] = [];
  $("#reservations [id^='list-res-']").each((_, element) => {
    const card = $(element);
    const id = Number(card.attr("id")?.replace("list-res-", ""));
    const href = card.find("a[href^='/reservations/']").attr("href");
    const reference = href?.match(/^\/reservations\/(RES[A-Z0-9]+)$/)?.[1];
    const facility = clean(card.find("a[href^='/f/']").text());
    const court = clean(card.find(".text.grey.semi.bold").first().text()).replace(/^»\s*/, "");
    const dateLabel = clean(card.find(".icon-calendar").parent().find(".text.black.semi.bold").text());
    const time = clean(card.find(".meta").first().text());
    const status = clean(card.find(".pbc_reservation_status_text").text()).toLowerCase();
    if (!Number.isSafeInteger(id) || id <= 0 || !reference || !facility || !court || !dateLabel || !time || !status) {
      throw new Error("A reservation card has missing or unrecognized fields; refusing an incomplete report.");
    }
    bookings.push({ id, reference, facility, court, dateLabel, time, status,
      canCancel: card.find('[data-react-class="CancelReservation"]').length > 0,
      players: card.find('.UserAvatar[data-tooltip]').toArray().map(el => $(el).attr('data-tooltip')!),
    });
  });
  if ($("#reservations .my-booking-item").length !== bookings.length) {
    throw new Error("Unrecognized reservation cards; refusing an incomplete report.");
  }
  const nextPages = $("#reservations a[rel='next'], .pagination a[rel='next'], .pagination a.next, a.next_page:not(.disabled)")
    .toArray().map(el => $(el).attr("href")).filter((href): href is string => Boolean(href));
  return { bookings, nextPages };
}

// The list omits the year. Read it from the detail page rather than guessing at New Year.
export function parseBookingDate(html: string, id: number): string {
  const $ = load(html);
  const props = $("[data-react-class='ReservationDetails']").attr("data-react-props");
  if (!props || JSON.parse(props).reservationRealId !== id) {
    throw new Error(`Unexpected detail page for reservation ${id}`);
  }
  const text = clean($(".icon-calendar").first().parent().find(".content").text());
  const match = text.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = match ? months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1 : 0;
  if (!match || !month) throw new Error(`Could not read full date for reservation ${id}`);
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  if (new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid reservation date");
  return date;
}
