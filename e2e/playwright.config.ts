import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

// The mock backend runs in the browser, so `pnpm exec vite` alone serves the whole app. E2E_PORT keeps parallel runs apart.
const port = Number(process.env.E2E_PORT ?? 4173);
const url = `http://localhost:${port}`;

/** Every spec starts with Pip home's orientation card and the permission prompt's one-time explainer dismissed (`pipOrientationSeen`, `permissionExplainerSeen`, src/workspace/prefs.ts), so they take no room in their locators. e2e/orientation.spec.ts and e2e/recommendations.spec.ts start without them where they test them. */
export const SEEDED_PREFS = { name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) };

export default defineConfig({
  testDir: ".",
  // The mock paces its answers on timers; one worker keeps those timings steady.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: "../test-results",
  reporter: [["list"], ["html", { outputFolder: "../playwright-report", open: "never" }]],
  use: {
    baseURL: url,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    storageState: { cookies: [], origins: [{ origin: url, localStorage: [SEEDED_PREFS] }] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The CLI port wins over vite.config.ts's 1420.
    command: `pnpm exec vite --port ${port} --strictPort`,
    // Relative to this file: vite needs the repository root to find vite.config.ts and index.html.
    cwd: "..",
    url,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
