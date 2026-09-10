import type { Browser } from "webdriverio";
import { bookingSelectors } from "./selectors";
import { bookingInputs, pause } from "./main";

export type ReservationInputs = {
  courtHierarchy: readonly string[];
  desiredTimes: readonly string[];
  primary: string;
  secondary: string;
  day?: string;
  bookAtEpochMs?: number;
};

async function waitForSynchronizedBookTime(
  browser: Browser,
  bookAtEpochMs?: number,
): Promise<void> {
  if (bookAtEpochMs === undefined) {
    return;
  }

  if (Date.now() >= bookAtEpochMs) {
    throw new Error(
      `Synchronized Book release ${new Date(bookAtEpochMs).toISOString()} was reached before this run was ready`,
    );
  }

  console.log(
    `Ready to book. Waiting for synchronized release at ${new Date(bookAtEpochMs).toISOString()}`,
  );

  let lastLoggedSecond = -1;

  while (true) {
    const remainingMs = bookAtEpochMs - Date.now();

    if (remainingMs <= 0) {
      break;
    }

    const remainingSeconds = Math.ceil(remainingMs / 1_000);
    if (remainingSeconds !== lastLoggedSecond) {
      console.log(`Synchronized Book click in ${remainingSeconds}s`);
      lastLoggedSecond = remainingSeconds;
    }

    await browser.pause(Math.min(250, remainingMs));
  }

  console.log("Synchronized Book click released");
}

function desiredTimePath(time: string) : string {
    return `//button[text()='${time}' and not(contains(@class,'basic red'))]`
}

function courtPath(court : string) : string {
    return `//h2[normalize-space()='Select Detail']/..//button[normalize-space()='Pickleball ${court}']`
}

function secondaryPath(name : string) : string {
    return `//span[text()='${name}']/ancestor::div[contains(@class,'flex_grow')]/following-sibling::div/button[text()='Add']`
}

function selectorIsConfigured(xpath: string) {
  return xpath.length > 0 && !xpath.startsWith("REPLACE_WITH_");
}

async function waitForTimer(
  browser: Browser,
  xpath: string,
): Promise<void> {
  let lastLoggedAt = 0;

  await browser.waitUntil(
    async () => {
      const elements = await browser.$$(xpath).getElements();
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

      const readTimerPart = async (timerPartXpath: string) => {
        const timerParts = await browser.$$(timerPartXpath).getElements();
        const timerPart = timerParts[0];

        if (!timerPart) {
          return "";
        }

        const textContent = await timerPart.getProperty("textContent");
        return String(textContent ?? "").trim();
      };

      const [hours, minutes, seconds] = await Promise.all([
        readTimerPart(bookingSelectors.hr),
        readTimerPart(bookingSelectors.min),
        readTimerPart(bookingSelectors.sec),
      ]);

      console.log(`Booking opens in: ${hours}:${minutes}:${seconds}`);
      return false;
    },
    {
      timeout: 5 * 60 * 1000,
      interval: 250,
      timeoutMsg: "Element was still displayed after 5 minutes",
    },
  );
}


async function getAlertText(browser: Browser) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!(await browser.isAlertOpen())) {
        if (attempt < maxAttempts) {
          await browser.pause(500);
        }
        continue;
      }

      const alertText = await browser.getAlertText();

      console.log("Alert text:", alertText);

      await browser.acceptAlert();

      return alertText;
    } catch {
      if (attempt < maxAttempts) {
        await browser.pause(500);
      }
    }
  }

  return null;
}

async function hasVisibleMatch(browser: Browser, xpath: string) {
  const elements = await browser.$$(xpath).getElements();

  for await (const element of elements) {
    if (await element.isDisplayed()) {
      return true;
    }
  }

  return false;
}

async function getTextContent(
  browser: Browser,
  name: string,
  xpath: string,
): Promise<string> {
  const element = browser.$(xpath);
  let text = "";

  await browser.waitUntil(
    async () => {
      const value = await element.getProperty("textContent");
      text = String(value ?? "").trim();

      return text.length > 0;
    },
    {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: `${name} did not have text after 15 seconds`,
    },
  );
  return text;
}

