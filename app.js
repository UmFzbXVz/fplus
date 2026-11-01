const queryInput = document.getElementById("queryInput");
const goButton = document.getElementById("goButton");
const searchForm = document.getElementById("searchForm");
const statusEl = document.getElementById("status");
const articleEl = document.getElementById("article");
const homeLink = document.getElementById("homeLink");

const BASE = "https://www.folketidende.dk";
const API_BASE = "https://api.folketidende.dk/article";
const IMAGE_BASE = "https://image.folketidende.dk/";

let cachedTabs = { seneste: [], mestLaeste: [] };
let activeTab = "seneste";

let searchState = {
  query: "",
  start: 0,
  total: 0,
  items: [],
};

function looksLikeFolketidendeUrl(value) {
  const v = (value || "").trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      (u.hostname === "folketidende.dk" || u.hostname === "www.folketidende.dk")
    );
  } catch {
    if (/^https?:\/\//i.test(v)) return false;
    if (/^(www\.)?folketidende\.dk\//i.test(v)) return true;
    if (v.startsWith("/") && (v.startsWith("/plus/") || v.startsWith("/nyheder/") || v.startsWith("/a/"))) {
      return true;
    }
    return false;
  }
}

function normalizeArticleUrl(value) {
  let v = (value || "").trim();
  if (!v.startsWith("http")) {
    if (v.startsWith("/")) v = BASE + v;
    else if (/^(www\.)?folketidende\.dk\//i.test(v)) v = "https://" + v.replace(/^www\./i, "www.");
    else throw new Error("Ugyldigt link.");
  }
  const url = new URL(v);
  if (url.protocol === "http:") url.protocol = "https:";
  const allowedHosts = ["folketidende.dk", "www.folketidende.dk"];
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error("Linket skal pege på folketidende.dk.");
  }
  return url.href;
}

function isFolketidendeUrl(href) {
  if (!href) return false;
  try {
    const u = new URL(href, BASE);
    return (
      (u.hostname === "folketidende.dk" || u.hostname === "www.folketidende.dk") &&
      (u.protocol === "https:" || u.protocol === "http:")
    );
  } catch {
    return false;
  }
}

function removeUnsafeContent(root) {
  root
    .querySelectorAll(
      "script, iframe, object, embed, form, input, button, textarea, select, " +
        "style, link, meta, base, noscript, .advertisement, .ad, [class*='advert']"
    )
    .forEach((el) => el.remove());

  root.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "style") {
        el.removeAttribute(attr.name);
      }
      if (
        ["href", "src", "xlink:href"].includes(name) &&
        value.startsWith("javascript:")
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });

  root.querySelectorAll("img[src], a[href], source[src]").forEach((el) => {
    const attr = el.tagName === "A" ? "href" : "src";
    try {
      const resolved = new URL(el.getAttribute(attr), window.__articleBase);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") {
        el.setAttribute(attr, resolved.href);
      } else {
        el.removeAttribute(attr);
      }
    } catch {
      el.removeAttribute(attr);
    }
  });
}

