import { marked } from "marked";
import DOMPurify from "dompurify";

const PLUGIN_ID = "com.twisterfeng.edgeever.halo-publisher";
const PANEL_ID = "halo-publisher";
const FALLBACK_CATEGORY = "默认分类";
const MAX_NOTE_RESULTS = 30;
const HISTORY_LIMIT = 40;
const REQUEST_TIMEOUT_MS = 30000;
const UPDATE_MAX_ATTEMPTS = 5;

// Host rule: setting keys must be lowercase letters, numbers, dots, dashes or underscores.
const SETTING_KEYS = {
  haloUrl: "halo_url",
  token: "token",
  defaultStatus: "default_status",
  useNoteTags: "use_note_tags",
  uploadImages: "upload_images",
  slugMode: "slug_mode",
  openAfterPublish: "open_after_publish",
};

const SETTING_DEFAULTS = {
  haloUrl: "",
  token: "",
  defaultStatus: "published",
  useNoteTags: true,
  uploadImages: true,
  slugMode: "title",
  openAfterPublish: true,
};

const CONFIG_NOTE_TITLE = "Halo 发布配置";
const CONFIG_NOTE_TAGS = ["edgeever-config"];

const STORAGE_KEYS = {
  history: "history",
  noteMapping: (noteId) => `note:${noteId}`,
  imageCache: (baseUrl, resourceId, contentHash) => `image|${baseUrl}|${resourceId}|${contentHash || ""}`,
  preferCategory: "pref:category",
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shortHash = (input) => {
  let hash = 2166136261;
  const value = String(input);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6).padStart(4, "0");
};

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const formatTime = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatDate = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
};

const normalizeBaseUrl = (raw) => {
  let value = String(raw || "").trim();
  if (!value) throw new Error("请先填写 Halo 站点地址");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Halo 站点地址必须以 http:// 或 https:// 开头");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
};

const k8sName = (value) => {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
};

const tagResourceName = (displayName, attempt = 0) => {
  const basic = k8sName(displayName);
  const suffix = attempt > 0 ? `-${shortHash(`${displayName}|${attempt}`).slice(0, 4)}` : "";
  if (basic.length >= 2) return `${basic.slice(0, 40)}${suffix}`;
  return `tag-${shortHash(displayName)}${suffix}`;
};

const categoryResourceName = (displayName) => {
  const basic = k8sName(displayName);
  if (basic.length >= 2) return basic.slice(0, 40);
  return `cat-${shortHash(displayName)}`;
};