async function clickXPathFast(
  browser: Browser,
  name: string,
  xpath: string,
): Promise<boolean> {
  if (!selectorIsConfigured(xpath)) {
    throw new Error(
      `Define the XPath for ${name} in src/browser/selectors.ts`,
    );
  }

  const maxAttempts = 5;

  for (let clickAttempt = 1; clickAttempt <= maxAttempts; clickAttempt++) {
    try {
      const elements = await browser.$$(xpath).getElements();

      if (elements.length === 0) {
        continue;
      }

      const element = elements[0];

      if (name == "Add Primary" || name == "Add Secondary") {
        await browser.pause(500);
      }

      const bookClickStartedAt = name === "Book" ? Date.now() : undefined;

      if (bookClickStartedAt !== undefined) {
        console.log(
          `Book click dispatch started: ${new Date(bookClickStartedAt).toISOString()} (${bookClickStartedAt})`,
        );
      }

      await browser.execute((el) => {
        (el as HTMLElement).click();
      }, element);

      if (bookClickStartedAt !== undefined) {
        const bookClickCompletedAt = Date.now();
        console.log(
          `Book click dispatch completed: ${new Date(bookClickCompletedAt).toISOString()} (${bookClickCompletedAt}); duration=${bookClickCompletedAt - bookClickStartedAt}ms`,
        );
      }

      if (name.includes("Court")) {
        await browser.waitUntil(
          async () => {
            const currentElements = await browser.$$(xpath).getElements();

            for (const currentElement of currentElements) {
              if (!(await currentElement.isDisplayed())) {
                continue;
              }

              const className = await currentElement.getAttribute("class");
              const classes = String(className ?? "").split(/\s+/);

              if (classes.includes("primary")) {
                console.log("Court clicked verified")
                return true;
              }
            }

            return false;
          },
          {
            timeout: 2_000,
            interval: 50,
            timeoutMsg: `${name} did not become selected`,
          },
        );
      }

      console.log(`Fast Clicked ${name}`);
      return true;
    } catch (error) {
      console.log(`Fast Click attempt ${clickAttempt} failed`);

      if (clickAttempt === maxAttempts) {
        if (name.includes("Court")) {
          console.log(`${name} did not remain selected`);
          return false;
        }

        throw error;
      }

      await browser.pause(100);
    }
  }

  return false;
}

type CapturedPostResponse = {
  transport: "fetch" | "xhr";
  url: string;
  status: number;
  statusText: string;
  body: string;
};

async function beginPostResponseCapture(browser: Browser): Promise<void> {
  await browser.execute(() => {
    type CaptureState = {
      pending: number;
      responses: CapturedPostResponse[];
    };

    type CaptureWindow = typeof window & {
      __playByPointPostCapture?: CaptureState;
      __playByPointPostCaptureInstalled?: boolean;
    };

    type CapturedXhr = XMLHttpRequest & {
      __playByPointMethod?: string;
      __playByPointUrl?: string;
    };

    const captureWindow = window as CaptureWindow;
    const state = captureWindow.__playByPointPostCapture ?? {
      pending: 0,
      responses: [],
    };

    state.pending = 0;
    state.responses = [];
    captureWindow.__playByPointPostCapture = state;

    if (captureWindow.__playByPointPostCaptureInstalled) {
      return;
    }

    captureWindow.__playByPointPostCaptureInstalled = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const [input, init] = args;
      const method = String(
        init?.method ?? (input instanceof Request ? input.method : "GET"),
      ).toUpperCase();
      const url = String(input instanceof Request ? input.url : input);

      if (method !== "POST") {
        return originalFetch(...args);
      }

      state.pending += 1;

      try {
        const response = await originalFetch(...args);
        const body = await response.clone().text();

        state.responses.push({
          transport: "fetch",
          url: response.url || url,
          status: response.status,
          statusText: response.statusText,
          body,
        });

        return response;
      } catch (error) {
        state.responses.push({
          transport: "fetch",
          url,
          status: 0,
          statusText: "Fetch failed",
          body: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        });
        throw error;
      } finally {
        state.pending -= 1;
      }
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ) {
      const request = this as CapturedXhr;
      request.__playByPointMethod = String(method).toUpperCase();
      request.__playByPointUrl = String(url);

      return originalOpen.call(
        this,
        method,
        url,
        async,
        username,
        password,
      );
    };

    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const request = this as CapturedXhr;

      if (request.__playByPointMethod === "POST") {
        state.pending += 1;

        this.addEventListener(
          "loadend",
          () => {
            let responseBody = "";

            try {
              responseBody = this.responseText;
            } catch (error) {
              responseBody = JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              });
            }

            state.responses.push({
              transport: "xhr",
              url: this.responseURL || request.__playByPointUrl || "",
              status: this.status,
              statusText: this.statusText,
              body: responseBody,
            });
            state.pending -= 1;
          },
          { once: true },
        );
      }

      return originalSend.call(this, body);
    };
  });
}

