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
  elapsedSinceTimerDisappearedMs: number;
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
      // date: "2026-09-28", // temp
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

async function armBookingsForTimerDisappearance(
  browser: Browser,
  courts: readonly string[],
  payload: unknown,
  batchSize: number,
  timerXpath: string,
  bookAtEpochMs: number | undefined,
  delayAfterReleaseMs: number,
): Promise<void> {
  const requests = courts.map((court) => ({
    court,
    courtId: getCourtId(court),
  }));

  await browser.execute(
    (
      requests: Array<{
        court: string;
        courtId: number;
      }>,
      payload: unknown,
      batchSize: number,
      timerXpath: string,
      bookAtEpochMs: number | undefined,
      delayAfterReleaseMs: number,
    ) => {
      type BookingDispatchWindow = Window & {
        __playByPointBookingDispatch?: {
          completed: boolean;
          error?: string;
          results: ConcurrentBookingResponse[];
          timerDisappearedAtMs?: number;
        };
      };

      const dispatchWindow = window as BookingDispatchWindow;
      const state: NonNullable<
        BookingDispatchWindow["__playByPointBookingDispatch"]
      > = {
        completed: false,
        results: [] as ConcurrentBookingResponse[],
      };

      dispatchWindow.__playByPointBookingDispatch = state;

      const now = () =>
        performance.timeOrigin + performance.now();

      const csrfToken = document
        .querySelector('meta[name="csrf-token"]')
        ?.getAttribute("content");

      if (!csrfToken) {
        state.error = "CSRF token not found";
        state.completed = true;
        return;
      }

      const preparedRequests = requests.map(
        ({ court, courtId }) => ({
          court,
          courtId,
          url: `/api/courts/${courtId}/booking_player`,
          options: {
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
          } satisfies RequestInit,
        }),
      );

      const timerIsVisible = () => {
        const snapshot = document.evaluate(
          timerXpath,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );

        for (
          let index = 0;
          index < snapshot.snapshotLength;
          index += 1
        ) {
          const node = snapshot.snapshotItem(index);

          if (!(node instanceof HTMLElement)) {
            continue;
          }

          const style = window.getComputedStyle(node);

          if (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            node.getClientRects().length > 0
          ) {
            return true;
          }
        }

        return false;
      };

      const dispatch = async (
        timerDisappearedAtMs: number,
      ) => {
        try {
          const synchronizedReleaseAt =
            bookAtEpochMs ?? timerDisappearedAtMs;
          const releaseAt =
            Math.max(
              timerDisappearedAtMs,
              synchronizedReleaseAt,
            ) + delayAfterReleaseMs;
          const remainingDelayMs = releaseAt - now();

          if (remainingDelayMs > 0) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, remainingDelayMs);
            });
          }

          for (
            let index = 0;
            index < preparedRequests.length;
            index += batchSize
          ) {
            const batch = preparedRequests.slice(
              index,
              index + batchSize,
            );
            const batchResults = await Promise.all(
              batch.map(
                async ({
                  court,
                  courtId,
                  url,
                  options,
                }): Promise<ConcurrentBookingResponse> => {
                  const requestStartedAt =
                    performance.timeOrigin +
                    performance.now();
                  const elapsedSinceTimerDisappearedMs =
                    requestStartedAt -
                    timerDisappearedAtMs;

                  try {
                    const response = await fetch(
                      url,
                      options,
                    );

                    const text = await response.text();

                    let body: unknown;

                    try {
                      body = JSON.parse(text);
                    } catch {
                      body = text;
                    }

                    const requestCompletedAt =
                      performance.timeOrigin +
                      performance.now();

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
                      elapsedSinceTimerDisappearedMs,
                    };
                  } catch (error) {
                    const requestCompletedAt =
                      performance.timeOrigin +
                      performance.now();

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
                      elapsedSinceTimerDisappearedMs,
                    };
                  }
                },
              ),
            );

            state.results.push(...batchResults);
          }

          state.completed = true;
        } catch (error) {
          state.error =
            error instanceof Error
              ? error.message
              : String(error);
          state.completed = true;
        }
      };

      const dispatchAfterTimerPaints = async (
        timerDisappearedAtMs: number,
      ) => {
        // The first animation frame is scheduled before the next paint. The
        // second runs on the following frame, after Chrome has had a chance
        // to paint the page without the countdown.
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              resolve();
            });
          });
        });

        await dispatch(timerDisappearedAtMs);
      };

      const releaseWhenTimerDisappears = () => {
        if (
          state.timerDisappearedAtMs !== undefined ||
          timerIsVisible()
        ) {
          return false;
        }

        state.timerDisappearedAtMs = now();
        void dispatchAfterTimerPaints(
          state.timerDisappearedAtMs,
        );
        return true;
      };

      if (releaseWhenTimerDisappears()) {
        return;
      }

      const observer = new MutationObserver(() => {
        if (releaseWhenTimerDisappears()) {
          observer.disconnect();
        }
      });

      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    },
    requests,
    payload,
    batchSize,
    timerXpath,
    bookAtEpochMs,
    delayAfterReleaseMs,
  );
}