async function fetchThroughProxy(targetUrl) {
  const encoded = encodeURIComponent(targetUrl);
  const proxies = [
    { name: "cors.dev", url: `https://proxy.cors.dev/raw?url=${encoded}` },
    { name: "CodeTabs", url: `https://api.codetabs.com/v1/proxy?quest=${encoded}` },
  ];
  const errors = [];
  for (const proxy of proxies) {
    try {
      const response = await fetch(proxy.url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        signal: AbortSignal.timeout(18000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text || text.length < 50) throw new Error("Tomt eller ufuldstændigt svar.");
      return { text, proxyName: proxy.name };
    } catch (err) {
      errors.push(`${proxy.name}: ${err.message || "ukendt fejl"}`);
      console.warn(`Proxy ${proxy.name} fejlede`, err);
    }
  }
  throw new Error("Kunne ikke hente indholdet. " + errors.join(" · "));
}

function parseTabArticles(tabEl) {
  const items = [];
  if (!tabEl) return items;
  tabEl.querySelectorAll("article").forEach((art) => {
    const link = art.querySelector("h4 a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href) return;
    let fullUrl;
    try {
      fullUrl = new URL(href, BASE).href;
    } catch {
      return;
    }
    const title = link.textContent.trim();
    const timeEl = art.querySelector("time");
    const time = timeEl ? timeEl.textContent.trim() : "";
    const imgEl = art.querySelector("img");
    let imgSrc = "";
    if (imgEl) {
      const raw = imgEl.getAttribute("src") || imgEl.getAttribute("data-src") || "";
      try {
        imgSrc = new URL(raw, BASE).href;
      } catch {
        imgSrc = "";
      }
    }
    items.push({ title, url: fullUrl, time, img: imgSrc });
  });
  return items;
}

function parseFrontpageTabs(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tabs = doc.querySelectorAll("div.tabs > div.tab");
  return {
    seneste: parseTabArticles(tabs[0]),
    mestLaeste: parseTabArticles(tabs[1]),
  };
}

function formatApiDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "nu";
    if (mins < 60) return mins + " min. siden";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + " timer siden";
    const days = Math.floor(hours / 24);
    if (days === 1) return "1 dag siden";
    if (days < 7) return days + " dage siden";
    return d.toLocaleDateString("da-DK", {
      day: "numeric",
      month: "short",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  } catch {
    return "";
  }
}

function mapApiArticle(item) {
  let url = item.published_url || "";
  if (url && !url.startsWith("http")) {
    url = BASE + (url.startsWith("/") ? url : "/" + url);
  }
  let img = "";
  if (item.frontCropUrl) {
    img = IMAGE_BASE + item.frontCropUrl;
  } else if (item.image) {
    img = `${IMAGE_BASE}?imageId=${item.image}&width=120&height=120`;
  }
  return {
    title: item.title || item.teaserTitle || "Uden titel",
    url,
    time: formatApiDate(item.published),
    img,
  };
}

function createListItem(item) {
  const a = document.createElement("a");
  a.className = "latest-item";
  a.href = item.url || "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (!item.url) return;
    queryInput.value = item.url;
    loadArticle(item.url);
  });

  if (item.img) {
    const img = document.createElement("img");
    img.className = "latest-thumb";
    img.src = item.img;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove();
    a.appendChild(img);
  }

  const text = document.createElement("div");
  text.className = "latest-text";

  const title = document.createElement("div");
  title.className = "latest-title";
  title.textContent = item.title;
  text.appendChild(title);

  if (item.time) {
    const time = document.createElement("div");
    time.className = "latest-time";
    time.textContent = item.time;
    text.appendChild(time);
  }

  a.appendChild(text);
  return a;
}

function renderItemList(container, items) {
  const list = document.createElement("div");
  list.className = "latest-list";
  items.forEach((item) => list.appendChild(createListItem(item)));
  container.appendChild(list);
}

function renderTabsView() {
  articleEl.replaceChildren();

  const tabsBar = document.createElement("div");
  tabsBar.className = "tabs-bar";
  tabsBar.setAttribute("role", "tablist");

  const makeTab = (id, label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn" + (activeTab === id ? " active" : "");
    btn.textContent = label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", activeTab === id ? "true" : "false");
    btn.addEventListener("click", () => {
      if (activeTab === id) return;
      activeTab = id;
      renderTabsView();
    });
    return btn;
  };

  tabsBar.appendChild(makeTab("seneste", "Seneste"));
  tabsBar.appendChild(makeTab("mestLaeste", "Mest læste"));
  articleEl.appendChild(tabsBar);

  const items = activeTab === "seneste" ? cachedTabs.seneste : cachedTabs.mestLaeste;

  if (!items.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Ingen artikler fundet.";
    articleEl.appendChild(p);
    return;
  }

  renderItemList(articleEl, items);
}

function renderSearchResults({ append = false } = {}) {
  if (!append) {
    articleEl.replaceChildren();

    const header = document.createElement("div");
    header.className = "list-header";
    header.textContent =
      searchState.total > 0
        ? `Søgeresultater for “${searchState.query}” (${searchState.total})`
        : `Søgeresultater for “${searchState.query}”`;
    articleEl.appendChild(header);

    if (!searchState.items.length) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "Ingen artikler fundet.";
      articleEl.appendChild(p);
      return;
    }

    renderItemList(articleEl, searchState.items);
  } else {
    const list = articleEl.querySelector(".latest-list");
    if (list) {
      searchState.items.slice(searchState.start).forEach((item) => {
        list.appendChild(createListItem(item));
      });
    }
  }

  articleEl.querySelector(".load-more-wrap")?.remove();

  if (searchState.items.length < searchState.total) {
    const wrap = document.createElement("div");
    wrap.className = "load-more-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "Vis flere";
    btn.addEventListener("click", () => loadMoreSearch());
    wrap.appendChild(btn);
    articleEl.appendChild(wrap);
  }
}

