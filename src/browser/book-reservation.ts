import type { Browser } from "webdriverio";

import { bookingSelectors } from "./selectors";

export type ReservationInputs = {
  courtHierarchy: readonly string[];
  desiredTimes: string;
  primary: string;
  secondary: string;
  bookAtEpochMs?: number;
};

interface BookingResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

interface ConcurrentBookingResponse extends BookingResponse {
  court: string;
  courtId: number;
  requestStartedAt: number;
  requestCompletedAt: number;
  durationMs: number;
}

const playerIds: Record<string, number> = {
  "Matt Lim": 883812,
  "Paul Rodriguez": 885123,
  "Yena Kim": 1133177,
  "abraham a": 2413185,
  "Begi A": 3015281,
  "Charlee Liu": 976560,
  "Christina Nguyen": 2303789,
  "Christopher Hernandez": 869562,
  "Derek Dang": 3049673,
  "Dexter Dizon": 850403,
  "E K": 573064,
  "Gil Navarro": 669397,
  "Harrison Yang": 917109,
  "Irene Chang": 2346948,
  "Kelli Hernandez": 2491196,
  "Lia Barnes": 3050120,
  "Mandy Che": 708715,
  "Maria Aleman": 876246,
  "Nate Nget": 3824341,
  "Shawn Yoo": 4024553,
  "Tammy Yik": 4219108,
  "William Kang": 1053057,
};

function getPlayerId(name: string): number {
  const id = playerIds[name];

  if (id === undefined) {
    throw new Error(`No player ID configured for: ${name}`);
  }

  return id;
}

function timeToSeconds(time: string): number {
  const match = time
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);

  if (!match) {
    throw new Error(`Invalid time: ${time}`);
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3];

  if (period === "am") {
    if (hour === 12) {
      hour = 0;
    }
  } else if (hour !== 12) {
    hour += 12;
  }

  return (hour * 60 + minute) * 60;
}

function parseTimeRange(timeRange: string): {
  hourStart: number;
  hourEnd: number;
} {
  const [rawStart, rawEnd] = timeRange
    .replace(/\s/g, "")
    .toLowerCase()
    .split("-");

  if (!rawStart || !rawEnd) {
    throw new Error(`Invalid time range: ${timeRange}`);
  }

  const periodMatch = rawEnd.match(/(am|pm)$/);

  if (!periodMatch) {
    throw new Error(
      `End time must specify am/pm: ${timeRange}`,
    );
  }

  const period = periodMatch[1];

  const start = /(am|pm)$/.test(rawStart)
    ? rawStart
    : `${rawStart}${period}`;

  return {
    hourStart: timeToSeconds(start),
    hourEnd: timeToSeconds(rawEnd),
  };
}

function getBookingDate(): string {
  const pacificDate = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

  const [year, month, day] = pacificDate
    .split("-")
    .map(Number);

  const bookingDate = new Date(
    Date.UTC(year, month - 1, day + 7),
  );

  return bookingDate.toISOString().slice(0, 10);
}

function getCourtId(court: string): number {
  const courtNumber = Number(court);

  if (
    !Number.isInteger(courtNumber) ||
    courtNumber < 1 ||
    courtNumber > 10
  ) {
    throw new Error(`Invalid court: ${court}`);
  }

  return 5594 + courtNumber;
}

function createBookingPayload(
  desiredTime: string,
  primary: string,
  secondary: string,
) {
  const primaryId = getPlayerId(primary);
  const secondaryId = getPlayerId(secondary);

  const { hourStart, hourEnd } =
    parseTimeRange(desiredTime);

  return {
    reservation: {
      date: getBookingDate(),
      // date: "2026-09-28", //temp
      hour_start: hourStart,
      hour_end: hourEnd,
      reservation_type: 2,
      public_game: false,
      min_ntrp: 1,
      max_ntrp: 7,
      kind: "reservation",
      ntrp_verified: false,
    },

    payment: {
      method: "card",
      payment_intent_id: "",
      card_details: {},
      coupon: {
        code: "",
      },
      booking_package_purchase_id: null,
      moment: "now",
    },

    user_ids: [primaryId, secondaryId],

    user_excluded_ids: [],

    user_ids_guest_names: {
      player0: {
        name: null,
      },
      player1: {
        name: null,
      },
    },

    reservation_fees: [],

    users_fees: {
      player0: {
        fees: [null],
      },
      player1: {
        fees: [null],
      },
    },

    auto_fill_courts: false,
    free_fare_players: [],
    guest_pass_users: [],
    booking_package_applies_to_user_ids: [],
  };
}