async function waitForArmedBookingResults(
  browser: Browser,
): Promise<ConcurrentBookingResponse[]> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const state = (
          window as Window & {
            __playByPointBookingDispatch?: {
              completed: boolean;
              error?: string;
            };
          }
        ).__playByPointBookingDispatch;

        return Boolean(state?.completed || state?.error);
      }),
    {
      timeout: 5 * 60 * 1000,
      interval: 25,
      timeoutMsg:
        "Booking requests did not complete within 5 minutes",
    },
  );

  const state = await browser.execute(() =>
    (
      window as Window & {
        __playByPointBookingDispatch?: {
          error?: string;
          results: ConcurrentBookingResponse[];
        };
      }
    ).__playByPointBookingDispatch,
  );

  if (!state) {
    throw new Error("Browser booking dispatch state was lost");
  }

  if (state.error) {
    throw new Error(state.error);
  }

  return state.results;
}

async function waitForTimer(
  browser: Browser,
): Promise<number> {
  let lastLoggedAt = 0;
  let timerDisappearedAtMs: number | undefined;

  await browser.waitUntil(
    async () => {
      const timerState = await browser.execute(
        (
          hoursXpath: string,
          minutesXpath: string,
          secondsXpath: string,
        ) => {
          const dispatchState = (
            window as Window & {
              __playByPointBookingDispatch?: {
                error?: string;
                timerDisappearedAtMs?: number;
              };
            }
          ).__playByPointBookingDispatch;

          const readText = (partXpath: string) => {
            const node = document.evaluate(
              partXpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            ).singleNodeValue;

            return node?.textContent?.trim() ?? "";
          };

          return {
            error: dispatchState?.error,
            timerDisappearedAtMs:
              dispatchState?.timerDisappearedAtMs,
            hours: readText(hoursXpath),
            minutes: readText(minutesXpath),
            seconds: readText(secondsXpath),
          };
        },
        bookingSelectors.hr,
        bookingSelectors.min,
        bookingSelectors.sec,
      );

      if (timerState.error) {
        throw new Error(timerState.error);
      }

      if (
        timerState.timerDisappearedAtMs !== undefined
      ) {
        timerDisappearedAtMs =
          timerState.timerDisappearedAtMs;
        return true;
      }

      const now = Date.now();

      if (now - lastLoggedAt < 1_000) {
        return false;
      }

      lastLoggedAt = now;

      console.log(
        `Booking opens in: ` +
          `${timerState.hours}:` +
          `${timerState.minutes}:` +
          timerState.seconds,
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

  if (timerDisappearedAtMs === undefined) {
    throw new Error(
      "Booking timer disappeared without a browser timestamp",
    );
  }

  return timerDisappearedAtMs;
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

  console.log(
    "Continuing in the existing booking iframe",
  );

  // Prepare and arm the browser-side requests before the timer disappears.
  // This keeps WebDriver out of the time-critical dispatch path.
  const payload = createBookingPayload(
    desiredTimes,
    primary,
    secondary,
  );

  const batchSize =
    desiredTimes === "7pm-9pm" ||
    desiredTimes === "9pm-10pm"
      ? 2
      : 4;
  const delayAfterReleaseMs =
    desiredTimes === "9pm-10pm" ? 500 : 0;

  console.log(
    `Using booking batch size: ${batchSize}`,
  );

  if (bookAtEpochMs !== undefined) {
    console.log(
      `Booking requests are armed for the synchronized time: ` +
        new Date(bookAtEpochMs).toISOString(),
    );
  } else {
    console.log(
      "Booking requests are armed for immediate dispatch when the timer disappears",
    );
  }

  if (delayAfterReleaseMs > 0) {
    console.log(
      `A ${delayAfterReleaseMs}ms post-release delay is configured`,
    );
  }

  await armBookingsForTimerDisappearance(
    browser,
    courtHierarchy,
    payload,
    batchSize,
    bookingSelectors.bookingTimer,
    bookAtEpochMs,
    delayAfterReleaseMs,
  );

  const timerDisappearedAtMs =
    await waitForTimer(browser);

  console.log(
    `Booking timer disappeared at ` +
      `${new Date(timerDisappearedAtMs).toISOString()} ` +
      `(${timerDisappearedAtMs.toFixed(3)}) using the browser clock`,
  );

  const results = await waitForArmedBookingResults(
    browser,
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
        `duration=${result.durationMs.toFixed(3)}ms`,
    );

    console.log(
      `Court ${result.court} fetch started ` +
        `${result.elapsedSinceTimerDisappearedMs.toFixed(3)}ms ` +
        `after the booking timer disappeared`,
    );

    console.log(
      `Court ${result.court} response: ` +
        JSON.stringify(result.body),
    );
  }

  console.log(
    `All ${results.length} booking requests completed.`,
  );

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
