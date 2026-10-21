// End-to-end verification for the EdgeEver Halo Publisher plugin.
// Runs a real Chrome against the local EdgeEver instance, installs the plugin
// from its hosted manifest URL, configures the Halo instance, publishes a test
// note with an image, updates it, and verifies the public blog page.
//
// Usage:
//   HOME=/tmp/pw-home node local-plugins/halo-publisher/e2e/publish.e2e.mjs

import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "screenshots");
const RESULT_PATH = join(HERE, "result.json");

const CONFIG = {
  edgeeverUrl: process.env.EE_BASE || "http://127.0.0.1:8787",
  username: process.env.EE_USER || "admin",
  password: process.env.EE_PASS || "",
  haloUrl: process.env.HALO_URL || "https://blog.twisterfeng.com",
  manifestUrl: process.env.MANIFEST_URL || "https://notes.twisterfeng.com/edgever-plugins/halo-publisher/manifest.json",
  pluginId: "com.twisterfeng.edgeever.halo-publisher",
  noteTitle: "Halo 插件发布测试",
};

const log = (...args) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The host shows a blocking notice dialog after each plugin notice; dismiss it. */
const dismissNotices = async (page) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const acknowledge = page.getByRole("button", { name: "知道了", exact: true });
    if (await acknowledge.isVisible().catch(() => false)) {
      await acknowledge.click().catch(() => undefined);
      await sleep(350);
      continue;
    }
    await sleep(250);
    if (!(await acknowledge.isVisible().catch(() => false))) break;
  }
};

let haloToken = "";