async function postBooking(
  browser: Browser,
  courtId: number,
  payload: unknown,
): Promise<BookingResponse> {
  const result = await browser.executeAsync(
    (
      courtId: number,
      payload: unknown,
      done: (result: BookingResponse) => void,
    ) => {
      void (async () => {
        try {
          const csrfToken = document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content");

          if (!csrfToken) {
            throw new Error("CSRF token not found");
          }

          const response = await fetch(
            `/api/courts/${courtId}/booking_player`,
            {
              method: "POST",
              credentials: "same-origin",
              headers: {
                Accept:
                  "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
                "X-Requested-With": "XMLHttpRequest",
              },
              body: JSON.stringify(payload),
            },
          );

          const text = await response.text();

          let body: unknown;

          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }

          done({
            status: response.status,
            ok: response.ok,
            body,
          });
        } catch (error) {
          done({
            status: 0,
            ok: false,
            body:
              error instanceof Error
                ? error.message
                : String(error),
          });
        }
      })();
    },
    courtId,
    payload,
  );

  return result;
}

async function postBookingsConcurrently(
  browser: Browser,
  courts: readonly string[],
  payload: unknown,
): Promise<ConcurrentBookingResponse[]> {
  const requests = courts.map((court) => ({
    court,
    courtId: getCourtId(court),
  }));

  return browser.executeAsync(
    (
      requests: Array<{
        court: string;
        courtId: number;
      }>,
      payload: unknown,
      done: (
        results: ConcurrentBookingResponse[],
      ) => void,
    ) => {
      void (async () => {
        try {
          const csrfToken = document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content");

          if (!csrfToken) {
            throw new Error("CSRF token not found");
          }

          const results = await Promise.all(
            requests.map(
              async ({
                court,
                courtId,
              }): Promise<ConcurrentBookingResponse> => {
                const requestStartedAt = Date.now();

                try {
                  const response = await fetch(
                    `/api/courts/${courtId}/booking_player`,
                    {
                      method: "POST",
                      credentials: "same-origin",
                      headers: {
                        Accept:
                          "application/json, text/javascript, */*; q=0.01",
                        "Content-Type": "application/json",
                        "X-CSRF-Token": csrfToken,
                        "X-Requested-With": "XMLHttpRequest",
                      },
                      body: JSON.stringify(payload),
                    },
                  );

                  const text = await response.text();

                  let body: unknown;

                  try {
                    body = JSON.parse(text);
                  } catch {
                    body = text;
                  }

                  const requestCompletedAt = Date.now();

                  return {
                    court,
                    courtId,
                    status: response.status,
                    ok: response.ok,
                    body,
                    requestStartedAt,
                    requestCompletedAt,
                    durationMs:
                      requestCompletedAt -
                      requestStartedAt,
                  };
                } catch (error) {
                  const requestCompletedAt = Date.now();

                  return {
                    court,
                    courtId,
                    status: 0,
                    ok: false,
                    body:
                      error instanceof Error
                        ? error.message
                        : String(error),
                    requestStartedAt,
                    requestCompletedAt,
                    durationMs:
                      requestCompletedAt -
                      requestStartedAt,
                  };
                }
              },
            ),
          );

          done(results);
        } catch (error) {
          throw error;
        }
      })();
    },
    requests,
    payload,
  );
}

async function waitForSynchronizedBookTime(
  browser: Browser,
  bookAtEpochMs?: number,
): Promise<void> {
  if (bookAtEpochMs === undefined) {
    return;
  }

  const remainingMs = bookAtEpochMs - Date.now();

  if (remainingMs <= 0) {
    throw new Error(
      `Synchronized booking time ${new Date(
        bookAtEpochMs,
      ).toISOString()} was already reached before this run was ready`,
    );
  }

  console.log(
    `Waiting for synchronized booking time: ${new Date(
      bookAtEpochMs,
    ).toISOString()}`,
  );

  while (true) {
    const remaining = bookAtEpochMs - Date.now();

    if (remaining <= 0) {
      break;
    }

    await browser.pause(Math.min(250, remaining));
  }

  console.log("Synchronized booking time reached");
}

