import type { Browser } from "webdriverio";

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

      await element.click();
        await browser.pause(1000);
        console.log(`Clicked visible ${name} candidate ${index + 1}`);
        return;
    }

    if (attempt < maximumAttempts) {
      console.log(`${name} not found or clickable. Retrying once...`);
    }
  }

  throw new Error(`${name} was not found or clickable`);
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

  // console.log(`Looking for ${name}...`);

  const maximumAttempts = 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const elements = await browser.$$(xpath).getElements();
    for await (const [index, element] of elements.entries()) {
      console.log(
        `Fast clicking: ${name}`,
      );

      await element.click();
      await browser.pause(100);
      console.log(`Clicked visible ${name} candidate ${index + 1}`);
      return true;
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

  // check if counter is visible

  // if no counter, click the courts
  for (const time of desiredTimes) {
    await clickXPathFast(
      browser,
      time,
      desiredTimePath(time),
    );
  }

  // click courts
  let selectedCourt: string | undefined;

  for (const court of courtHierarchy) {
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

  console.log(`Selected preferred court ${selectedCourt}`);
  await browser.pause(3_000);
}
