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
  const forwardInterrupt = () => {
    process.kill(process.pid, "SIGINT");
  };

  readline.once("SIGINT", forwardInterrupt);

  try {
    await readline.question(message);
  } finally {
    readline.removeListener("SIGINT", forwardInterrupt);
    readline.close();
  }
}

type BrowserWorkflowStep = {
  name: string;
  run: (browser: Browser) => Promise<void>;
};

function listInput(name: string, fallback: readonly string[]): string[] {
  const value = process.env[name]?.trim();

  if (!value) {
    return [...fallback];
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    throw new Error(`${name} must contain at least one comma-separated value`);
  }

  return items;
}

export const bookingInputs: ReservationInputs = {
  courtHierarchy: listInput(
    "PLAYBYPOINT_COURT_HIERARCHY",
    ["4", "8", "9", "3", "2", "6", "1", "5", "10", "7"],
  ),
  desiredTimes: listInput(
    "PLAYBYPOINT_DESIRED_TIMES",
    ["7:30-8pm", "8-8:30pm", "8:30-9pm", "9-9:30pm"],
  ),
  secondary:
    process.env.PLAYBYPOINT_SECONDARY?.trim() || "philip pham",
};

function removeWeekendCourts() {
  const excludedCourts = new Set(["6", "7", "8", "9", "10"]);

  bookingInputs.courtHierarchy = bookingInputs.courtHierarchy.filter(
    (court) => !excludedCourts.has(court),
  );

  console.log(
    `Weekend court hierarchy: ${bookingInputs.courtHierarchy.join(", ")}`,
  );
}

export function configureForCurrentDay(): boolean {
  const timeZone =
    process.env.PLAYBYPOINT_TIME_ZONE?.trim() || "America/Los_Angeles";
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone,
  }).format(new Date());

  console.log(`Current day in ${timeZone}: ${day}`);

  if (day === "Sunday") {
    removeWeekendCourts();
  } else if (day === "Monday") {
    // Add Monday-specific configuration here.
  } else if (day === "Tuesday") {
    // Add Tuesday-specific configuration here.
  } else if (day === "Wednesday") {
    // Add Wednesday-specific configuration here.
    console.log("It's Wednesday. Finishing the workflow without performing any actions.");
    return false;
  } else if (day === "Thursday") {
    // Add Thursday-specific configuration here.
  } else if (day === "Friday") {
    console.log("It's Friday. Finishing the workflow without performing any actions.");
    return false;
  } else if (day === "Saturday") {
    removeWeekendCourts();
  }

  return true;
}

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
  if (!configureForCurrentDay()) {
    return;
  }

  // await pause();

  const browser = await remote(androidChromeOptions);
  let sessionCleanup: Promise<unknown> | undefined;
  let shuttingDown = false;

  const closeSession = () => {
    sessionCleanup ??= browser.deleteSession().then(() => {
      console.log("Appium session closed");
    });
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
    await browser.maximizeWindow();
    console.log("Chrome maximized");

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
    try {
      await pause();

      try {
        await browser.switchFrame(null);
        await browser.saveScreenshot(screenshotPath);
        console.log(`Saved final screenshot to ${screenshotPath}`);
      } catch (screenshotError) {
        console.error("Failed to save the final screenshot:", screenshotError);
      }
    } finally {
      await closeSession();
      process.removeListener("SIGINT", handleInterrupt);
      process.removeListener("SIGTERM", handleTermination);
    }
  }
}

if (require.main === module) {
  runBrowserWorkflow().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
