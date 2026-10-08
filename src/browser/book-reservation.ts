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
  elapsedSinceReleaseMs: number;
}

interface UtcClockCalibration {
  status: "pending" | "success" | "failed";
  offsetMs?: number;
  roundTripMs?: number;
  source?: string;
  uncertaintyMs?: number;
  error?: string;
}

interface TimerWaitResult {
  releaseAtMs: number;
  releaseReason: "timer" | "utc";
  utcCalibrationLogged: boolean;
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
          releaseAtMs?: number;
          releaseReason?: "timer" | "utc";
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
        releaseAtMs: number,
        releaseReason: "timer" | "utc",
      ) => {
        try {
          const synchronizedReleaseAt =
            bookAtEpochMs ?? releaseAtMs;
          const releaseAt =
            Math.max(
              releaseAtMs,
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
                  const elapsedSinceReleaseMs =
                    requestStartedAt -
                    releaseAtMs;

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
                      elapsedSinceReleaseMs,
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
                      elapsedSinceReleaseMs,
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
        releaseAtMs: number,
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

        await dispatch(releaseAtMs, "timer");
      };

      const pacificTime = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });

      const getPacificParts = (timestampMs: number) => {
        const parts = pacificTime.formatToParts(
          new Date(timestampMs),
        );
        const part = (type: Intl.DateTimeFormatPartTypes) =>
          Number(parts.find((item) => item.type === type)?.value);

        return {
          year: part("year"),
          month: part("month"),
          day: part("day"),
          hour: part("hour"),
          minute: part("minute"),
          second: part("second"),
        };
      };

      const pacificDateTimeToEpochMs = (
        year: number,
        month: number,
        day: number,
        hour: number,
      ) => {
        const intendedUtcMs = Date.UTC(
          year,
          month - 1,
          day,
          hour,
          0,
          0,
          0,
        );
        let timestampMs = intendedUtcMs;

        // Convert a Pacific wall-clock time into an absolute timestamp,
        // including the current PST/PDT offset.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const actual = getPacificParts(timestampMs);
          const actualAsUtcMs = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour,
            actual.minute,
            actual.second,
            0,
          );
          timestampMs += intendedUtcMs - actualAsUtcMs;
        }

        return timestampMs;
      };

      const nextSevenAmPacificMs = () => {
        const currentMs = now();
        const current = getPacificParts(currentMs);
        let target = pacificDateTimeToEpochMs(
          current.year,
          current.month,
          current.day,
          7,
        );

        if (target <= currentMs) {
          const tomorrow = new Date(
            Date.UTC(
              current.year,
              current.month - 1,
              current.day + 1,
            ),
          );
          target = pacificDateTimeToEpochMs(
            tomorrow.getUTCFullYear(),
            tomorrow.getUTCMonth() + 1,
            tomorrow.getUTCDate(),
            7,
          );
        }

        return target;
      };

      let observer: MutationObserver | undefined;
      let utcReleaseTimer: number | undefined;

      const release = (
        releaseAtMs: number,
        releaseReason: "timer" | "utc",
      ) => {
        if (state.releaseAtMs !== undefined) {
          return false;
        }

        state.releaseAtMs = releaseAtMs;
        state.releaseReason = releaseReason;

        if (releaseReason === "timer") {
          state.timerDisappearedAtMs = releaseAtMs;
          void dispatchAfterTimerPaints(releaseAtMs);
        } else {
          void dispatch(releaseAtMs, releaseReason);
        }

        if (observer) {
          observer.disconnect();
        }

        if (utcReleaseTimer !== undefined) {
          window.clearTimeout(utcReleaseTimer);
        }

        return true;
      };

      const releaseWhenTimerDisappears = () => {
        if (timerIsVisible()) {
          return false;
        }

        return release(now(), "timer");
      };

      if (releaseWhenTimerDisappears()) {
        return;
      }

      observer = new MutationObserver(() => {
        if (releaseWhenTimerDisappears()) {
          observer?.disconnect();
        }
      });

      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });

      const pacificReleaseAtMs = nextSevenAmPacificMs();
      utcReleaseTimer = window.setTimeout(() => {
        release(pacificReleaseAtMs, "utc");
      }, Math.max(0, pacificReleaseAtMs - now()));
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

