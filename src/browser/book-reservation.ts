import type { Browser } from "webdriverio";
import { bookingSelectors } from "./selectors";
import { pause } from "./main";

export type ReservationInputs = {
  courtHierarchy: readonly string[];
  desiredTimes: readonly string[];
  secondary: string;
};

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
        await browser.pause(750);
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

      if (name == "Add Secondary") {
        await browser.pause(750);
      }

      await browser.execute((el) => {
        (el as HTMLElement).click();
      }, element);

      console.log(`Fast Clicked ${name}`);
      return true;
    } catch (error) {
      console.log(`Fast Click attempt ${clickAttempt} failed`);

      if (clickAttempt === maxAttempts) {
        throw error;
      }

      await browser.pause(100);
    }
  }

  return false;
}

export async function bookReservation(
  browser: Browser,
  inputs: ReservationInputs,
) {
  const { courtHierarchy, desiredTimes, secondary } = inputs;

  console.log("Loaded booking inputs:", {
    courtHierarchy,
    desiredTimes,
    secondary,
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
    throw new Error("None of the preferred courts could be clicked");
  }

  // next
  await clickXPathFast(
    browser,
    "Next",
    bookingSelectors.nextCourt,
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
    "Add Secondary",
    secondaryPath(secondary),
  );

  // Next
  await clickXPathFast(
    browser,
    "Next",
    bookingSelectors.nextUser,
  );

  await pause();

  // Book
  await clickXPathFast(
    browser,
    "Book",
    bookingSelectors.book,
  );

  let alertText = await getAlertText(browser)

  while (alertText !== null) {
    // if all courts have been attempted, break loop
    if (attemptedCourts.length >= courtHierarchy.length) {
      break;
    }

    // reset alert text
    alertText = null;

    // select next available court
    for (const court of courtHierarchy) {
      if (attemptedCourts.includes(court)) {
        continue;
      }
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

    // book again
    await clickXPathFast(
      browser,
      "Book",
      bookingSelectors.book,
    );

    alertText = await getAlertText(browser)
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
