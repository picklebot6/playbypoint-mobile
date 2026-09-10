import type { Browser } from "webdriverio";

import {
  elementWaitMs,
  loginUrl,
} from "./config";

import {
  bookingSelectors,
  loginSelectors,
} from "./selectors";

async function typeIntoSelector(
  browser: Browser,
  name: string,
  selector: string,
  value: string,
) {
  console.log(`Looking for ${name}...`);

  const element = await browser.$(selector).getElement();

  await element.waitForDisplayed({
    timeout: elementWaitMs,
    timeoutMsg: `${name} was not visible after ${elementWaitMs / 1000} seconds`,
  });

  await element.click();
  await browser.pause(1_000);
  await element.setValue(value);
  await browser.pause(1_000);

  console.log(`Entered ${name}`);
}

async function clickSelector(
  browser: Browser,
  name: string,
  selector: string,
) {
  console.log(`Looking for ${name}...`);

  const element = await browser.$(selector).getElement();

  await element.waitForDisplayed({
    timeout: elementWaitMs,
    timeoutMsg: `${name} was not visible after ${elementWaitMs / 1000} seconds`,
  });

  await element.waitForEnabled({
    timeout: elementWaitMs,
    timeoutMsg: `${name} was not enabled after ${elementWaitMs / 1000} seconds`,
  });

  await element.scrollIntoView({
    block: "center",
    inline: "center",
  });

  await element.waitForClickable({
    timeout: elementWaitMs,
    timeoutMsg: `${name} was not clickable after ${elementWaitMs / 1000} seconds`,
  });

  await element.click();
  await browser.pause(1_000);
  console.log(`Clicked ${name}`);
}

async function bookNowIsVisible(browser: Browser): Promise<boolean> {
  await browser.switchFrame(null);

  const bookingFrames = await browser.$$(bookingSelectors.frame).getElements();

  for (const bookingFrame of bookingFrames) {
    try {
      await browser.switchFrame(bookingFrame);

      const bookNowButtons = await browser
        .$$(bookingSelectors.bookNow)
        .getElements();

      for (const bookNowButton of bookNowButtons) {
        if (await bookNowButton.isDisplayed()) {
          return true;
        }
      }
    } catch {
      // The iframe may be replaced while the post-login page is loading.
    } finally {
      await browser.switchFrame(null);
    }
  }

  return false;
}

export async function logInToPlayByPoint(browser: Browser) {
  const email = process.env.PLAYBYPOINT_EMAIL ?? "";
  const password = process.env.PLAYBYPOINT_PASSWORD ?? "";

  if (!email) {
    throw new Error("PLAYBYPOINT_EMAIL is not set");
  }

  if (!password) {
    throw new Error("PLAYBYPOINT_PASSWORD is not set");
  }

  await browser.url(loginUrl);
  await browser.pause(5000);

  await typeIntoSelector(
    browser,
    "email field",
    loginSelectors.email,
    email,
  );

  await typeIntoSelector(
    browser,
    "password field",
    loginSelectors.password,
    password,
  );

  await clickSelector(
    browser,
    "Sign in button",
    loginSelectors.signIn,
  );

  let bookNowVisible = false;

  try {
    await browser.waitUntil(
      async () => {
        bookNowVisible = await bookNowIsVisible(browser);
        return bookNowVisible;
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: "Book Now button was not visible within 30 seconds after login",
      },
    );
  } catch {
    const currentUrl = await browser.getUrl();

    if (currentUrl.includes("/users/sign_in")) {
      throw new Error(
        "Login did not complete within 30 seconds and the browser is still on the sign-in page",
      );
    }

    console.log(
      "Login completed, but Book Now was not visible within 30 seconds. Continuing to the navigation retry.",
    );
  }

  console.log("URL after login:", await browser.getUrl());

  if (bookNowVisible) {
    console.log("Login completed. Book Now button is visible.");
  }
}
