import { remote } from "webdriverio";

async function main() {
  const browser = await remote({
    hostname: "127.0.0.1",
    port: 4723,
    capabilities: {
      platformName: "Android",
      browserName: "Chrome",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Android Emulator",
      "wdio:enforceWebDriverClassic": true,
      pageLoadStrategy: "none",
    },
  });

  try {
    await browser.url("https://app.playbypoint.com/users/sign_in");

    await browser.$("#user_email").setValue(process.env.PLAYBYPOINT_EMAIL ?? "");
    await browser.$("#user_password").setValue(process.env.PLAYBYPOINT_PASSWORD ?? "");

    console.log("Clicking Sign in...");
    await browser.$("input[value='Sign in']").click();

    console.log("Click returned. Waiting for login...");
    await browser.pause(10000);

    console.log("URL after login:", await browser.getUrl());

    await browser.saveScreenshot("post-login.png");
  } finally {
    await browser.deleteSession();
  }
}

main().catch(console.error);