async function startUtcClockCalibration(
  browser: Browser,
): Promise<void> {
  await browser.execute(() => {
    type UtcCalibrationWindow = Window & {
      __playByPointUtcCalibration?: UtcClockCalibration;
    };

    const calibrationWindow = window as UtcCalibrationWindow;
    const calibration: UtcClockCalibration = {
      status: "pending",
    };

    calibrationWindow.__playByPointUtcCalibration = calibration;

    void (async () => {
      const requestStartedAt =
        performance.timeOrigin + performance.now();
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, 5_000);

      try {
        const response = await fetch(
          "https://worldtimeapi.org/api/timezone/Etc/UTC",
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const responseReceivedAt =
          performance.timeOrigin + performance.now();
        const body = (await response.json()) as {
          utc_datetime?: unknown;
        };
        const utcEpochMs = Date.parse(
          String(body.utc_datetime ?? ""),
        );

        if (!response.ok || !Number.isFinite(utcEpochMs)) {
          throw new Error("UTC time service returned no valid UTC timestamp");
        }

        const roundTripMs =
          responseReceivedAt - requestStartedAt;
        const browserMidpointMs =
          requestStartedAt + roundTripMs / 2;

        calibration.offsetMs =
          utcEpochMs - browserMidpointMs;
        calibration.roundTripMs = roundTripMs;
        calibration.source = "WorldTimeAPI";
        calibration.uncertaintyMs = roundTripMs / 2;
        calibration.status = "success";
      } catch (error) {
        try {
          const fallbackStartedAt =
            performance.timeOrigin + performance.now();
          const fallbackResponse = await fetch("/", {
            cache: "no-store",
            credentials: "same-origin",
            method: "HEAD",
          });
          const fallbackReceivedAt =
            performance.timeOrigin + performance.now();
          const serverDateMs = Date.parse(
            fallbackResponse.headers.get("date") ?? "",
          );

          if (
            !fallbackResponse.ok ||
            !Number.isFinite(serverDateMs)
          ) {
            throw new Error(
              "PlayByPoint did not return a valid UTC Date header",
            );
          }

          const roundTripMs =
            fallbackReceivedAt - fallbackStartedAt;
          const browserMidpointMs =
            fallbackStartedAt + roundTripMs / 2;

          calibration.offsetMs =
            serverDateMs - browserMidpointMs;
          calibration.roundTripMs = roundTripMs;
          calibration.source = "PlayByPoint server Date header";
          // HTTP Date headers have one-second precision.
          calibration.uncertaintyMs =
            500 + roundTripMs / 2;
          calibration.status = "success";
        } catch (fallbackError) {
          calibration.error =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          calibration.status = "failed";
        }
      } finally {
        window.clearTimeout(timeoutId);
      }
    })();
  });
}

function logUtcClockCalibration(
  calibration: UtcClockCalibration | null | undefined,
): boolean {
  if (calibration?.status === "pending" || !calibration) {
    return false;
  }

  if (calibration.status === "failed") {
    console.log(
      `UTC clock calibration unavailable: ${calibration.error}`,
    );
    return true;
  }

  const offsetMs = calibration.offsetMs;
  const roundTripMs = calibration.roundTripMs;
  const uncertaintyMs = calibration.uncertaintyMs;
  const source = calibration.source;

  if (
    typeof offsetMs !== "number" ||
    typeof roundTripMs !== "number" ||
    typeof uncertaintyMs !== "number" ||
    !source
  ) {
    console.log("UTC clock calibration returned incomplete data");
    return true;
  }

  const direction = offsetMs >= 0 ? "behind" : "ahead of";

  console.log(
    `Browser clock is ${Math.abs(offsetMs).toFixed(1)}ms ${direction} ` +
      `UTC (${source}; request round trip: ${roundTripMs.toFixed(1)}ms; ` +
      `estimated uncertainty: ±${uncertaintyMs.toFixed(1)}ms)`,
  );

  return true;
}

async function readUtcClockCalibration(
  browser: Browser,
): Promise<UtcClockCalibration | null> {
  return browser.execute(() =>
    (
      window as Window & {
        __playByPointUtcCalibration?: UtcClockCalibration;
      }
    ).__playByPointUtcCalibration ?? null,
  );
}

