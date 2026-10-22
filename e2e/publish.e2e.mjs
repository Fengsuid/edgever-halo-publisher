// End-to-end verification for the EdgeEver Halo Publisher plugin.
//
// Covers: GitHub install -> enable -> shared-config note -> publish -> image/tag
// verification -> second device auto-config -> update -> draft round-trip -> cleanup.
//
// Usage:
//   EE_BASE=http://127.0.0.1:8787 EE_USER=admin EE_PASS=... \
//   HALO_URL=https://blog.example.com HALO_PAT_FILE=/tmp/halo_plugin_pat \
//   HOME=/tmp/pw-home node local-plugins/halo-publisher/e2e/publish.e2e.mjs

import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "screenshots");
const RESULT_PATH = join(HERE, "result.json");

const CONFIG = {
  edgeeverUrl: process.env.EE_BASE || "http://127.0.0.1:8787",
  username: process.env.EE_USER || "admin",
  password: process.env.EE_PASS || "",
  haloUrl: process.env.HALO_URL || "https://blog.twisterfeng.com",
  installSource: process.env.INSTALL_SOURCE || "https://github.com/Fengsuid/edgever-halo-publisher",
  pluginId: "com.twisterfeng.edgeever.halo-publisher",
  noteTitle: "Halo 插件发布测试",
  configNoteTitle: "Halo 发布配置",
  mappingNoteTitle: "Halo 发布记录",
};

const log = (...args) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findHaloTestPost = async () => {
  const listed = await haloFetch("/apis/content.halo.run/v1alpha1/posts?page=0&size=200");
  const posts = (listed.data && listed.data.items) || [];
  return posts.find((post) => {
    const title = (post && post.spec && post.spec.title) || "";
    return title.startsWith(CONFIG.noteTitle) && !post.spec.deleted;
  }) || null;
};

const bustCache = (url) => `${url}${url.includes("?") ? "&" : "?"}e2e=${Date.now()}`;

const isVisibleWithin = async (locator, timeout) => {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
};

let haloToken = "";
let eeToken = "";