const haloFetch = async (path, init = {}) => {
  const headers = { Authorization: `Bearer ${haloToken}`, ...(init.headers || {}) };
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${CONFIG.haloUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
};

/** Remove posts/tags created by previous E2E runs so reruns stay idempotent. */
const cleanupTestContent = async () => {
  const listed = await haloFetch("/apis/api.console.halo.run/v1alpha1/posts?page=0&size=200");
  const posts = (listed.data && listed.data.items) || [];
  const targets = posts.filter((post) => {
    const title = (post && post.spec && post.spec.title) || "";
    const slug = (post && post.spec && post.spec.slug) || "";
    return title.includes(CONFIG.noteTitle) || slug.startsWith("halo-插件发布测试");
  });
  for (const post of targets) {
    await haloFetch(`/apis/api.console.halo.run/v1alpha1/posts/${post.metadata.name}/recycle`, { method: "PUT" });
    await sleep(700);
    await haloFetch(`/apis/content.halo.run/v1alpha1/posts/${post.metadata.name}`, { method: "DELETE" });
    log("cleaned stale test post", post.metadata.name);
  }
  const tags = await haloFetch("/apis/api.console.halo.run/v1alpha1/tags?page=0&size=200");
  for (const tag of (tags.data && tags.data.items) || []) {
    const displayName = tag && tag.spec && tag.spec.displayName;
    if (displayName === "测试" || displayName === "Halo") {
      await haloFetch(`/apis/content.halo.run/v1alpha1/tags/${tag.metadata.name}`, { method: "DELETE" });
      log("cleaned test tag", displayName);
    }
  }
};

const main = async () => {
  await mkdir(SHOTS, { recursive: true });
  haloToken = (await readFile(process.env.HALO_PAT_FILE || "/tmp/halo_plugin_pat", "utf8")).trim();
  if (!haloToken) throw new Error("missing Halo PAT (set HALO_PAT_FILE)");
  if (!CONFIG.password) throw new Error("missing EE_PASS");
  await cleanupTestContent();

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-crash-reporter", "--disable-gpu", "--lang=zh-CN"],
  });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const consoleErrors = [];
  const consoleLogs = [];
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") consoleErrors.push(text);
    if (text.includes("[halo-publisher]")) {
      consoleLogs.push(text);
      log("plugin-log", text);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const results = {};

  try {
    /* 1. login */
    log("open EdgeEver login page");
    await page.goto(`${CONFIG.edgeeverUrl}/`, { waitUntil: "domcontentloaded" });
    await page.fill('input[autocomplete="username"]', CONFIG.username);
    await page.fill('input[autocomplete="current-password"]', CONFIG.password);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[aria-label="插件"]', { timeout: 45000 });
    await page.screenshot({ path: join(SHOTS, "01-workspace.png") });
    log("logged in");

    /* 2. install plugin from manifest URL */
    await page.goto(`${CONFIG.edgeeverUrl}/plugins`, { waitUntil: "domcontentloaded" });
    const installInput = page.locator('input[aria-label="GitHub 仓库或 Manifest 地址"]');
    await installInput.waitFor({ timeout: 30000 });
    await installInput.fill(CONFIG.manifestUrl);
    await page.getByRole("button", { name: "安装", exact: true }).click();
    log("install submitted");
    await page.waitForFunction(
      (pluginName) => document.body.innerText.includes(pluginName),
      "Halo 博客发布",
      { timeout: 60000 },
    );
    await page.screenshot({ path: join(SHOTS, "02-plugin-installed.png") });
    results.installed = true;
    log("plugin installed");

    // community plugins must be enabled explicitly (trust acknowledgement dialog)
    const toggle = page.locator('[aria-label="启用或停用 Halo 博客发布"]');
    await toggle.waitFor({ timeout: 30000 });
    const checked = await toggle.getAttribute("aria-checked");
    if (checked !== "true") {
      await toggle.click();
      const confirm = page.getByRole("button", { name: "开启社区插件", exact: true });
      if (await confirm.isVisible({ timeout: 8000 }).catch(() => false)) await confirm.click();
      await page.waitForTimeout(2500);
    }
    results.enabled = true;
    log("plugin enabled");

    /* 3. configure Halo URL + PAT in the host-rendered settings form */
    await page.goto(`${CONFIG.edgeeverUrl}/plugins/${CONFIG.pluginId}?view=settings`, { waitUntil: "domcontentloaded" });
    const urlInput = page.getByLabel(/Halo 站点地址/).first();
    await urlInput.waitFor({ timeout: 30000 });
    await urlInput.fill(CONFIG.haloUrl);
    await urlInput.blur();
    const tokenInput = page.getByLabel(/Halo 个人令牌/).first();
    await tokenInput.fill(haloToken);
    await tokenInput.blur();
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const persistedUrl = await page.getByLabel(/Halo 站点地址/).first().inputValue();
    if (persistedUrl !== CONFIG.haloUrl) throw new Error(`settings not persisted: ${persistedUrl}`);
    await page.screenshot({ path: join(SHOTS, "03-plugin-settings.png") });
    results.configured = true;
    log("plugin settings saved");

    /* 4. open a note, then open the publisher panel from the plugin toolbar menu */
    await page.goto(`${CONFIG.edgeeverUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="插件"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
    const noteItem = page.getByText(CONFIG.noteTitle, { exact: false }).first();
    await noteItem.waitFor({ timeout: 30000 });
    await noteItem.click();
    await page.waitForTimeout(1500);
    await page.locator('[aria-label="插件"]').click();
    const panelEntry = page.getByRole("menuitem", { name: "Halo 博客发布", exact: true }).first();
    await panelEntry.waitFor({ timeout: 15000 });
    await panelEntry.click();
    await page.waitForSelector(".hp", { timeout: 30000 });
    await page.waitForSelector('.hp-dot[data-state="ok"]', { timeout: 45000 });
    await page.screenshot({ path: join(SHOTS, "04-panel-connected.png") });
    log("publisher panel opened and connected");

    /* 5. select the note inside the panel and publish */
    const noteButtons = page.locator(".hp-note");
    await noteButtons.first().waitFor({ timeout: 30000 });
    const count = await noteButtons.count();
    let picked = false;
    for (let index = 0; index < count; index += 1) {
      const text = await noteButtons.nth(index).innerText();
      if (text.includes(CONFIG.noteTitle)) {
        await noteButtons.nth(index).click();
        picked = true;
        break;
      }
    }
    if (!picked) throw new Error("test note not found in plugin panel list");
    await page.waitForSelector(".hp-detail:not([hidden])", { timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(SHOTS, "05-panel-note-selected.png") });

    await page.getByRole("button", { name: "发布到 Halo", exact: true }).click();
    const resultLink = page.locator(".hp-result a").first();
    await resultLink.waitFor({ timeout: 180000 });
    const articleUrl = await resultLink.getAttribute("href");
    results.firstPublishUrl = articleUrl;
    await dismissNotices(page);
    await page.screenshot({ path: join(SHOTS, "06-panel-published.png") });
    log("published", articleUrl);

    /* 6. verify public blog page + uploaded image */
    const article = await (await fetch(articleUrl)).text();
    if (!article.includes(CONFIG.noteTitle)) throw new Error("published article is missing the note title");
    if (!article.includes("自动化脚本创建的笔记")) throw new Error("published article is missing the body text");
    if (!article.includes("第一项")) throw new Error("published article is missing list content");
    const imageMatch = article.match(/(https?:\/\/[^"' ]+\/upload\/[^"' ]+\.(?:png|jpg|jpeg|webp|gif))/i);
    if (imageMatch) {
      const imageResponse = await fetch(imageMatch[1]);
      results.uploadedImageUrl = imageMatch[1];
      results.uploadedImageStatus = imageResponse.status;
      if (imageResponse.status !== 200) throw new Error(`uploaded image is not public: ${imageResponse.status}`);
    }
    results.firstPublishVerified = true;
    log("public article verified", articleUrl, results.uploadedImageUrl || "(no image url found)");

    /* 7. update flow: rename and re-publish the same Halo post */
    const updatedTitle = `${CONFIG.noteTitle}（更新版）`;
    const titleInput = page.locator('.hp-detail input[data-field="title"]');
    await titleInput.fill(updatedTitle);
    await page.getByRole("button", { name: "更新已发布文章", exact: true }).click();
    await page.waitForTimeout(1500);
    const resultLink2 = page.locator(".hp-result a").first();
    await resultLink2.waitFor({ timeout: 180000 });
    const articleUrl2 = await resultLink2.getAttribute("href");
    results.updatedUrl = articleUrl2;
    await dismissNotices(page);
    await page.screenshot({ path: join(SHOTS, "07-panel-updated.png") });
    await page.waitForTimeout(1500);
    const article2 = await (await fetch(articleUrl2)).text();
    if (!article2.includes(updatedTitle)) throw new Error("updated article title mismatch");
    results.updateVerified = true;
    results.postUpdatedAt = new Date().toISOString();
    log("update verified", articleUrl2);

    /* 8. draft round-trip: unpublish the article, verify it is no longer public, then republish */
    await page.locator('.hp-detail select[data-field="status"]').selectOption("draft");
    await page.getByRole("button", { name: "更新并保存草稿", exact: true }).click();
    await page.waitForFunction(
      () => (document.querySelector(".hp-log")?.textContent || "").includes("已保存为草稿"),
      null,
      { timeout: 180000 },
    );
    await dismissNotices(page);
    const draftCheck = await fetch(articleUrl2, { redirect: "manual" });
    results.draftUnpublishStatus = draftCheck.status;
    if (draftCheck.status === 200) throw new Error("draft round-trip: article is still public after unpublish");
    log("draft round-trip verified, public status", draftCheck.status);

    await page.locator('.hp-detail select[data-field="status"]').selectOption("published");
    await page.getByRole("button", { name: "更新已发布文章", exact: true }).click();
    await page.waitForFunction(
      () => (document.querySelector(".hp-log")?.textContent || "").includes("发布完成"),
      null,
      { timeout: 180000 },
    );
    await dismissNotices(page);
    const republishCheck = await fetch(articleUrl2);
    results.republishStatus = republishCheck.status;
    if (republishCheck.status !== 200) throw new Error(`republish failed: ${republishCheck.status}`);
    results.draftRoundTripVerified = true;
    log("republish after draft verified");

    /* 9. capture the public blog page */
    const blogPage = await context.newPage();
    await blogPage.goto(articleUrl2, { waitUntil: "domcontentloaded" });
    await blogPage.waitForTimeout(2500);
    await blogPage.screenshot({ path: join(SHOTS, "08-blog-article.png"), fullPage: false });
    await blogPage.close();

    results.consoleErrors = consoleErrors.slice(0, 20);
    await writeFile(RESULT_PATH, JSON.stringify({ ok: true, ...results }, null, 2));
    await cleanupTestContent();
    results.cleaned = true;
    await writeFile(RESULT_PATH, JSON.stringify({ ok: true, ...results }, null, 2));
    log("E2E PASSED (test content cleaned)");
  } catch (error) {
    results.error = error && error.message ? error.message : String(error);
    results.consoleErrors = consoleErrors.slice(0, 20);
    results.consoleLogs = consoleLogs.slice(0, 40);
    await writeFile(RESULT_PATH, JSON.stringify({ ok: false, ...results }, null, 2));
    try {
      await page.screenshot({ path: join(SHOTS, "99-failure.png") });
    } catch {
      /* ignore */
    }
    log("E2E FAILED:", results.error);
    throw error;
  } finally {
    await browser.close();
  }
};

await main();
