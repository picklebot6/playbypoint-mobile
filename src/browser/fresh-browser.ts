import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { remote } from "webdriverio";
import { androidChromeOptions, loginUrl } from "./config";
import { maximizeAndroidChromeWindow } from "./main";

const run = promisify(execFile);

export async function openFreshBrowser() {
  // The automation runs in Android Chrome; stop it before creating a new session.
  await run("adb", ["shell", "am", "force-stop", "com.android.chrome"]);
  const browser = await remote({
    ...androidChromeOptions,
    capabilities: { ...androidChromeOptions.capabilities, "appium:noReset": false },
  });
  try {
    await browser.setTimeout({ script: 45_000, pageLoad: 60_000 });
    await browser.url(loginUrl);
    await maximizeAndroidChromeWindow(30_000);
    await browser.waitUntil(async () => {
      return new URL(await browser.getUrl()).origin === "https://app.playbypoint.com";
    }, { timeout: 30_000, timeoutMsg: "PlayByPoint did not load in the fresh browser" });
    await browser.deleteAllCookies();
    return browser;
  } catch (error) {
    await browser.deleteSession().catch(() => {});
    throw error;
  }
}
