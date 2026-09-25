import { defineConfig, devices } from "@playwright/test";

// Browser tests for the board. They run against a production build and never
// reach DraftKings: the specs serve the recorded fixtures and a fake live feed.
//
//   npm run test:e2e                                   # builds, serves on :3200, tests
//   E2E_BASE_URL=http://localhost:3000 npm run test:e2e   # against a server you already run

const PORT = 3200;
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: external ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: external
    ? undefined
    : {
        command: `npm run build && npx next start -p ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        // The page's data is mocked in the browser; keep the server off the line-history database too.
        env: { CLICKHOUSE_URL: "" },
      },
});