async function waitForTimer(
  browser: Browser,
  xpath: string,
): Promise<void> {
  let lastLoggedAt = 0;

  await browser.waitUntil(
    async () => {
      const elements = await browser
        .$$(xpath)
        .getElements();

      let timerIsVisible = false;

      for (const element of elements) {
        if (await element.isDisplayed()) {
          timerIsVisible = true;
          break;
        }
      }

      if (!timerIsVisible) {
        await browser.pause(100);
        return true;
      }

      const now = Date.now();

      if (now - lastLoggedAt < 1_000) {
        return false;
      }

      lastLoggedAt = now;

      const readTimerPart = async (
        timerPartXpath: string,
      ) => {
        const timerParts = await browser
          .$$(timerPartXpath)
          .getElements();

        const timerPart = timerParts[0];

        if (!timerPart) {
          return "";
        }

        const textContent =
          await timerPart.getProperty("textContent");

        return String(textContent ?? "").trim();
      };

      const [hours, minutes, seconds] =
        await Promise.all([
          readTimerPart(bookingSelectors.hr),
          readTimerPart(bookingSelectors.min),
          readTimerPart(bookingSelectors.sec),
        ]);

      console.log(
        `Booking opens in: ${hours}:${minutes}:${seconds}`,
      );

      return false;
    },
    {
      timeout: 5 * 60 * 1000,
      interval: 250,
      timeoutMsg:
        "Element was still displayed after 5 minutes",
    },
  );
}

export async function bookReservationAPI(
  browser: Browser,
  inputs: ReservationInputs,
) {
  const {
    courtHierarchy,
    desiredTimes,
    primary,
    secondary,
    bookAtEpochMs,
  } = inputs;

  console.log("Loaded booking inputs:", {
    courtHierarchy,
    desiredTimes,
    primary,
    secondary,
    bookAtEpochMs,
  });

  console.log("Continuing in the existing booking iframe");

  await waitForTimer(
    browser,
    bookingSelectors.bookingTimer,
  );

  console.log(
    `Booking timer disappeared at ${new Date().toISOString()}`,
  );

  await waitForSynchronizedBookTime(
    browser,
    bookAtEpochMs,
  );

  // Delay 9-10pm bookings by 500ms.
  if (desiredTimes === "9pm-10pm") {
    console.log(
      "9-10pm booking. Waiting 500ms before API requests.",
    );

    await browser.pause(500);
  }

  // Build one identical payload for every court.
  const payload = createBookingPayload(
    desiredTimes,
    primary,
    secondary,
  );

  console.log("Booking payload:", payload);

  const requestReleaseAt = Date.now();

  console.log(
    `Launching concurrent booking requests at ` +
      `${new Date(requestReleaseAt).toISOString()} ` +
      `(${requestReleaseAt})`,
  );

  const results = await postBookingsConcurrently(
    browser,
    courtHierarchy,
    payload,
  );

  console.log(
    `All ${results.length} booking requests completed.`,
  );

  for (const result of results) {
    console.log(
      `Court ${result.court} (API ${result.courtId}) -> ` +
        `status=${result.status}; ` +
        `started=${new Date(
          result.requestStartedAt,
        ).toISOString()}; ` +
        `completed=${new Date(
          result.requestCompletedAt,
        ).toISOString()}; ` +
        `duration=${result.durationMs}ms`,
    );

    console.log(
      `Court ${result.court} response: ` +
        JSON.stringify(result.body),
    );
  }

  const successful = results.filter(
    (result) =>
      result.status >= 200 &&
      result.status < 300,
  );

  if (successful.length > 0) {
    console.log(
      `Successful booking response(s): ${successful.length}`,
    );
  } else {
    console.log(
      "No court returned a successful booking response.",
    );
  }

  return results;
}