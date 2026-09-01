import {
  loginUrl,
  loginWaitMs,
  screenshotPath,
} from "./config";
import { loginSelectors } from "./selectors";

export async function logInToPlayByPoint(browser: WebdriverIO.Browser) {
  await browser.url(loginUrl);

  await browser
    .$(loginSelectors.email)
    .setValue(process.env.PLAYBYPOINT_EMAIL ?? "");

  await browser
    .$(loginSelectors.password)
    .setValue(process.env.PLAYBYPOINT_PASSWORD ?? "");

  console.log("Clicking Sign in...");
  await browser.$(loginSelectors.signIn).click();

  console.log("Click returned. Waiting for login...");
  await browser.pause(loginWaitMs);

  console.log("URL after login:", await browser.getUrl());

  const viewport = await browser.execute(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    availableWidth: window.screen.availWidth,
    availableHeight: window.screen.availHeight,
  }));

  console.log("Browser viewport:", viewport);

  await browser.saveScreenshot(screenshotPath);
  console.log(`Saved ${screenshotPath}`);
}
