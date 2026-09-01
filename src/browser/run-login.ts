import { remote } from "webdriverio";

import { androidChromeOptions, desktopViewport } from "./config";
import { logInToPlayByPoint } from "./login";

export async function runAndroidChromeLogin() {
  const browser = await remote(androidChromeOptions);

  try {
    await browser.sendCommand(
      "Emulation.setDeviceMetricsOverride",
      desktopViewport,
    );

    await logInToPlayByPoint(browser);
  } finally {
    await browser.deleteSession();
  }
}