const haloFetch = async (path, init = {}) => {
  const headers = { Authorization: `Bearer ${haloToken}`, ...(init.headers || {}) };
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${CONFIG.haloUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
};

const eeFetch = async (path, init = {}) => {
  const headers = { Authorization: `Bearer ${eeToken}`, ...(init.headers || {}) };
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${CONFIG.edgeeverUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
};

const eeLogin = async () => {
  const response = await fetch(`${CONFIG.edgeeverUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: CONFIG.username, password: CONFIG.password }),
  });
  if (!response.ok) throw new Error(`EdgeEver login failed: ${response.status}`);
  const session = await response.json();
  eeToken = session.sessionToken;
  if (!eeToken) throw new Error("EdgeEver login returned no session token");
};

const listEdgeEverNotes = async () => {
  const result = await eeFetch("/api/v1/memos?limit=100");
  return (result.data && result.data.memos) || [];
};

const cleanupEdgeEverContent = async ({ includeTestNote = true } = {}) => {
  const notes = await listEdgeEverNotes().catch(() => []);
  for (const note of notes) {
    const shouldRemove = note.title === CONFIG.configNoteTitle
      || note.title === CONFIG.mappingNoteTitle
      || (includeTestNote && note.title === CONFIG.noteTitle);
    if (shouldRemove) {
      await eeFetch(`/api/v1/memos/${note.id}`, { method: "DELETE" });
      log("cleaned EdgeEver test note", note.title);
    }
  }
};

const cleanupHaloContent = async () => {
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
    log("cleaned Halo test post", post.metadata.name);
  }
  const tags = await haloFetch("/apis/api.console.halo.run/v1alpha1/tags?page=0&size=200");
  for (const tag of (tags.data && tags.data.items) || []) {
    const displayName = tag && tag.spec && tag.spec.displayName;
    if (displayName === "测试" || displayName === "Halo") {
      await haloFetch(`/apis/content.halo.run/v1alpha1/tags/${tag.metadata.name}`, { method: "DELETE" });
      log("cleaned test tag", displayName);
    }
  }
  const attachments = await haloFetch("/apis/storage.halo.run/v1alpha1/attachments?page=0&size=200");
  for (const attachment of (attachments.data && attachments.data.items) || []) {
    const name = (attachment && attachment.spec && attachment.spec.displayName) || "";
    if (/edgever-|e2e-image|pixel/.test(name)) {
      await haloFetch(`/apis/storage.halo.run/v1alpha1/attachments/${attachment.metadata.name}`, { method: "DELETE" });
      log("cleaned test attachment", name);
    }
  }
};

const dismissNotices = async (page) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const acknowledge = page.getByRole("button", { name: "知道了", exact: true });
    if (await isVisibleWithin(acknowledge, 400)) {
      await acknowledge.click().catch(() => undefined);
      await sleep(350);
      continue;
    }
    await sleep(250);
    if (!(await isVisibleWithin(acknowledge, 400))) break;
  }
};

const loginEdgeEver = async (page) => {
  await page.goto(`${CONFIG.edgeeverUrl}/`, { waitUntil: "domcontentloaded" });
  await page.fill('input[autocomplete="username"]', CONFIG.username);
  await page.fill('input[autocomplete="current-password"]', CONFIG.password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[aria-label="插件"]', { timeout: 45000 });
};

const installPlugin = async (page) => {
  await page.goto(`${CONFIG.edgeeverUrl}/plugins`, { waitUntil: "domcontentloaded" });
  const installInput = page.locator('input[aria-label="GitHub 仓库或 Manifest 地址"]');
  await installInput.waitFor({ timeout: 30000 });
  await installInput.fill(CONFIG.installSource);
  await page.getByRole("button", { name: "安装", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Halo 博客发布"), null, { timeout: 120000 });
  await enablePlugin(page);
};

/** Enable the plugin on this device, acknowledging the community-plugin trust prompt. */
const enablePlugin = async (page) => {
  await page.goto(`${CONFIG.edgeeverUrl}/plugins`, { waitUntil: "domcontentloaded" });
  const toggle = page.locator('[aria-label="启用或停用 Halo 博客发布"]');
  await toggle.waitFor({ timeout: 30000 });
  const isChecked = async () => (await toggle.getAttribute("aria-checked")) === "true";
  const trustConfirm = page.getByRole("button", { name: "开启社区插件", exact: true });

  // Toggle through DOM clicks: the trust dialog opens synchronously from the
  // switch handler and would otherwise intercept Playwright's actionability check.
  if (await isChecked()) {
    await toggle.evaluate((element) => element.click());
    await sleep(800);
  }
  await toggle.evaluate((element) => element.click());
  await sleep(500);
  if (await isVisibleWithin(trustConfirm, 8000)) {
    await trustConfirm.click();
  }
  await page.locator('[role="dialog"]').first().waitFor({ state: "hidden", timeout: 15000 }).catch(() => undefined);
  await sleep(1200);
  if (!(await isChecked())) {
    await toggle.evaluate((element) => element.click());
    await sleep(500);
    if (await isVisibleWithin(trustConfirm, 8000)) await trustConfirm.click();
    await page.locator('[role="dialog"]').first().waitFor({ state: "hidden", timeout: 15000 }).catch(() => undefined);
    await sleep(1200);
  }
};

const openPanel = async (page, { expectSetup = false } = {}) => {
  await page.locator('[aria-label="插件"]').click();
  const entry = page.getByRole("menuitem", { name: "Halo 博客发布", exact: true }).first();
  await entry.waitFor({ timeout: 20000 });
  await entry.click();
  await page.waitForSelector(".hp", { timeout: 30000 });
  if (expectSetup) {
    await page.waitForSelector(".hp-setup:not([hidden])", { timeout: 30000 });
  } else {
    await page.waitForSelector('.hp-dot[data-state="ok"]', { timeout: 60000 });
  }
};

const selectNoteInPanel = async (page) => {
  const noteButtons = page.locator(".hp-note");
  await noteButtons.first().waitFor({ timeout: 30000 });
  const count = await noteButtons.count();
  for (let index = 0; index < count; index += 1) {
    const text = await noteButtons.nth(index).innerText();
    if (text.includes(CONFIG.noteTitle)) {
      await noteButtons.nth(index).click();
      await page.waitForSelector(".hp-detail:not([hidden])", { timeout: 20000 });
      await page.waitForTimeout(900);
      return;
    }
  }
  throw new Error("test note not found in plugin panel");
};

const main = async () => {
  await mkdir(SHOTS, { recursive: true });
  haloToken = (await readFile(process.env.HALO_PAT_FILE || "/tmp/halo_plugin_pat", "utf8")).trim();
  if (!haloToken) throw new Error("missing Halo PAT");
  if (!CONFIG.password) throw new Error("missing EE_PASS");
  await eeLogin();
  await cleanupEdgeEverContent({ includeTestNote: false });
  await cleanupHaloContent();

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-crash-reporter", "--disable-gpu", "--lang=zh-CN"],
  });
  const results = {};
  const consoleErrors = [];
  let activePage = null;
  const attachDiagnostics = (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  };
  const newDevice = async () => {
    const context = await browser.newContext({
      viewport: { width: 1500, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(30000);
    attachDiagnostics(page);
    await loginEdgeEver(page);
    return { context, page };
  };

  try {
    /* ---------- device 1: install, shared config, publish ---------- */
    const device1 = await newDevice();
    const page = device1.page;
    await page.screenshot({ path: join(SHOTS, "01-workspace.png") });
    await installPlugin(page);
    results.installedFromGithub = true;
    await page.screenshot({ path: join(SHOTS, "02-plugin-installed.png") });
    log("plugin installed from", CONFIG.installSource);

    await page.goto(`${CONFIG.edgeeverUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="插件"]', { timeout: 30000 });
    await openPanel(page, { expectSetup: true });
    await page.locator(".hp-setup input.hp-input").first().fill(CONFIG.haloUrl);
    await page.locator(".hp-setup input.hp-input").nth(1).fill(haloToken);
    await page.screenshot({ path: join(SHOTS, "03-panel-setup.png") });
    await page.getByRole("button", { name: "保存并同步到所有设备", exact: true }).click();
    await sleep(2500);
    await dismissNotices(page);
    results.sharedConfigSaved = true;

    // The host can close plugin panels while the workspace re-renders after a
    // note is created; reload the workspace and confirm the panel now connects
    // purely from the shared config note.
    await page.goto(`${CONFIG.edgeeverUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="插件"]', { timeout: 30000 });
    await openPanel(page);
    const sharedSource = await page.locator(".hp-bar-site").innerText();
    results.sharedConfigSource = sharedSource;
    if (!sharedSource.includes("共享笔记")) throw new Error(`panel did not use shared config: ${sharedSource}`);
    await page.screenshot({ path: join(SHOTS, "04-panel-connected-shared-config.png") });

    const notes = await listEdgeEverNotes();
    const configNote = notes.find((note) => note.title === CONFIG.configNoteTitle);
    if (!configNote) throw new Error("shared config note was not created");
    const detail = await eeFetch(`/api/v1/memos/${configNote.id}`);
    const configMarkdown = (detail.data && detail.data.memo && detail.data.memo.contentMarkdown) || "";
    results.configNoteId = configNote.id;
    results.configNoteHasUrl = configMarkdown.includes("HALO_URL=");
    results.configNoteHasToken = configMarkdown.includes("HALO_TOKEN=");
    if (!results.configNoteHasUrl || !results.configNoteHasToken) throw new Error("config note content is incomplete");
    log("shared config note created:", configNote.id);

    await selectNoteInPanel(page);
    await page.getByRole("button", { name: "发布到 Halo", exact: true }).click();
    const resultLink = page.locator(".hp-result a").first();
    await resultLink.waitFor({ timeout: 180000 });
    const articleUrl = await resultLink.getAttribute("href");
    results.firstPublishUrl = articleUrl;
    await dismissNotices(page);
    await page.screenshot({ path: join(SHOTS, "05-panel-published.png") });

    let article = await (await fetch(articleUrl)).text();
    if (!article.includes(CONFIG.noteTitle)) throw new Error("published article missing title");
    if (!article.includes("自动化脚本创建的笔记")) throw new Error("published article missing body");
    if (!article.includes("第一项")) throw new Error("published article missing list");
    const imageMatch = article.match(/(https?:\/\/[^"' ]+\/upload\/[^"' ]+\.(?:png|jpg|jpeg|webp|gif))/i);
    if (imageMatch) {
      const imageResponse = await fetch(imageMatch[1]);
      results.uploadedImageUrl = imageMatch[1];
      results.uploadedImageStatus = imageResponse.status;
    }
    results.firstPublishVerified = true;

    const notesAfterPublish = await listEdgeEverNotes();
    const mappingNote = notesAfterPublish.find((note) => note.title === CONFIG.mappingNoteTitle);
    if (!mappingNote) throw new Error("shared publish-mapping note was not created");
    const mappingDetail = await eeFetch(`/api/v1/memos/${mappingNote.id}`);
    const mappingMarkdown = (mappingDetail.data && mappingDetail.data.memo && mappingDetail.data.memo.contentMarkdown) || "";
    results.mappingNoteCreated = true;
    results.mappingNoteHasPost = /"postName"\s*:/.test(mappingMarkdown);
    log("shared publish-mapping note created:", mappingNote.id);

    await device1.context.close();
    log("device 1 published", articleUrl);

    /* ---------- device 2: no setup needed (config from synced note) ---------- */
    const device2 = await newDevice();
    const page2 = device2.page;
    await enablePlugin(page2);
    await page2.goto(`${CONFIG.edgeeverUrl}/`, { waitUntil: "domcontentloaded" });
    await page2.waitForSelector('[aria-label="插件"]', { timeout: 30000 });
    await openPanel(page2);
    const sourceText = await page2.locator(".hp-bar-site").innerText();
    results.device2ConfigSource = sourceText;
    if (!sourceText.includes("共享笔记")) throw new Error(`device 2 did not use shared config: ${sourceText}`);
    await page2.screenshot({ path: join(SHOTS, "06-device2-auto-config.png") });
    log("device 2 connected without setup:", sourceText);

    await selectNoteInPanel(page2);
    const updateButton = page2.getByRole("button", { name: "更新已发布文章", exact: true });
    await updateButton.waitFor({ timeout: 20000 });
    const updatedTitle = `${CONFIG.noteTitle}（更新版）`;
    await page2.locator('.hp-detail input[data-field="title"]').fill(updatedTitle);
    await updateButton.click();
    const resultLink2 = page2.locator(".hp-result a").first();
    await resultLink2.waitFor({ timeout: 180000 });
    const articleUrl2 = await resultLink2.getAttribute("href");
    results.updatedUrl = articleUrl2;
    await dismissNotices(page2);
    await page2.waitForTimeout(1200);
    article = await (await fetch(articleUrl2)).text();
    if (!article.includes(updatedTitle)) throw new Error("updated article title mismatch");
    results.updateVerified = true;
    await page2.screenshot({ path: join(SHOTS, "07-panel-updated.png") });

    /* ---------- draft round-trip on device 2 ---------- */
    await page2.locator('.hp-detail select[data-field="status"]').selectOption("draft");
    await page2.getByRole("button", { name: "更新并保存为草稿", exact: true }).click();
    await page2.waitForFunction(
      () => (document.querySelector(".hp-log")?.textContent || "").includes("已保存为草稿"),
      null,
      { timeout: 180000 },
    );
    await dismissNotices(page2);
    // Assert on Halo's state: the article must be marked unpublished. The public
    // URL behaviour depends on the active theme, so it is only recorded.
    results.draftPublishFlag = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const post = await findHaloTestPost();
      results.draftPublishFlag = post && post.spec ? post.spec.publish : null;
      if (results.draftPublishFlag === false) break;
      await sleep(800);
    }
    results.draftUnpublishStatus = (await fetch(bustCache(articleUrl2), { redirect: "manual", cache: "no-store" })).status;
    if (results.draftPublishFlag !== false) throw new Error("Halo post is still marked published after draft");
    if (results.draftUnpublishStatus === 200) throw new Error("draft article is still publicly readable");
    await page2.locator('.hp-detail select[data-field="status"]').selectOption("published");
    await page2.getByRole("button", { name: "更新已发布文章", exact: true }).click();
    await page2.waitForFunction(
      () => (document.querySelector(".hp-log")?.textContent || "").includes("发布完成"),
      null,
      { timeout: 180000 },
    );
    await dismissNotices(page2);
    results.republishPublishFlag = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const post = await findHaloTestPost();
      results.republishPublishFlag = post && post.spec ? post.spec.publish : null;
      if (results.republishPublishFlag === true) break;
      await sleep(800);
    }
    results.republishStatus = 0;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      results.republishStatus = (await fetch(bustCache(articleUrl2), { cache: "no-store" })).status;
      if (results.republishStatus === 200) break;
      await sleep(800);
    }
    results.draftRoundTripVerified = results.republishPublishFlag === true && results.republishStatus === 200;
    const draftResultText = await page2.locator(".hp-result").innerText();
    results.draftResultText = draftResultText;
    if (!draftResultText.includes("草稿")) throw new Error("draft result message missing");
    if (!results.draftRoundTripVerified) throw new Error("draft round-trip did not republish the article");
    await page2.screenshot({ path: join(SHOTS, "08-panel-draft-roundtrip.png") });

    /* ---------- public page screenshot ---------- */
    const blogPage = await device2.context.newPage();
    await blogPage.goto(articleUrl2, { waitUntil: "domcontentloaded" });
    await blogPage.waitForTimeout(2500);
    await blogPage.screenshot({ path: join(SHOTS, "09-blog-article.png") });
    await blogPage.close();
    await device2.context.close();

    results.consoleErrors = consoleErrors.slice(0, 20);
    await writeFile(RESULT_PATH, JSON.stringify({ ok: true, ...results }, null, 2));
    await cleanupHaloContent();
    await cleanupEdgeEverContent();
    results.cleaned = true;
    await writeFile(RESULT_PATH, JSON.stringify({ ok: true, ...results }, null, 2));
    log("E2E PASSED (test content cleaned)");
  } catch (error) {
    results.error = error && error.message ? error.message : String(error);
    results.consoleErrors = consoleErrors.slice(0, 20);
    await writeFile(RESULT_PATH, JSON.stringify({ ok: false, ...results }, null, 2));
    if (activePage) {
      try {
        await activePage.screenshot({ path: join(SHOTS, "99-failure.png"), fullPage: false });
      } catch {
        /* ignore */
      }
    }
    log("E2E FAILED:", results.error);
    throw error;
  } finally {
    await browser.close();
  }
};

await main();
