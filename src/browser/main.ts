import { remote, type Browser } from "webdriverio";

import {
  androidChromeOptions,
  errorPauseMs,
  screenshotPath,
} from "./config";
import { logInToPlayByPoint } from "./login";
import {
  navigateToBooking,
} from "./navigate-to-booking";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
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

function runAdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "adb",
      args,
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `adb ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function maximizeAndroidChromeWindow(
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "Chrome is not visible yet";

  while (Date.now() < deadline) {
    try {
      const [activities, displays] = await Promise.all([
        runAdb(["shell", "dumpsys", "activity", "activities"]),
        runAdb(["shell", "dumpsys", "window", "displays"]),
      ]);

      const chromeTaskLine = activities
        .split("\n")
        .find(
          (line) =>
            line.includes("com.android.chrome") &&
            line.includes("visible=true"),
        );
      const taskId = chromeTaskLine?.match(/#(\d+)/)?.[1];
      const appSize = displays.match(/\bapp=(\d+)x(\d+)/);

      if (!taskId) {
        lastFailure = "The visible Chrome task was not found";
      } else if (!appSize) {
        lastFailure = "The Android display app bounds were not found";
      } else {
        const [, width, height] = appSize;

        await runAdb([
          "shell",
          "am",
          "task",
          "resize",
          taskId,
          "0",
          "0",
          width,
          height,
        ]);

        console.log(`Chrome task ${taskId} maximized to ${width}x${height}`);
        return;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await wait(1_000);
  }

  throw new Error(
    `Chrome could not be maximized within ${timeoutMs / 1_000} seconds: ${lastFailure}`,
  );
}

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
  primary:
    process.env.PLAYBYPOINT_PRIMARY?.trim() || "",
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

function configureDesiredTimes(isWeekend: boolean) {
  bookingInputs.desiredTimes = isWeekend
    ? ["7:30-8pm", "8-8:30pm", "8:30-9pm", "9-9:30pm"]
    : ["8-8:30pm", "8:30-9pm", "9-9:30pm", "9:30-10pm"];

  console.log(`Desired times: ${bookingInputs.desiredTimes.join(", ")}`);
}

export function configureForCurrentDay(): boolean {
  const timeZone =
    process.env.PLAYBYPOINT_TIME_ZONE?.trim() || "America/Los_Angeles";
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone,
  }).format(new Date());

  console.log(`Current day in ${timeZone}: ${day}`);
  configureDesiredTimes(day === "Saturday" || day === "Sunday");

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

  // override env inputs for testing
  bookingInputs.desiredTimes = ["2-2:30pm"];
  bookingInputs.primary = 'Yena Kim';
  bookingInputs.secondary = 'Matt Lim'

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
    await maximizeAndroidChromeWindow();

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