async function logCapturedPostResponses(
  browser: Browser,
): Promise<CapturedPostResponse[]> {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const state = (
            window as typeof window & {
              __playByPointPostCapture?: {
                pending: number;
                responses: CapturedPostResponse[];
              };
            }
          ).__playByPointPostCapture;

          return Boolean(
            state && state.pending === 0 && state.responses.length > 0,
          );
        }),
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "No completed POST response was captured after Book click",
      },
    );
  } catch {
    console.log("No completed fetch/XHR POST response captured after Book click");
  }

  const responses = await browser.execute(() => {
    const state = (
      window as typeof window & {
        __playByPointPostCapture?: {
          pending: number;
          responses: CapturedPostResponse[];
        };
      }
    ).__playByPointPostCapture;

    if (!state) {
      return [];
    }

    return state.responses.splice(0, state.responses.length);
  });

  for (const [index, response] of responses.entries()) {
    console.log(
      `Book POST ${index + 1}: ${response.transport.toUpperCase()} ${response.url}`,
    );
    console.log(
      `Book POST ${index + 1} status: ${response.status} ${response.statusText}`.trim(),
    );
    console.log(`Book POST ${index + 1} raw response: ${response.body}`);
  }

  return responses;
}

function bookingApiFailure(
  responses: CapturedPostResponse[],
): string | null {
  const bookingResponse = responses.find((response) =>
    response.url.includes("/booking_player"),
  );

  if (
    !bookingResponse ||
    (bookingResponse.status >= 200 && bookingResponse.status < 300)
  ) {
    return null;
  }

  try {
    const body = JSON.parse(bookingResponse.body) as {
      errors?: unknown;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(body.errors)) {
      return body.errors.map(String).join("\n");
    }

    if (typeof body.errors === "string") {
      return body.errors;
    }

    if (typeof body.error === "string") {
      return body.error;
    }

    if (typeof body.message === "string") {
      return body.message;
    }
  } catch {
    // Fall through to the raw response/status description.
  }

  if (bookingResponse.body.trim()) {
    return bookingResponse.body;
  }

  return `Booking API returned status ${bookingResponse.status} ${bookingResponse.statusText}`.trim();
}

async function clickBookAndCaptureResponses(
  browser: Browser,
): Promise<string | null> {
  await beginPostResponseCapture(browser);
  await clickXPathFast(browser, "Book", bookingSelectors.book);
  const responses = await logCapturedPostResponses(browser);
  const apiFailure = bookingApiFailure(responses);
  const alertText = await getAlertText(browser);

  if (apiFailure !== null) {
    console.log(`Booking API error: ${apiFailure}`);
    return apiFailure;
  }

  return alertText;
}