async function waitForTimer(
  browser: Browser,
): Promise<TimerWaitResult> {
  let lastLoggedAt = 0;
  let releaseAtMs: number | undefined;
  let releaseReason: "timer" | "utc" | undefined;
  let utcCalibrationLogged = false;

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
                releaseAtMs?: number;
                releaseReason?: "timer" | "utc";
                timerDisappearedAtMs?: number;
              };
              __playByPointUtcCalibration?: UtcClockCalibration;
            }
          ).__playByPointBookingDispatch;
          const utcCalibration = (
            window as Window & {
              __playByPointUtcCalibration?: UtcClockCalibration;
            }
          ).__playByPointUtcCalibration;

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
            browserNowMs:
              performance.timeOrigin + performance.now(),
            releaseAtMs: dispatchState?.releaseAtMs,
            releaseReason: dispatchState?.releaseReason,
            timerDisappearedAtMs:
              dispatchState?.timerDisappearedAtMs,
            hours: readText(hoursXpath),
            minutes: readText(minutesXpath),
            seconds: readText(secondsXpath),
            utcCalibration,
          };
        },
        bookingSelectors.hr,
        bookingSelectors.min,
        bookingSelectors.sec,
      );

      if (timerState.error) {
        throw new Error(timerState.error);
      }

      if (!utcCalibrationLogged) {
        utcCalibrationLogged = logUtcClockCalibration(
          timerState.utcCalibration,
        );
      }

      if (
        (timerState.releaseReason === "timer" ||
          timerState.releaseReason === "utc") &&
        typeof timerState.releaseAtMs === "number" &&
        Number.isFinite(timerState.releaseAtMs)
      ) {
        releaseAtMs = timerState.releaseAtMs;
        releaseReason = timerState.releaseReason;
        return true;
      }

      const now = Date.now();

      if (now - lastLoggedAt < 1_000) {
        return false;
      }

      lastLoggedAt = now;

      const utcOffsetMs =
        timerState.utcCalibration?.status === "success"
          ? timerState.utcCalibration.offsetMs
          : undefined;
      const utcText =
        typeof utcOffsetMs === "number" &&
        typeof timerState.browserNowMs === "number"
          ? new Date(
              timerState.browserNowMs + utcOffsetMs,
            ).toISOString()
          : timerState.utcCalibration?.status === "failed"
            ? "unavailable"
            : "calibrating";

      console.log(
        `Booking opens in: ` +
          `${timerState.hours}:` +
          `${timerState.minutes}:` +
          `${timerState.seconds}; UTC is ${utcText}`,
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

  if (
    typeof releaseAtMs !== "number" ||
    !Number.isFinite(releaseAtMs) ||
    (releaseReason !== "timer" && releaseReason !== "utc")
  ) {
    throw new Error(
      "Booking release occurred without a browser timestamp",
    );
  }

  return {
    releaseAtMs,
    releaseReason,
    utcCalibrationLogged,
  };
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
      "Booking requests are armed for the first of the timer disappearing or 07:00 Pacific Time",
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

  await startUtcClockCalibration(browser);

  const {
    releaseAtMs,
    releaseReason,
    utcCalibrationLogged,
  } =
    await waitForTimer(browser);

  if (releaseReason === "timer") {
    console.log(
      `Booking timer disappeared at ` +
        `${new Date(releaseAtMs).toISOString()} ` +
        `(${releaseAtMs.toFixed(3)}) using the browser clock`,
    );
  } else {
    console.log(
      `Booking released at 07:00 Pacific Time: ` +
        `${new Date(releaseAtMs).toISOString()} ` +
        `(${releaseAtMs.toFixed(3)}) using the browser clock`,
    );
  }

  const results = await waitForArmedBookingResults(
    browser,
  );

  if (!utcCalibrationLogged) {
    logUtcClockCalibration(
      await readUtcClockCalibration(browser),
    );
  }

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
        `${result.elapsedSinceReleaseMs.toFixed(3)}ms ` +
        `after the ${
          releaseReason === "timer"
            ? "booking timer disappeared"
            : "07:00 Pacific Time release"
        }`,
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

    for (const result of successful) {
      console.log(
        `Confirmed booking: Court ${result.court}, ${desiredTimes}`,
      );
    }
  } else {
    console.log(
      "No court returned a successful booking response.",
    );
  }

  return results;
}
