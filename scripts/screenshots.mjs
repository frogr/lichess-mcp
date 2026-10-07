// Screenshots of the web playground against live Lichess data.
//
//   npm run build && node scripts/screenshots.mjs [username]
//
// Starts dist/http.js on a free port, drives it with Chromium, writes
// docs/screenshots/*.png. Needs network (the page calls Lichess through /mcp).
// CHROMIUM_PATH overrides the browser binary.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const username = process.argv[2] ?? "thibault";
const executablePath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const port = 4100 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;
const out = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, [new URL("../dist/http.js", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(port), RATE_LIMIT_PER_MINUTE: "120" },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

/** Pick a question in "Ask it" and wait for every call in the chat to finish. */
async function askExample(page, index) {
  await page.locator("#ask-chips .chip").nth(index).click();
  await page.waitForFunction(() => !document.querySelector("#ask-chat .pending"), null, { timeout: 60_000 });
  await scrollTo(page, "#ask");
  await page.waitForTimeout(400);
}

const scrollTo = (page, sel) => page.locator(sel).evaluate((el) => el.scrollIntoView({ block: "start" }));

const browser = await chromium.launch({ executablePath });
try {
  await waitForHealth();

  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await desk.goto(base);
  await desk.waitForFunction(() => /Healthy/.test(document.querySelector("#health-stat")?.textContent ?? ""));
  await desk.waitForSelector("#puzzle-body svg.board image");
  await desk.screenshot({ path: `${out}playground.png` });

  // Ask it: the two-call review, then the puzzle that keeps its answer hidden.
  await askExample(desk, 1);
  await desk.locator("#ask").screenshot({ path: `${out}ask-review.png` });
  await askExample(desk, 4);
  await desk.locator("#ask").screenshot({ path: `${out}ask-puzzle.png` });

  // Review: load the player, wait for the first analysed game's mistakes.
  await desk.fill("#username", username);
  await desk.click("#lookup-btn");
  await desk.waitForSelector("#detail svg.board", { timeout: 45_000 });
  await scrollTo(desk, "#review");
  await desk.waitForTimeout(300);
  await desk.screenshot({ path: `${out}review.png` });

  // A game with no analysis shows the honest "not available" state.
  const unanalysed = desk.locator("#games-panel .game", { has: desk.locator(".pill:not(.pill--good)") }).first();
  if (await unanalysed.count()) {
    await unanalysed.click();
    await desk.waitForSelector("#detail .note", { timeout: 30_000 });
    await scrollTo(desk, "#review");
    await desk.screenshot({ path: `${out}review-not-analysed.png` });
  }

  await scrollTo(desk, "#puzzle");
  await desk.waitForTimeout(200);
  await desk.screenshot({ path: `${out}puzzle.png` });
  await desk.getByRole("button", { name: "Show solution" }).click();
  await desk.waitForSelector("#puzzle-body .solution button");
  await desk.locator("#puzzle-body .solution button").nth(0).click();
  await scrollTo(desk, "#puzzle");
  await desk.waitForTimeout(200);
  await desk.screenshot({ path: `${out}puzzle-solution.png` });

  await scrollTo(desk, "#connect");
  await desk.locator("#client-tabs .chip", { hasText: "Claude Desktop" }).click();
  await desk.waitForTimeout(200);
  await desk.screenshot({ path: `${out}connect.png` });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await phone.goto(`${base}/?user=${encodeURIComponent(username)}`);
  await phone.waitForFunction(() => /Healthy/.test(document.querySelector("#health-stat")?.textContent ?? ""));
  await phone.screenshot({ path: `${out}phone.png` });
  await phone.waitForSelector("#detail svg.board", { timeout: 45_000 });
  await scrollTo(phone, "#detail");
  await phone.waitForTimeout(200);
  await phone.screenshot({ path: `${out}phone-review.png` });
  await scrollTo(phone, "#puzzle");
  await phone.waitForTimeout(200);
  await phone.screenshot({ path: `${out}phone-puzzle.png` });

  console.log(`screenshots written to ${out}`);
} finally {
  await browser.close();
  server.kill();
}