export async function bookReservation(
  browser: Browser,
  inputs: ReservationInputs,
) {
  const {
    courtHierarchy,
    desiredTimes,
    primary,
    secondary,
    day,
    bookAtEpochMs,
  } = inputs;

  console.log("Loaded booking inputs:", {
    courtHierarchy,
    desiredTimes,
    primary,
    secondary,
    day,
    bookAtEpochMs,
  });

  console.log("Continuing in the existing booking iframe");

  // wait until time slots are available
  await waitForTimer(
    browser,
    bookingSelectors.bookingTimer,
  );

  // click the times
  let initialBook = false;
  for (const time of desiredTimes) {
    let clicked = await clickXPathFast(
      browser,
      time,
      desiredTimePath(time),
    );
    console.log(`${time}: ${clicked}`)
    if (clicked) {
      initialBook = true;
    } else {
      if (initialBook) {
        break;
      }
    }
  }
  await browser.pause(500);

  // click courts
  let attemptedCourts = [];
  let selectedCourt: string | undefined;

  for (const court of courtHierarchy) {
    attemptedCourts.push(court)
    const clicked = await clickXPathFast(
      browser,
      `Court ${court}`,
      courtPath(court),
    );

    if (clicked) {
      selectedCourt = court;
      break;
    } else {
      console.log(`Court ${court} not available`)
    }
  }

  if (!selectedCourt) {
    console.log("No preferred court was available. Completing the workflow without a reservation.");
    return;
  }

  // next
  await clickXPathFast(
    browser,
    "Next",
    bookingSelectors.nextCourt,
  );

  // If primary user is provided, add that person
  if (bookingInputs.primary != "") {
    // remove primary user
    await clickXPathFast(
      browser,
      "Remove Primary",
      bookingSelectors.removePrimary,
    );

    // Add user
    await clickXPathFast(
      browser,
      "Add User",
      bookingSelectors.addUser,
    );

    // Add secondary
    await clickXPathFast(
      browser,
      "Add Primary",
      secondaryPath(primary),
    );
    
    // short pause to register user added
    await browser.pause(500)
  } 

  // Add user
  await clickXPathFast(
    browser,
    "Add User",
    bookingSelectors.addUser,
  );

  // Add secondary
  await clickXPathFast(
    browser,
    "Add Secondary",
    secondaryPath(secondary),
  );

  // Next
  await clickXPathFast(
    browser,
    "Next",
    bookingSelectors.nextUser,
  );

  await waitForSynchronizedBookTime(browser, bookAtEpochMs);

  // Book
  let alertText = await clickBookAndCaptureResponses(browser);

  while (alertText !== null) {
    while (
      alertText !== null &&
      alertText.includes("Too many requests")
    ) {
      return
      await browser.pause(10_000);

      alertText = await clickBookAndCaptureResponses(browser);
    }

    if (alertText === null) {
      break;
    }

    // if all courts have been attempted, break loop
    if (attemptedCourts.length >= courtHierarchy.length) {
      break;
    }

    // reset alert text
    alertText = null;
    selectedCourt = undefined;

    // select next available court
    for (const court of courtHierarchy) {
      if (attemptedCourts.includes(court)) {
        continue;
      }
      attemptedCourts.push(court)
      const clicked = await clickXPathFast(
        browser,
        `Try again c: ${court}`,
        courtPath(court),
      );

      if (clicked) {
        selectedCourt = court;
        break;
      } else {
        console.log(`Court ${court} not available`)
      }
    }

    if (!selectedCourt) {
      console.log("No remaining preferred court was available. Completing the workflow without a reservation.");
      return;
    }

    // book again
    alertText = await clickBookAndCaptureResponses(browser);
  }

  if (alertText !== null) {
    console.log(`Booking could not be completed for this reason: ${alertText}`)
  } else {
    // get confirmation number
    const confirmationNumber = await getTextContent(
      browser,
      "Confirmation Number",
      bookingSelectors.confirmationNumber,
    );
    console.log(`Booking successful! Here is the confirmation number: ${confirmationNumber}`)
  }

  await browser.pause(3_000);
}
