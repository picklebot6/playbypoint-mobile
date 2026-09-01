import { runAndroidChromeLogin } from "../../src/browser/run-login";

runAndroidChromeLogin().catch((error) => {
  console.error(error);
  process.exit(1);
});
