import type { Browser } from "webdriverio";

import { elementWaitMs } from "./config";
import { bookingSelectors } from "./selectors";

export type NavigateToBookingInputs = {
  courtHierarchy: readonly string[];
  desiredTimes: readonly string[];
  secondary: string;
};

function getNextWeek(): string {
    const now = new Date();
    const pstNowString = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const pstNow = new Date(pstNowString);
    const sevenDaysLater = new Date(pstNow.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dayOfMonth = sevenDaysLater.getDate().toString().padStart(2, '0');
    return `//div[@class='day_number' and text()='${dayOfMonth}']`;
}

function desiredTimePath(time: string) : string {
    return `//button[text()='${time}' and not(contains(@class,'basic red'))]`
}

function selectorIsConfigured(xpath: string) {
  return xpath.length > 0 && !xpath.startsWith("REPLACE_WITH_");
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

async function clickXPath(
  browser: Browser,
  name: string,
  xpath: string,
) {
  if (!selectorIsConfigured(xpath)) {
    throw new Error(
      `Define the XPath for ${name} in src/browser/selectors.ts`,
    );
  }

  console.log(`Looking for ${name}...`);

  const maximumAttempts = 2;
  const attemptWaitMs = 10_000;

  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    console.log(
      `${name} attempt ${attempt}: waiting up to ${attemptWaitMs / 1000} seconds...`,
    );

    try {
      await browser.waitUntil(
        () => hasVisibleMatch(browser, xpath),
        {
          timeout: attemptWaitMs,
          interval: 500,
          timeoutMsg: `${name} did not become visible within 10 seconds`,
        },
      );
    } catch {
      console.log(
        `${name} did not become visible during attempt ${attempt}`,
      );
    }

    const elements = await browser.$$(xpath).getElements();

    console.log(
      `${name} matches on attempt ${attempt}: ${elements.length}`,
    );

    for await (const [index, element] of elements.entries()) {
      const displayed = await element.isDisplayed();

      console.log(
        `${name} candidate ${index + 1} displayed: ${displayed}`,
      );

      if (!displayed) {
        continue;
      }

      await element.scrollIntoView({
        block: "center",
        inline: "center",
      });

      const clickable = await element.isClickable();

      console.log(
        `${name} candidate ${index + 1} clickable: ${clickable}`,
      );

      if (clickable) {
        await element.click();
        await browser.pause(1_000);
        console.log(`Clicked visible ${name} candidate ${index + 1}`);
        return;
      }
    }

    if (attempt < maximumAttempts) {
      console.log(`${name} not found or clickable. Retrying once...`);
    }
  }

  throw new Error(`${name} was not found or clickable`);
}

export async function navigateToBooking(
  browser: Browser,
  inputs: NavigateToBookingInputs,
) {
  const { courtHierarchy, desiredTimes, secondary } = inputs;

  console.log("Loaded booking inputs:", {
    courtHierarchy,
    desiredTimes,
    secondary,
  });

  await browser.switchFrame(null);

  const bookingFrame = await browser.$(bookingSelectors.frame).getElement();

  await bookingFrame.waitForExist({
    timeout: elementWaitMs,
    timeoutMsg: "Booking iframe did not appear after login",
  });

  await browser.switchFrame(bookingFrame);
  console.log("Switched into booking iframe");

  await clickXPath(
    browser,
    "Book Now",
    bookingSelectors.bookNow,
  );

  await clickXPath(
    browser,
    "Reserve a full court",
    bookingSelectors.reserveFullCourt,
  );

  await clickXPath(
    browser,
    "Next",
    bookingSelectors.next,
  );

  await clickXPath(
    browser,
    "Type: Pickleball",
    bookingSelectors.typePickleball,
  );

  await clickXPath(
    browser,
    "Next Week",
    getNextWeek(),
  );
}
