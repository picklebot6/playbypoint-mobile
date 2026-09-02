import type { Browser } from "webdriverio";

import {
  elementWaitMs,
  loginUrl,
  loginWaitMs,
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

  await element.waitForEnabled({
    timeout: elementWaitMs,
    timeoutMsg: `${name} was not enabled after ${elementWaitMs / 1000} seconds`,
  });

  await element.waitForClickable({
    timeout: elementWaitMs,
    timeoutMsg: `${name} was not clickable after ${elementWaitMs / 1000} seconds`,
  });

  await element.click();
  await browser.pause(1_000);
  await element.clearValue();
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

  await browser.waitUntil(
    async () => !(await browser.getUrl()).includes("/users/sign_in"),
    {
      timeout: loginWaitMs,
      interval: 5000,
      timeoutMsg: "Sign in click did not leave the login page",
    },
  );

  console.log("URL after login:", await browser.getUrl());

  const bookingFrame = await browser.$(bookingSelectors.frame).getElement();

  await bookingFrame.waitForExist({
    timeout: elementWaitMs,
    timeoutMsg: "Booking iframe did not appear after login",
  });

  console.log("Login completed. Booking iframe is available.");
}
