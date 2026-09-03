export const loginUrl = "https://app.playbypoint.com/users/sign_in";

export const androidChromeOptions = {
  hostname: "127.0.0.1",
  port: 4723,
  logLevel: "silent" as const,
  capabilities: {
    platformName: "Android",
    browserName: "Chrome",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": "Android Emulator",
    "appium:newCommandTimeout": 600,
    "wdio:enforceWebDriverClassic": true,
    pageLoadStrategy: "none" as const,
  },
};

export const loginWaitMs = 10_000;
export const elementWaitMs = 20_000;
export const errorPauseMs = 30_000;
export const screenshotPath = "final-workflow.png";