async function loadLatest({ pushHistory = true } = {}) {
  statusEl.className = "";
  statusEl.textContent = "";
  queryInput.value = "";
  searchState = { query: "", start: 0, total: 0, items: [] };
  activeTab = "seneste";

  articleEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "placeholder";
  loading.textContent = "Indlæser seneste artikler…";
  articleEl.appendChild(loading);

  try {
    const { text } = await fetchThroughProxy(BASE + "/");
    cachedTabs = parseFrontpageTabs(text);
    renderTabsView();
    document.title = "Folketidende";

    if (pushHistory) {
      history.pushState({ view: "list" }, "", "");
    } else {
      history.replaceState({ view: "list" }, "", "");
    }
  } catch (err) {
    articleEl.replaceChildren();
    const message = document.createElement("p");
    message.className = "placeholder";
    message.textContent =
      "Kunne ikke hente seneste artikler. " + (err.message || "");
    articleEl.appendChild(message);
  }
}

async function runSearch(query, { reset = true, pushHistory = true } = {}) {
  query = (query || "").trim();
  if (!query) {
    statusEl.className = "error";
    statusEl.textContent = "Skriv noget at søge efter.";
    return;
  }

  if (reset) {
    searchState = { query, start: 0, total: 0, items: [] };
  }

  goButton.disabled = true;
  statusEl.className = "";
  statusEl.textContent = "Søger…";

  if (reset) {
    articleEl.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "placeholder";
    loading.textContent = "Søger…";
    articleEl.appendChild(loading);
  }

  try {
    const q = encodeURIComponent(`${query} AND lab_site_id:(2)`);
    const apiUrl = `${API_BASE}?limit=20&start=${searchState.start}&query=${q}&altText=1&orderBy=published`;
    const { text } = await fetchThroughProxy(apiUrl);
    const data = JSON.parse(text);
    const mapped = (data.result || []).map(mapApiArticle).filter((i) => i.url);

    if (reset) {
      searchState.items = mapped;
    } else {
      searchState.items = searchState.items.concat(mapped);
    }
    searchState.total = data.totalCount || searchState.items.length;

    renderSearchResults({ append: !reset });
    statusEl.textContent = "";
    document.title = `Søg: ${query} – Folketidende`;

    if (pushHistory && reset) {
      history.pushState({ view: "search", query: searchState.query }, "", "");
    }
  } catch (err) {
    if (reset) {
      articleEl.replaceChildren();
      const message = document.createElement("p");
      message.className = "placeholder";
      message.textContent = err.message || "Søgning mislykkedes.";
      articleEl.appendChild(message);
    }
    statusEl.className = "error";
    statusEl.textContent = "Søgning mislykkedes";
  } finally {
    goButton.disabled = false;
  }
}

async function loadMoreSearch() {
  searchState.start = searchState.items.length;
  const btn = articleEl.querySelector(".load-more-wrap button");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Henter…";
  }
  await runSearch(searchState.query, { reset: false, pushHistory: false });
}

function interceptInternalLinks(root) {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (isFolketidendeUrl(href)) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const full = new URL(href, window.__articleBase || BASE).href;
        queryInput.value = full;
        loadArticle(full);
      });
    }
  });
}

