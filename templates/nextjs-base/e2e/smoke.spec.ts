// LOCKED PLATFORM FILE — managed by VoiceForge.
// Baseline browser + accessibility test for every generated app:
// the home page must load in a real browser without JavaScript errors or
// missing files, survive its buttons being pressed, and pass an axe
// accessibility audit with no serious/critical violations.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("home page loads cleanly, survives clicks, and is accessible", async ({
  page,
  baseURL,
}) => {
  const missingFiles: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];

  page.on("response", (res) => {
    if (res.status() === 404 && baseURL && res.url().startsWith(baseURL)) {
      missingFiles.push(res.url());
    }
  });
  // Generated apps must be self-contained: any request to another host is
  // a hallucinated stock photo / CDN / placeholder service — a bug.
  page.on("request", (req) => {
    const url = req.url();
    if (
      baseURL &&
      !url.startsWith(baseURL) &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:")
    ) {
      externalRequests.push(url);
    }
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("dialog", (d) => {
    void d.dismiss().catch(() => {});
  });

  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();

  // Press up to 10 visible buttons — the app must not crash on interaction.
  const buttons = page.locator("button:visible");
  const clickCount = Math.min(await buttons.count(), 10);
  for (let i = 0; i < clickCount; i++) {
    try {
      await buttons.nth(i).click({ timeout: 2_000 });
      await page.waitForTimeout(150);
    } catch {
      // Button may have disappeared after an earlier click — that's fine.
    }
  }

  expect(
    pageErrors,
    `JavaScript errors on the page: ${pageErrors.join(" | ")}`,
  ).toEqual([]);
  expect(
    missingFiles,
    `Files referenced but missing (404): ${missingFiles.join(", ")}`,
  ).toEqual([]);
  expect(
    externalRequests,
    `The app must be self-contained but requested external URLs: ${[...new Set(externalRequests)].join(", ")}`,
  ).toEqual([]);

  const axeResults = await new AxeBuilder({ page }).analyze();
  const serious = axeResults.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(
    serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length} element(s))`),
    "Serious accessibility violations",
  ).toEqual([]);
});
