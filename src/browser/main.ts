import { remote, type Browser } from "webdriverio";

import {
  androidChromeOptions,
  errorPauseMs,
  screenshotPath,
} from "./config";
import { logInToPlayByPoint } from "./login";
import {
  navigateToBooking,
  type NavigateToBookingInputs,
} from "./navigate-to-booking";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bookReservation, ReservationInputs } from "./book-reservation";

export async function pause(message = "Press Enter to continue...") {
  const readline = createInterface({ input, output });

  await readline.question(message);

  readline.close();
}

type BrowserWorkflowStep = {
  name: string;
  run: (browser: Browser) => Promise<void>;
};

export const bookingInputs: ReservationInputs = {
  courtHierarchy: ["8","9","4", "3", "2", "6", "1", "5", "10", "7"],
  // desiredTimes: ["7:30-8pm", "8-8:30pm", "8:30-9pm", "9-9:30pm"],
  desiredTimes: ['2-2:30pm','2:30-3pm','3-3:30pm','3:30-4pm'],
  // desiredTimes: ["9-9:30pm","9:30-10pm"],

  secondary: "Paul Rodriguez",
};

export const availableSteps: Record<string, BrowserWorkflowStep> = {
  login: {
    name: "login",
    run: logInToPlayByPoint,
  },
  navigateToBooking: {
    name: "navigate to booking",
    run: navigateToBooking,
  },
  bookReservation: {
    name: "book the reservation",
    run: (browser) => bookReservation(browser, bookingInputs),
  },
};

export const workflowSteps: BrowserWorkflowStep[] = [
  availableSteps.login,
  availableSteps.navigateToBooking,
  availableSteps.bookReservation

];

export async function runBrowserWorkflow(
  steps: BrowserWorkflowStep[] = workflowSteps,
) {
  const browser = await remote(androidChromeOptions);
  await browser.maximizeWindow();
  console.log("Chrome maximized");
  let sessionCleanup: Promise<unknown> | undefined;
  let shuttingDown = false;

  const closeSession = () => {
    sessionCleanup ??= browser.deleteSession();
    return sessionCleanup;
  };

  const handleSignal = (signal: "SIGINT" | "SIGTERM", exitCode: number) => {
    if (shuttingDown) {
      process.exit(exitCode);
    }

    shuttingDown = true;
    console.log(`\nReceived ${signal}. Closing the Appium session...`);

    void closeSession()
      .catch((error) => {
        console.error("Failed to close the Appium session:", error);
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };

  const handleInterrupt = () => handleSignal("SIGINT", 130);
  const handleTermination = () => handleSignal("SIGTERM", 143);

  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleTermination);

  try {
    for (const step of steps) {
      console.log(`Starting workflow step: ${step.name}`);
      await step.run(browser);
      console.log(`Completed workflow step: ${step.name}`);
    }
  } catch (error) {
    console.error(
      `Workflow failed. Leaving the browser open for ${errorPauseMs / 1000} seconds...`,
    );
    throw error;
  } finally {
    await pause();
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);

    try {
      await browser.switchFrame(null);
      await browser.saveScreenshot(screenshotPath);
      console.log(`Saved final screenshot to ${screenshotPath}`);
    } catch (screenshotError) {
      console.error("Failed to save the final screenshot:", screenshotError);
    }

    await closeSession();
  }
}

if (require.main === module) {
  runBrowserWorkflow().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
