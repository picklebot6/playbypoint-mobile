import { runBrowserWorkflow } from "../../src/browser/main";

runBrowserWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