function renderArticle(doc, articleUrl) {
  const title =
    doc.querySelector(".articleHeader h1") ||
    doc.querySelector("article h1") ||
    doc.querySelector("main h1") ||
    doc.querySelector("h1");

  const body =
    doc.querySelector(".bodytext.content-text") ||
    doc.querySelector(".bodytext") ||
    doc.querySelector("article .article-body") ||
    doc.querySelector(".article-body") ||
    doc.querySelector("[itemprop='articleBody']");

  if (!title || !body || body.textContent.trim().length < 80) {
    throw new Error("Artikelindholdet blev ikke fundet.");
  }

  articleEl.replaceChildren();

  const heading = document.createElement("h1");
  heading.textContent = title.textContent.trim();
  articleEl.appendChild(heading);

  const subtitleSource = doc.querySelector(".articleHeader .subtitle");
  if (subtitleSource && subtitleSource.textContent.trim()) {
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = subtitleSource.textContent.trim();
    articleEl.appendChild(subtitle);
  }

  const author = doc
    .querySelector('.articleHeader .bylines [itemprop="name"]')
    ?.textContent.trim();
  const date = doc.querySelector(".articleHeader time")?.textContent.trim();
  if (author || date) {
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [author, date].filter(Boolean).join(" · ");
    articleEl.appendChild(meta);
  }

  const heroImg = doc.querySelector(".articleHeader .headerImage img");
  const heroCaption = doc.querySelector(".articleHeader .caption figcaption");
  if (heroImg) {
    const figure = document.createElement("figure");
    figure.className = "hero";
    const img = document.createElement("img");
    const rawSrc =
      heroImg.getAttribute("src") || heroImg.getAttribute("data-src");
    if (rawSrc) {
      try {
        img.src = new URL(rawSrc, articleUrl).href;
      } catch {}
    }
    img.alt = heroImg.getAttribute("alt") || "";
    img.loading = "lazy";
    figure.appendChild(img);
    if (heroCaption && heroCaption.textContent.trim()) {
      const cap = document.createElement("figcaption");
      cap.className = "caption";
      cap.textContent = heroCaption.textContent.trim();
      figure.appendChild(cap);
    }
    articleEl.appendChild(figure);
  }

  const bodyCopy = body.cloneNode(true);
  window.__articleBase = articleUrl;
  removeUnsafeContent(bodyCopy);

  bodyCopy
    .querySelectorAll(
      ".articleHeader, .headerImage, h1, .bylines, .kicker, " +
        "[class*='article-header'], [class*='story-header']"
    )
    .forEach((el) => el.remove());

  bodyCopy
    .querySelectorAll(
      ".google-ad, .column.google-ad, [class*='advert'], .ad, .annonce"
    )
    .forEach((el) => el.remove());

  bodyCopy.classList.add("bodytext");
  articleEl.appendChild(bodyCopy);
  interceptInternalLinks(bodyCopy);
}

async function loadArticle(urlOverride, { pushHistory = true } = {}) {
  let articleUrl;
  try {
    articleUrl = normalizeArticleUrl(urlOverride || queryInput.value);
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = err.message;
    return;
  }

  goButton.disabled = true;
  statusEl.className = "";
  statusEl.textContent = "Henter…";
  articleEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "placeholder";
  loading.textContent = "Henter artikel…";
  articleEl.appendChild(loading);

  try {
    const { text } = await fetchThroughProxy(articleUrl);
    const doc = new DOMParser().parseFromString(text, "text/html");
    renderArticle(doc, articleUrl);
    statusEl.className = "";
    statusEl.textContent = "";
    queryInput.value = articleUrl;

    const titleText =
      articleEl.querySelector("h1")?.textContent?.trim() || "Artikel";
    document.title = titleText + " – Folketidende";

    if (pushHistory) {
      history.pushState({ view: "article", url: articleUrl }, "", "");
    }
  } catch (err) {
    articleEl.replaceChildren();
    const message = document.createElement("p");
    message.className = "placeholder";
    message.textContent = err.message || "Ukendt fejl.";
    articleEl.appendChild(message);
    statusEl.className = "error";
    statusEl.textContent = "Mislykkedes";
  } finally {
    goButton.disabled = false;
  }
}

function handleGo(event) {
  if (event) event.preventDefault();
  const value = queryInput.value.trim();
  if (!value) {
    statusEl.className = "error";
    statusEl.textContent = "Skriv en søgning eller indsæt et link.";
    return;
  }
  if (looksLikeFolketidendeUrl(value)) {
    loadArticle(value);
  } else {
    runSearch(value, { reset: true, pushHistory: true });
  }
}

window.addEventListener("popstate", (event) => {
  const state = event.state;
  if (!state || state.view === "list") {
    loadLatest({ pushHistory: false });
  } else if (state.view === "search" && state.query) {
    queryInput.value = state.query;
    runSearch(state.query, { reset: true, pushHistory: false });
  } else if (state.view === "article" && state.url) {
    queryInput.value = state.url;
    loadArticle(state.url, { pushHistory: false });
  } else {
    loadLatest({ pushHistory: false });
  }
});

searchForm.addEventListener("submit", handleGo);

homeLink.addEventListener("click", (e) => {
  e.preventDefault();
  statusEl.textContent = "";
  statusEl.className = "";
  loadLatest({ pushHistory: true });
});

loadLatest({ pushHistory: false });