const buildSlug = (title, note, mode) => {
  const base = String(title || "untitled")
    .trim()
    .toLowerCase()
    .replace(/['"“”‘’]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  const normalized = base || `post-${Date.now().toString(36)}`;
  return mode === "title-id" ? `${normalized}-${shortHash(note.id)}` : normalized;
};

const extensionForMime = (mimeType) => {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[mimeType] || "png";
};

const safeFilename = (name, fallback) => {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
};

const stripLeadingTitleHeading = (markdown, title) => {
  if (!markdown || !title) return markdown;
  const match = String(markdown).match(/^\s*#{1,2}\s+(.+?)\s*(?:\r?\n|$)/);
  if (!match) return markdown;
  if (normalizeText(match[1].replace(/\*\*/g, "")) !== normalizeText(title)) return markdown;
  return markdown.slice(match[0].length).replace(/^\r?\n/, "");
};

/* ------------------------------------------------------------------ */
/* markdown -> sanitized HTML                                          */
/* ------------------------------------------------------------------ */

marked.setOptions({ gfm: true, breaks: false });

const renderMarkdownHtml = (markdown) => {
  const raw = marked.parse(String(markdown || ""), { async: false });
  return DOMPurify.sanitize(String(raw), {
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button"],
  });
};

/* ------------------------------------------------------------------ */
/* Halo API client                                                     */
/* ------------------------------------------------------------------ */

const haloFriendlyError = (status, payload) => {
  const detail = payload && typeof payload === "object"
    ? String(payload.detail || payload.message || payload.title || "")
    : "";
  if (status === 401) return "Halo 认证失败（401）：个人令牌无效或已过期，请在设置里重新填写 PAT";
  if (status === 403) return "Halo 拒绝访问（403）：该令牌缺少权限，建议使用超级管理员账号生成的 PAT";
  if (status === 404) return "Halo 接口不存在（404）：请确认站点地址正确且为 Halo 2.x";
  if (status === 409) return "Halo 数据冲突（409）：正在重试，请稍候";
  if (status >= 500) return `Halo 服务异常（${status}）${detail ? `：${detail}` : ""}`;
  return `Halo 请求失败（${status}）${detail ? `：${detail}` : ""}`;
};

class HaloApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "HaloApiError";
    this.status = status || 0;
    this.payload = payload;
  }
}

class HaloClient {
  constructor(context, baseUrl, token) {
    this.context = context;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = String(token || "").trim();
    if (!this.token) throw new Error("请先填写 Halo 个人令牌（PAT）");
  }

  async request(path, options = {}) {
    const { method = "GET", body, headers = {}, timeout = REQUEST_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeout);
    const isForm = body instanceof FormData;
    const requestHeaders = { Authorization: `Bearer ${this.token}`, ...headers };
    if (body && !isForm) requestHeaders["Content-Type"] = "application/json";
    try {
      const response = await this.context.network.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}),
        signal: controller.signal,
        cache: "no-store",
        redirect: "follow",
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      if (!response.ok) throw new HaloApiError(haloFriendlyError(response.status, payload), response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof HaloApiError) throw error;
      if (error && (error.name === "AbortError" || /aborted/i.test(String(error.message)))) {
        throw new Error("请求 Halo 超时，请检查站点是否可访问");
      }
      throw new Error(`无法连接 Halo：${error && error.message ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  listPosts(size = 200) {
    return this.request(`/apis/api.console.halo.run/v1alpha1/posts?page=0&size=${size}`);
  }

  listCategories(size = 200) {
    return this.request(`/apis/content.halo.run/v1alpha1/categories?page=0&size=${size}`);
  }

  listTags(size = 300) {
    return this.request(`/apis/api.console.halo.run/v1alpha1/tags?page=0&size=${size}`);
  }

  getPost(name) {
    return this.request(`/apis/content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`);
  }

  createDraft(postRequest) {
    return this.request("/apis/api.console.halo.run/v1alpha1/posts", { method: "POST", body: postRequest });
  }

  updatePost(name, postRequest) {
    return this.request(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: postRequest,
    });
  }

  publishPost(name, headSnapshot) {
    const query = headSnapshot ? `?headSnapshot=${encodeURIComponent(headSnapshot)}` : "";
    return this.request(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/publish${query}`, {
      method: "PUT",
      timeout: 60000,
    });
  }

  unpublishPost(name) {
    return this.request(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/unpublish`, {
      method: "PUT",
    });
  }

  createTag(displayName, name) {
    return this.request("/apis/content.halo.run/v1alpha1/tags", {
      method: "POST",
      body: {
        apiVersion: "content.halo.run/v1alpha1",
        kind: "Tag",
        metadata: { name },
        spec: { displayName, slug: name },
      },
    });
  }

  createCategory(displayName, name) {
    return this.request("/apis/content.halo.run/v1alpha1/categories", {
      method: "POST",
      body: {
        apiVersion: "content.halo.run/v1alpha1",
        kind: "Category",
        metadata: { name },
        spec: { displayName, slug: name, priority: 0 },
      },
    });
  }

  async uploadAttachment(blob, filename) {
    const form = new FormData();
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    form.append("file", file);
    return this.request("/apis/console.api.storage.halo.run/v1alpha1/attachments/-/upload", {
      method: "POST",
      body: form,
      timeout: 120000,
    });
  }

  async verifyConnection() {
    const result = await this.listPosts(1);
    if (!result || !Array.isArray(result.items)) throw new Error("Halo 返回了预期外的响应，请确认站点地址是 Halo 2.x");
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* content building                                                    */
/* ------------------------------------------------------------------ */

const buildPostObject = ({ title, slug, categories, tags }) => ({
  apiVersion: "content.halo.run/v1alpha1",
  kind: "Post",
  metadata: { generateName: "edgeever-" },
  spec: {
    title,
    slug,
    deleted: false,
    publish: false,
    pinned: false,
    allowComment: true,
    visible: "PUBLIC",
    priority: 0,
    excerpt: { autoGenerate: true },
    categories: categories || [],
    tags: tags || [],
  },
});

const buildContentPayload = (markdown, html) => ({
  version: null,
  raw: markdown,
  content: html,
  rawType: "markdown",
});

/* ------------------------------------------------------------------ */
/* publishing workflow                                                 */
/* ------------------------------------------------------------------ */

const parseSharedConfig = (markdown) => {
  const text = String(markdown || "");
  const urlMatch = text.match(/^\s*HALO_URL\s*=\s*(\S+)\s*$/im);
  const tokenMatch = text.match(/^\s*HALO_TOKEN\s*=\s*(\S+)\s*$/im);
  return {
    haloUrl: urlMatch ? urlMatch[1].trim() : "",
    token: tokenMatch ? tokenMatch[1].trim() : "",
  };
};

const renderSharedConfigMarkdown = (haloUrl, token) => [
  "# Halo 发布配置",
  "",
  "> 这篇笔记保存 EdgeEver「Halo 博客发布」插件的连接配置，会随工作区同步到服务器与所有设备。",
  "> 内容包含 Halo 个人令牌，请勿公开分享这篇笔记。",
  "",
  `HALO_URL=${haloUrl}`,
  `HALO_TOKEN=${token}`,
  "",
].join("\n");

const findSharedConfig = async (context) => {
  try {
    const result = await context.notes.query({ text: CONFIG_NOTE_TITLE, limit: 10 });
    const notes = (result && result.notes) || [];
    const matched = notes.find((note) => String(note.title || "").trim() === CONFIG_NOTE_TITLE);
    if (!matched) return null;
    const note = await context.notes.get(matched.id);
    const config = parseSharedConfig(note.contentMarkdown);
    if (!config.haloUrl || !config.token) return { note, config: null };
    return { note, config };
  } catch {
    return null;
  }
};

const saveSharedConfig = async (context, { haloUrl, token }) => {
  const markdown = renderSharedConfigMarkdown(haloUrl, token);
  const existing = await findSharedConfig(context);
  if (existing && existing.note) {
    await context.notes.update(existing.note.id, { contentMarkdown: markdown });
    return existing.note.id;
  }
  const notebooks = await context.notebooks.list();
  const notebookId = notebooks && notebooks.length ? notebooks[0].id : "";
  if (!notebookId) throw new Error("工作区里没有可用笔记本，无法创建共享配置笔记");
  const created = await context.notes.create({
    notebookId,
    title: CONFIG_NOTE_TITLE,
    contentMarkdown: markdown,
    tags: CONFIG_NOTE_TAGS,
  });
  return created.id;
};

const readSettings = async (context) => {
  const settings = {};
  for (const [field, fallback] of Object.entries(SETTING_DEFAULTS)) {
    const stored = await context.settings.get(SETTING_KEYS[field] || field);
    settings[field] = stored === null || stored === undefined ? fallback : stored;
  }
  settings.haloUrl = String(settings.haloUrl || "");
  settings.token = String(settings.token || "");
  settings.configSource = settings.haloUrl && settings.token ? "local" : "none";
  if (settings.configSource !== "local") {
    const shared = await findSharedConfig(context);
    if (shared && shared.config) {
      settings.haloUrl = settings.haloUrl || shared.config.haloUrl;
      settings.token = settings.token || shared.config.token;
      settings.configSource = "note";
      settings.sharedConfigNoteId = shared.note && shared.note.id ? shared.note.id : "";
    }
  }
  return settings;
};

const createHaloClient = async (context, settings) => {
  const baseUrl = normalizeBaseUrl(settings.haloUrl);
  const client = new HaloClient(context, baseUrl, settings.token);
  await client.verifyConnection();
  return client;
};

const readMapping = async (context, noteId) => {
  const stored = await context.storage.get(STORAGE_KEYS.noteMapping(noteId));
  return stored && typeof stored === "object" ? stored : null;
};

const writeHistory = async (context, entry) => {
  const stored = await context.storage.get(STORAGE_KEYS.history);
  const list = Array.isArray(stored) ? stored : [];
  const next = [entry, ...list.filter((item) => item.noteId !== entry.noteId)].slice(0, HISTORY_LIMIT);
  await context.storage.set(STORAGE_KEYS.history, next);
  return next;
};

const readHistory = async (context) => {
  const stored = await context.storage.get(STORAGE_KEYS.history);
  return Array.isArray(stored) ? stored : [];
};

const uploadNoteImages = async ({ context, halo, note, markdown, log }) => {
  const matches = new Map();
  const pattern = /(edgeever-resource:\/\/resource\/([A-Za-z0-9_-]+))|((?:https?:\/\/[^\s)"'<>]+)?\/api\/v1\/resources\/([A-Za-z0-9_-]+)\/blob(?:\?[^\s)"'<>]*)?)/g;
  for (const match of String(markdown).matchAll(pattern)) {
    const resourceId = match[2] || match[4];
    if (resourceId) matches.set(resourceId, true);
  }
  if (matches.size === 0) return markdown;

  let resources = [];
  try {
    resources = await context.resources.list(note.id);
  } catch {
    resources = [];
  }
  const resourceById = new Map((resources || []).map((item) => [item.id, item]));

  log(`发现 ${matches.size} 张本地图片，开始转存到 Halo…`);
  const replacements = new Map();
  let index = 0;
  for (const resourceId of matches.keys()) {
    index += 1;
    try {
      const meta = resourceById.get(resourceId);
      const cacheKey = STORAGE_KEYS.imageCache(halo.baseUrl, resourceId, meta && meta.contentHash);
      let url = await context.storage.get(cacheKey);
      if (!url) {
        const blob = await context.resources.read(resourceId);
        const extension = extensionForMime((meta && meta.mimeType) || blob.type);
        const basename = safeFilename((meta && meta.filename) || "", `image-${index}.${extension}`);
        const filename = `edgever-${shortHash(note.id)}-${index}-${basename}`;
        const attachment = await halo.uploadAttachment(blob, filename);
        const permalink = attachment && attachment.status && attachment.status.permalink;
        url = permalink
          ? new URL(permalink, `${halo.baseUrl}/`).href
          : `${halo.baseUrl}/upload/${encodeURIComponent(filename)}`;
        await context.storage.set(cacheKey, url);
      }
      replacements.set(resourceId, url);
      log(`图片 ${index}/${matches.size} 已转存`);
    } catch (error) {
      log(`图片 ${index}/${matches.size} 转存失败：${error.message || error}（保留原链接）`);
    }
  }

  return String(markdown).replace(pattern, (full, legacy, legacyId, apiUrl, apiId) => {
    const resourceId = legacyId || apiId;
    return (resourceId && replacements.get(resourceId)) || full;
  });
};

const ensureTags = async (halo, displayNames, { cache, log }) => {
  const names = [];
  const unique = [...new Set(displayNames.map((item) => String(item).trim()).filter(Boolean))];
  if (unique.length === 0) return names;
  if (!cache.tagsLoaded) {
    const listed = await halo.listTags(300);
    cache.tags = Array.isArray(listed && listed.items) ? listed.items : [];
    cache.tagsLoaded = true;
  }
  for (const displayName of unique) {
    const byDisplay = cache.tags.find((tag) => tag && tag.spec && tag.spec.displayName === displayName);
    if (byDisplay) {
      names.push(byDisplay.metadata.name);
      continue;
    }
    let created = null;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      try {
        created = await halo.createTag(displayName, tagResourceName(displayName, attempt));
      } catch (error) {
        if (error instanceof HaloApiError && error.status === 409) {
          const listed = await halo.listTags(300);
          cache.tags = Array.isArray(listed && listed.items) ? listed.items : [];
          const existing = cache.tags.find((tag) => tag && tag.spec && tag.spec.displayName === displayName);
          if (existing) created = existing;
          continue;
        }
        throw error;
      }
    }
    if (!created) throw new Error(`无法创建 Halo 标签「${displayName}」`);
    cache.tags.push(created);
    names.push(created.metadata.name);
    log(`已创建标签「${displayName}」`);
  }
  return names;
};

const ensureCategory = async (halo, displayName, { cache, log }) => {
  if (!displayName) return [];
  if (!cache.categoriesLoaded) {
    const listed = await halo.listCategories(200);
    cache.categories = Array.isArray(listed && listed.items) ? listed.items : [];
    cache.categoriesLoaded = true;
  }
  const existing = cache.categories.find((category) => category && category.spec && category.spec.displayName === displayName);
  if (existing) return [existing.metadata.name];
  const created = await halo.createCategory(displayName, categoryResourceName(displayName));
  cache.categories.push(created);
  log(`已创建分类「${displayName}」`);
  return [created.metadata.name];
};

const updateExistingPost = async (halo, mapping, spec, markdown, html, log) => {
  let lastError = null;
  for (let attempt = 1; attempt <= UPDATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const current = await halo.getPost(mapping.postName);
      const currentSpec = (current && current.spec) || {};
      const next = {
        ...current,
        spec: {
          ...currentSpec,
          title: spec.title,
          slug: spec.slug,
          categories: spec.categories,
          tags: spec.tags,
          excerpt: { autoGenerate: true },
        },
      };
      return await halo.updatePost(mapping.postName, {
        post: next,
        content: buildContentPayload(markdown, html),
      });
    } catch (error) {
      lastError = error;
      if (error instanceof HaloApiError && error.status === 404) {
        const notFound = new Error("原文已在 Halo 中删除或改名");
        notFound.code = "HALO_POST_GONE";
        throw notFound;
      }
      if (error instanceof HaloApiError && error.status === 409) {
        log(`Halo 并发更新冲突，重试 ${attempt}/${UPDATE_MAX_ATTEMPTS}…`);
        await sleep(350 * attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("更新 Halo 文章失败");
};

const uniqueSlug = async (halo, slug, postName) => {
  try {
    const listed = await halo.listPosts(200);
    const taken = new Set(
      (Array.isArray(listed && listed.items) ? listed.items : [])
        .filter((post) => post && post.metadata && post.metadata.name !== postName)
        .map((post) => post.spec && post.spec.slug)
        .filter(Boolean),
    );
    if (!taken.has(slug)) return slug;
    const suffixed = `${slug}-${Date.now().toString(36).slice(-4)}`;
    return taken.has(suffixed) ? `${suffixed}-${shortHash(String(Date.now()))}` : suffixed;
  } catch {
    return slug;
  }
};

const publishNoteToHalo = async ({ context, halo, note, options, settings, log }) => {
  if (!note) throw new Error("请先选择一篇笔记");
  if (note.kind && note.kind !== "text") throw new Error("当前仅支持普通文本笔记（图表/表格/海报等结构化笔记暂不支持）");
  if (!note.contentMarkdown || !note.contentMarkdown.trim()) throw new Error("这篇笔记没有正文内容");

  const title = String(options.title || note.title || "").trim();
  if (!title) throw new Error("文章标题不能为空");

  let markdown = stripLeadingTitleHeading(note.contentMarkdown, title);
  if (options.uploadImages) {
    markdown = await uploadNoteImages({ context, halo, note, markdown, log });
  }

  log("渲染 Markdown 为 HTML…");
  const html = renderMarkdownHtml(markdown);
  if (!html.trim()) throw new Error("笔记正文渲染后为空，无法发布");

  const cache = { tags: [], tagsLoaded: false, categories: [], categoriesLoaded: false };
  const tagDisplayNames = options.tags || [];
  log(tagDisplayNames.length ? `同步标签：${tagDisplayNames.join("、")}` : "不同步标签");
  const tags = await ensureTags(halo, tagDisplayNames, { cache, log });
  const categories = await ensureCategory(halo, options.category, { cache, log });

  const mapping = await readMapping(context, note.id);
  const isSameInstance = Boolean(mapping && mapping.haloUrl === halo.baseUrl);
  const spec = { title, slug: String(options.slug || "").trim() || buildSlug(title, note, settings.slugMode), categories, tags };

  let post = null;
  if (isSameInstance && mapping && mapping.postName) {
    log(`更新 Halo 文章 ${mapping.postName}…`);
    try {
      post = await updateExistingPost(halo, mapping, spec, markdown, html, log);
    } catch (error) {
      if (error.code !== "HALO_POST_GONE") throw error;
      log("原文章已不存在，改为创建新文章");
      post = null;
      mapping.postName = null;
    }
  }
  if (!post) {
    spec.slug = await uniqueSlug(halo, spec.slug, null);
    log("在 Halo 创建文章草稿…");
    post = await halo.createDraft({
      post: buildPostObject({ title: spec.title, slug: spec.slug, categories, tags }),
      content: buildContentPayload(markdown, html),
    });
  }

  const postName = post && post.metadata && post.metadata.name;
  if (!postName) throw new Error("Halo 未返回文章标识，创建失败");

  const shouldPublish = options.status === "published";
  let finalPost = post;
  if (shouldPublish) {
    log("发布文章…");
    finalPost = await halo.publishPost(postName, post && post.spec && post.spec.headSnapshot);
  } else if (post && post.spec && post.spec.publish) {
    log("撤回为草稿状态…");
    finalPost = await halo.unpublishPost(postName);
  }

  let permalink = finalPost && finalPost.status && finalPost.status.permalink;
  if (!permalink) {
    try {
      const fetched = await halo.getPost(postName);
      permalink = fetched && fetched.status && fetched.status.permalink;
    } catch {
      permalink = "";
    }
  }
  const articleUrl = permalink ? new URL(permalink, `${halo.baseUrl}/`).href : `${halo.baseUrl}/console/posts/${postName}`;
  const consoleUrl = `${halo.baseUrl}/console/posts/${postName}`;

  const entry = {
    noteId: note.id,
    noteTitle: title,
    haloUrl: halo.baseUrl,
    postName,
    slug: spec.slug,
    permalink: articleUrl,
    consoleUrl,
    published: shouldPublish,
    status: shouldPublish ? "published" : "draft",
    updatedAt: new Date().toISOString(),
  };
  await context.storage.set(STORAGE_KEYS.noteMapping(note.id), entry);
  await writeHistory(context, entry);
  log(shouldPublish ? "发布完成" : "已保存为草稿");
  return entry;
};

/* ------------------------------------------------------------------ */
/* panel UI                                                            */
/* ------------------------------------------------------------------ */

const createPanelState = () => ({
  settings: { ...SETTING_DEFAULTS },
  halo: null,
  connected: false,
  connecting: false,
  connectionError: "",
  notes: [],
  selectedNote: null,
  selectedMapping: null,
  noteBusy: false,
  publishing: false,
  categories: [],
  categoryCache: null,
  history: [],
});

const mountPanel = (context, container) => {
  const state = createPanelState();
  let disposed = false;
  const cleanups = [];
  const on = (target, type, handler) => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  container.replaceChildren();
  const root = el("div", "hp");
  container.append(root);

  const bar = el("div", "hp-bar");
  const dot = el("span", "hp-dot");
  const barText = el("span", "hp-bar-text", "Halo 博客发布");
  const barSite = el("span", "hp-bar-site", "未连接");
  const spacer = el("span", "hp-spacer");
  const configButton = el("button", "hp-link", "配置");
  configButton.type = "button";
  const consoleButton = el("button", "hp-link", "打开 Halo 后台");
  consoleButton.type = "button";
  bar.append(dot, barText, barSite, spacer, configButton, consoleButton);

  const setupBox = el("div", "hp-setup");
  setupBox.hidden = true;
  const setupUrlLabel = el("label", "hp-field");
  setupUrlLabel.append(el("span", null, "Halo 站点地址"));
  const setupUrlInput = el("input", "hp-input");
  setupUrlInput.placeholder = "https://blog.example.com";
  setupUrlInput.spellcheck = false;
  setupUrlLabel.append(setupUrlInput);
  const setupTokenLabel = el("label", "hp-field");
  setupTokenLabel.append(el("span", null, "个人令牌 PAT"));
  const setupTokenInput = el("input", "hp-input");
  setupTokenInput.type = "password";
  setupTokenInput.placeholder = "pat_…（已保存时留空表示不修改）";
  setupTokenInput.spellcheck = false;
  setupTokenLabel.append(setupTokenInput);
  const setupHint = el("div", "hp-hint", "令牌在 Halo 后台「个人中心 → 个人令牌」生成，权限选超级管理员。");
  const setupSourceHint = el("div", "hp-hint");
  const setupActions = el("div", "hp-setup-actions");
  const setupSaveButton = el("button", "hp-btn hp-btn-primary", "保存并同步到所有设备");
  setupSaveButton.type = "button";
  const setupLocalButton = el("button", "hp-btn", "仅保存到本设备");
  setupLocalButton.type = "button";
  const setupStatus = el("span", "hp-hint");
  setupActions.append(setupSaveButton, setupLocalButton, setupStatus);
  setupBox.append(setupUrlLabel, setupTokenLabel, setupHint, setupSourceHint, setupActions);

  const main = el("div", "hp-main");
  const pickRow = el("div", "hp-row");
  const searchInput = el("input", "hp-input hp-search");
  searchInput.placeholder = "搜索笔记（标题或内容）…";
  searchInput.spellcheck = false;
  const refreshButton = el("button", "hp-btn", "刷新");
  refreshButton.type = "button";
  pickRow.append(searchInput, refreshButton);
  const notesBox = el("div", "hp-notes");
  notesBox.setAttribute("role", "listbox");
  const emptyBox = el("div", "hp-empty", "正在加载笔记…");

  const detail = el("div", "hp-detail");
  detail.hidden = true;
  const detailHeadTitle = el("div", "hp-note-title");
  const detailHeadMeta = el("div", "hp-note-meta");
  const detailHead = el("div", "hp-note-head");
  detailHead.append(detailHeadTitle, detailHeadMeta);

  const warnBox = el("div", "hp-warn");
  warnBox.hidden = true;

  const grid = el("div", "hp-grid");
  const field = (labelText, control) => {
    const wrap = el("label", "hp-field");
    wrap.append(el("span", null, labelText), control);
    return wrap;
  };
  const titleInput = el("input", "hp-input");
  titleInput.dataset.field = "title";
  const slugInput = el("input", "hp-input");
  slugInput.dataset.field = "slug";
  const categorySelect = el("select", "hp-select");
  categorySelect.dataset.field = "category";
  const tagsInput = el("input", "hp-input");
  tagsInput.dataset.field = "tags";
  const statusSelect = el("select", "hp-select");
  statusSelect.dataset.field = "status";
  for (const [value, label] of [["published", "直接发布"], ["draft", "保存为草稿"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    statusSelect.append(option);
  }
  const uploadLabel = el("label", "hp-check");
  const uploadCheckbox = el("input");
  uploadCheckbox.type = "checkbox";
  uploadCheckbox.dataset.field = "uploadImages";
  uploadLabel.append(uploadCheckbox, el("span", null, "上传笔记图片"));
  grid.append(
    field("文章标题", titleInput),
    field("链接 slug", slugInput),
    field("分类", categorySelect),
    field("标签（逗号分隔）", tagsInput),
    field("发布状态", statusSelect),
    uploadLabel,
  );

  const newCategoryRow = el("div", "hp-row");
  newCategoryRow.hidden = true;
  const newCategoryInput = el("input", "hp-input");
  newCategoryInput.placeholder = "新分类名称，例如：技术笔记";
  newCategoryRow.append(newCategoryInput);

  const actions = el("div", "hp-actions");
  const publishButton = el("button", "hp-btn hp-btn-primary", "发布到 Halo");
  publishButton.type = "button";
  const draftButton = el("button", "hp-btn", "保存为草稿");
  draftButton.type = "button";
  const mappingHint = el("span", "hp-hint");
  actions.append(publishButton, draftButton, mappingHint);

  const logBox = el("div", "hp-log");
  logBox.hidden = true;
  const resultBox = el("div", "hp-result");
  resultBox.hidden = true;
  detail.append(detailHead, warnBox, grid, newCategoryRow, actions, logBox, resultBox);
  const detailEmpty = el("div", "hp-empty", "选择一篇笔记开始发布");

  main.append(pickRow, notesBox, emptyBox, detail);

  const historyBox = el("details", "hp-history");
  const historySummary = el("summary");
  const historyCount = el("span", "hp-count");
  historySummary.append(document.createTextNode("发布记录 "), historyCount);
  const historyList = el("div", "hp-history-list");
  historyBox.append(historySummary, historyList);

  root.append(bar, setupBox, main, historyBox);

  /* ---------------- rendering helpers ---------------- */

  const setLog = (message, isError = false) => {
    logBox.hidden = false;
    const line = el("div", isError ? "hp-log-error" : null, message);
    logBox.append(line);
    logBox.scrollTop = logBox.scrollHeight;
  };
  const clearLog = () => {
    logBox.replaceChildren();
    logBox.hidden = true;
  };
  const showResult = (entry) => {
    resultBox.hidden = false;
    resultBox.replaceChildren();
    resultBox.append(el("span", null, entry.published ? "已发布：" : "已保存草稿："));
    const link = el("a", null, entry.permalink);
    link.href = entry.permalink;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    resultBox.append(link);
    const copy = el("button", "hp-link", "复制链接");
    copy.type = "button";
    copy.addEventListener("click", () => {
      void navigator.clipboard
        ?.writeText(entry.permalink)
        .then(() => context.ui.showNotice("链接已复制"))
        .catch(() => context.ui.showNotice("复制失败，请手动复制"));
    });
    resultBox.append(copy);
  };
  const showWarn = (message) => {
    warnBox.hidden = !message;
    warnBox.textContent = message || "";
  };
  const syncPublishLabels = () => {
    const hasMapping = Boolean(
      state.selectedMapping && state.halo && state.selectedMapping.haloUrl === state.halo.baseUrl,
    );
    publishButton.textContent = hasMapping ? "更新已发布文章" : "发布到 Halo";
    draftButton.textContent = hasMapping ? "更新并保存草稿" : "保存为草稿";
  };
  const setBusy = (busy, publishing = false) => {
    state.publishing = publishing;
    publishButton.disabled = busy;
    draftButton.disabled = busy;
    setupSaveButton.disabled = busy;
    setupLocalButton.disabled = busy;
    if (publishing) publishButton.textContent = "正在发布…";
    else syncPublishLabels();
  };
  const setConnectionUI = () => {
    if (state.connecting) {
      dot.dataset.state = "loading";
      barSite.textContent = "连接中…";
      return;
    }
    if (state.connected) {
      dot.dataset.state = "ok";
      const label = state.settings.haloUrl || "";
      const source = state.settings.configSource === "note" ? " · 配置来自共享笔记" : "";
      barSite.textContent = label ? `已连接 ${label}${source}` : `已连接${source}`;
      setupBox.hidden = true;
      return;
    }
    dot.dataset.state = state.settings.haloUrl ? "error" : "";
    barSite.textContent = state.settings.haloUrl ? "连接失败" : "未配置";
  };

  /* ---------------- notes ---------------- */

  const renderNotes = () => {
    notesBox.replaceChildren();
    emptyBox.hidden = state.notes.length > 0;
    if (state.notes.length === 0) {
      emptyBox.hidden = false;
      emptyBox.textContent = state.noteBusy ? "正在搜索…" : "没有找到笔记";
      return;
    }
    for (const note of state.notes) {
      const item = el("button", "hp-note");
      item.type = "button";
      item.dataset.selected = String(state.selectedNote && state.selectedNote.id === note.id);
      item.setAttribute("role", "option");
      const title = el("span", "hp-note-title", note.title || "（无标题笔记）");
      const meta = el("span", "hp-note-meta", `${formatDate(note.updatedAt)} · ${note.excerpt || ""}`.slice(0, 120));
      item.append(title, meta);
      item.addEventListener("click", () => void selectNote(note));
      notesBox.append(item);
    }
  };

  const loadNotes = async (text) => {
    if (disposed) return;
    state.noteBusy = true;
    if (!state.selectedNote) {
      emptyBox.hidden = false;
      emptyBox.textContent = "正在搜索…";
    }
    try {
      const result = await context.notes.query({
        text: text ? String(text).trim() : undefined,
        sort: "updated-desc",
        limit: MAX_NOTE_RESULTS,
      });
      if (disposed) return;
      state.notes = Array.isArray(result && result.notes) ? result.notes : [];
    } catch (error) {
      state.notes = [];
      emptyBox.hidden = false;
      emptyBox.textContent = `读取笔记失败：${error.message || error}`;
    } finally {
      if (!disposed) {
        state.noteBusy = false;
        renderNotes();
      }
    }
  };

  const renderCategoryOptions = (selectedDisplayName) => {
    categorySelect.replaceChildren();
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "（不指定分类）";
    categorySelect.append(blank);
    if (!state.categories.some((category) => normalizeText(category.spec?.displayName) === normalizeText(FALLBACK_CATEGORY))) {
      const fallback = document.createElement("option");
      fallback.value = FALLBACK_CATEGORY;
      fallback.textContent = `${FALLBACK_CATEGORY}（将自动创建）`;
      categorySelect.append(fallback);
    }
    for (const category of state.categories) {
      const displayName = category.spec?.displayName || category.metadata?.name;
      if (!displayName) continue;
      const option = document.createElement("option");
      option.value = displayName;
      option.textContent = displayName;
      categorySelect.append(option);
    }
    const create = document.createElement("option");
    create.value = "__new__";
    create.textContent = "＋ 新建分类…";
    categorySelect.append(create);
    const wanted = selectedDisplayName
      || state.settings.preferCategory
      || FALLBACK_CATEGORY;
    const found = [...categorySelect.options].some((option) => option.value === wanted);
    categorySelect.value = found ? wanted : "";
    newCategoryRow.hidden = categorySelect.value !== "__new__";
  };

  const loadHaloOptions = async () => {
    if (!state.halo) return;
    try {
      const [categories, tags] = await Promise.all([
        state.halo.listCategories(200),
        state.halo.listTags(300),
      ]);
      state.categories = Array.isArray(categories && categories.items) ? categories.items : [];
      state.categoryCache = { categories: state.categories, tags: Array.isArray(tags && tags.items) ? tags.items : [] };
      renderCategoryOptions();
    } catch (error) {
      setLog(`读取 Halo 分类/标签失败：${error.message || error}`, true);
    }
  };

  const applySelectedNote = (note) => {
    detail.hidden = false;
    detailEmpty.hidden = true;
    detailHeadTitle.textContent = note.title || "（无标题笔记）";
    const kindLabel = note.kind && note.kind !== "text" ? ` · 类型：${note.kind}（不支持）` : "";
    detailHeadMeta.textContent = `${formatDate(note.updatedAt)} · ${note.tags && note.tags.length ? note.tags.join("、") : "无标签"}${kindLabel}`;
    const unsupported = note.kind && note.kind !== "text";
    showWarn(unsupported ? "这篇笔记是结构化笔记（图表/表格/海报等），当前插件仅支持普通文本笔记，发布会被阻止。" : "");
    titleInput.value = note.title || "";
    slugInput.value = "";
    tagsInput.value = state.settings.useNoteTags && Array.isArray(note.tags) ? note.tags.join(", ") : "";
    uploadCheckbox.checked = Boolean(state.settings.uploadImages);
    statusSelect.value = state.settings.defaultStatus === "draft" ? "draft" : "published";
    renderCategoryOptions(state.settings.preferCategory || FALLBACK_CATEGORY);
    clearLog();
    resultBox.hidden = true;
    mappingHint.textContent = "";
    publishButton.disabled = Boolean(unsupported);
    draftButton.disabled = Boolean(unsupported);
  };

  const refreshMappingHint = async (note) => {
    state.selectedMapping = null;
    if (!note || !state.halo) {
      syncPublishLabels();
      return;
    }
    const mapping = await readMapping(context, note.id);
    if (disposed) return;
    if (!mapping) {
      syncPublishLabels();
      return;
    }
    state.selectedMapping = mapping;
    if (mapping.haloUrl !== state.halo.baseUrl) {
      syncPublishLabels();
      mappingHint.textContent = "这条笔记曾发布到其它 Halo 实例，本次会创建新文章";
      return;
    }
    syncPublishLabels();
    slugInput.value = mapping.slug || "";
    mappingHint.textContent = `将更新已有文章（${formatTime(mapping.updatedAt)}）`;
  };

  const selectNote = async (note) => {
    if (disposed) return;
    state.selectedNote = null;
    syncPublishLabels();
    try {
      const full = await context.notes.get(note.id);
      if (disposed) return;
      state.selectedNote = full;
      applySelectedNote(full);
      await refreshMappingHint(full);
    } catch (error) {
      context.ui.showNotice(`读取笔记失败：${error.message || error}`);
    }
  };

  /* ---------------- history ---------------- */

  const renderHistory = () => {
    historyList.replaceChildren();
    historyCount.textContent = state.history.length ? `(${state.history.length})` : "";
    if (state.history.length === 0) {
      historyList.append(el("div", "hp-hint", "还没有发布记录"));
      return;
    }
    for (const entry of state.history) {
      const row = el("div", "hp-history-item");
      const badge = el("span", "hp-badge", entry.published ? "已发布" : "草稿");
      badge.dataset.state = entry.published ? "published" : "draft";
      const title = el("span", "hp-history-title", entry.noteTitle || entry.slug || entry.postName);
      const time = el("span", "hp-history-time", formatTime(entry.updatedAt));
      const open = el("a", "hp-link", "打开");
      open.href = entry.permalink || entry.consoleUrl || state.settings.haloUrl;
      open.target = "_blank";
      open.rel = "noreferrer noopener";
      row.append(badge, title, time, open);
      historyList.append(row);
    }
  };

  const loadHistory = async () => {
    state.history = await readHistory(context);
    renderHistory();
  };

  /* ---------------- connection ---------------- */

  const connect = async () => {
    state.connecting = true;
    state.connectionError = "";
    setConnectionUI();
    try {
      state.halo = await createHaloClient(context, state.settings);
      state.connected = true;
      await loadHaloOptions();
      await loadHistory();
      if (state.selectedNote) await refreshMappingHint(state.selectedNote);
    } catch (error) {
      state.halo = null;
      state.connected = false;
      state.connectionError = error.message || String(error);
      setupStatus.textContent = `连接失败：${state.connectionError}`;
      setupBox.hidden = false;
    } finally {
      state.connecting = false;
      setConnectionUI();
      if (disposed) return;
      if (!state.connected) {
        emptyBox.hidden = false;
        emptyBox.textContent = "请先完成 Halo 连接配置";
      }
    }
  };

  const applyConnectedState = async (client, baseUrl, token, configSource) => {
    state.settings.haloUrl = baseUrl;
    state.settings.token = token;
    state.settings.configSource = configSource;
    state.halo = client;
    state.connected = true;
    setupTokenInput.value = "";
    setupBox.hidden = true;
    setConnectionUI();
    await loadHaloOptions();
    await loadHistory();
    if (!state.notes.length) void loadNotes(searchInput.value);
  };

  const saveSetup = async (target) => {
    const rawUrl = setupUrlInput.value.trim() || state.settings.haloUrl;
    const rawToken = setupTokenInput.value.trim() || state.settings.token;
    setupStatus.textContent = "";
    if (!rawUrl) {
      setupStatus.textContent = "请填写 Halo 站点地址";
      return;
    }
    if (!rawToken) {
      setupStatus.textContent = "请填写个人令牌 PAT";
      return;
    }
    setupSaveButton.disabled = true;
    setupLocalButton.disabled = true;
    setupStatus.textContent = target === "note" ? "正在验证并写入共享配置笔记…" : "正在验证连接…";
    try {
      const baseUrl = normalizeBaseUrl(rawUrl);
      const client = new HaloClient(context, baseUrl, rawToken);
      await client.verifyConnection();
      if (target === "note") {
        try {
          await saveSharedConfig(context, { haloUrl: baseUrl, token: rawToken });
          // Shared note wins across devices: drop stale per-device overrides.
          await context.settings.remove(SETTING_KEYS.haloUrl).catch(() => undefined);
          await context.settings.remove(SETTING_KEYS.token).catch(() => undefined);
          setupStatus.textContent = "已写入共享配置笔记，之后所有设备会自动读取";
        } catch (error) {
          setupStatus.textContent = `共享配置保存失败：${error.message || error}（已改为仅保存到本设备）`;
          await context.settings.set(SETTING_KEYS.haloUrl, baseUrl);
          await context.settings.set(SETTING_KEYS.token, rawToken);
          target = "local";
        }
      } else {
        await context.settings.set(SETTING_KEYS.haloUrl, baseUrl);
        await context.settings.set(SETTING_KEYS.token, rawToken);
        setupStatus.textContent = "已保存到本设备（其它设备仍需各自配置）";
      }
      await applyConnectedState(client, baseUrl, rawToken, target === "note" ? "note" : "local");
      setupSourceHint.textContent = target === "note"
        ? "配置来源：工作区笔记《Halo 发布配置》（随服务器同步到所有设备）"
        : "配置来源：本设备插件设置";
    } catch (error) {
      state.connected = false;
      state.halo = null;
      setupStatus.textContent = error.message || String(error);
    } finally {
      setupSaveButton.disabled = false;
      setupLocalButton.disabled = false;
    }
  };

  /* ---------------- publishing ---------------- */

  const collectOptions = () => {
    const tags = tagsInput.value
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    let category = categorySelect.value;
    if (category === "__new__") category = newCategoryInput.value.trim();
    if (category === "__new__") category = "";
    return {
      title: titleInput.value.trim(),
      slug: slugInput.value.trim(),
      tags,
      category,
      status: statusSelect.value === "draft" ? "draft" : "published",
      uploadImages: uploadCheckbox.checked,
    };
  };

  const runPublish = async (statusOverride) => {
    if (state.publishing) return;
    if (!state.halo || !state.connected) {
      context.ui.showNotice("请先完成 Halo 连接配置");
      setupBox.hidden = false;
      return;
    }
    const note = state.selectedNote;
    if (!note) {
      context.ui.showNotice("请先选择一篇笔记");
      return;
    }
    const options = collectOptions();
    if (statusOverride) options.status = statusOverride;
    if (options.category === "__new__") options.category = newCategoryInput.value.trim();
    if (newCategoryRow.hidden === false && !options.category) {
      context.ui.showNotice("请填写新分类名称，或把分类改回不指定");
      return;
    }
    clearLog();
    resultBox.hidden = true;
    setBusy(true, true);
    try {
      const entry = await publishNoteToHalo({
        context,
        halo: state.halo,
        note,
        options,
        settings: state.settings,
        log: (message, isError) => setLog(message, isError),
      });
      showResult(entry);
      await loadHistory();
      await refreshMappingHint(note);
      if (options.category && options.category !== "__new__") {
        state.settings.preferCategory = options.category;
        await context.storage.set(STORAGE_KEYS.preferCategory, options.category).catch(() => undefined);
      }
      context.ui.showNotice(entry.published ? "已发布到 Halo 博客" : "已保存到 Halo 草稿");
      if (entry.published && state.settings.openAfterPublish) {
        try {
          const desktop = typeof window !== "undefined" && window.edgeeverDesktop && window.edgeeverDesktop.isAvailable;
          if (!desktop) window.open(entry.permalink, "_blank", "noopener,noreferrer");
        } catch {
          /* auto-open is best effort */
        }
      }
    } catch (error) {
      setLog(`发布失败：${error.message || error}`, true);
      context.ui.showNotice(`发布失败：${error.message || error}`);
    } finally {
      setBusy(false, false);
    }
  };

  /* ---------------- wiring ---------------- */

  let searchTimer = 0;
  on(searchInput, "input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadNotes(searchInput.value), 260);
  });
  on(refreshButton, "click", () => void loadNotes(searchInput.value));
  on(configButton, "click", () => {
    const visible = !setupBox.hidden;
    setupBox.hidden = visible;
    if (!visible) {
      setupUrlInput.value = state.settings.haloUrl || "";
      setupTokenInput.value = "";
      setupUrlInput.focus();
    }
  });
  on(consoleButton, "click", () => {
    const target = state.settings.haloUrl ? `${state.settings.haloUrl}/console` : "";
    if (!target) {
      context.ui.showNotice("请先配置 Halo 站点地址");
      return;
    }
    try {
      window.open(target, "_blank", "noopener,noreferrer");
    } catch {
      context.ui.showNotice(target);
    }
  });
  on(setupSaveButton, "click", () => void saveSetup("note"));
  on(setupLocalButton, "click", () => void saveSetup("local"));
  on(categorySelect, "change", () => {
    newCategoryRow.hidden = categorySelect.value !== "__new__";
    if (!newCategoryRow.hidden) newCategoryInput.focus();
  });
  on(publishButton, "click", () => void runPublish("published"));
  on(draftButton, "click", () => void runPublish("draft"));

  /* ---------------- boot ---------------- */

  void (async () => {
    setConnectionUI();
    state.settings = await readSettings(context);
    const preferredCategory = await context.storage.get(STORAGE_KEYS.preferCategory);
    if (typeof preferredCategory === "string" && preferredCategory) state.settings.preferCategory = preferredCategory;
    setupUrlInput.value = state.settings.haloUrl || "";
    uploadCheckbox.checked = Boolean(state.settings.uploadImages);
    if (state.settings.configSource === "note") {
      setupSourceHint.textContent = "配置来源：工作区笔记《Halo 发布配置》（随服务器同步到所有设备）";
    } else if (state.settings.configSource === "local") {
      setupSourceHint.textContent = "配置来源：本设备插件设置";
    }
    if (!state.settings.haloUrl || !state.settings.token) {
      setupBox.hidden = false;
      setupStatus.textContent = "";
      setConnectionUI();
      emptyBox.textContent = "请先完成 Halo 连接配置（默认会保存为共享笔记，所有设备自动生效）";
      return;
    }
    await connect();
    if (disposed) return;
    if (!state.connected) return;
    await loadNotes();
    await loadHistory();
  })();

  return () => {
    disposed = true;
    window.clearTimeout(searchTimer);
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* noop */
      }
    }
    root.remove();
  };
};

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export default {
  activate(context) {
    const disposers = [];
    disposers.push(
      context.commands.register({
        id: "open-halo-publisher",
        title: "发布到 Halo 博客",
        listed: true,
        menu: false,
        run: () => context.ui.panels.open(PANEL_ID),
      }),
    );
    disposers.push(
      context.ui.panels.register({
        id: PANEL_ID,
        title: "Halo 博客发布",
        purpose: "dashboard",
        presentation: "dialog",
        mount: (container) => mountPanel(context, container),
      }),
    );
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* noop */
        }
      }
    };
  },
};
