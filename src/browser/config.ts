export const loginUrl = "https://app.playbypoint.com/users/sign_in";

export const androidChromeOptions = {
  hostname: "127.0.0.1",
  port: 4723,
  capabilities: {
    platformName: "Android",
    browserName: "Chrome",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": "Android Emulator",
    "wdio:enforceWebDriverClassic": true,
    pageLoadStrategy: "none" as const,
  },
};

export const desktopViewport = {
  width: 3840,
  height: 2160,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: 3840,
  screenHeight: 2160,
} as const;

export const loginWaitMs = 10_000;
export const screenshotPath = "post-login.png";
