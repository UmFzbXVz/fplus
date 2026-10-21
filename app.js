const urlInput = document.getElementById("articleUrl");
const loadButton = document.getElementById("loadButton");
const statusEl = document.getElementById("status");
const articleEl = document.getElementById("article");
const homeLink = document.getElementById("homeLink");

const BASE = "https://www.folketidende.dk";

function validateArticleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Indsæt et gyldigt artikel-link.");
  }
  const allowedHosts = ["folketidende.dk", "www.folketidende.dk"];
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
    throw new Error("Linket skal være HTTPS og pege på folketidende.dk.");
  }
  return url.href;
}

function isFolketidendeUrl(href) {
  if (!href) return false;
  try {
    const u = new URL(href, BASE);
    return (
      (u.hostname === "folketidende.dk" || u.hostname === "www.folketidende.dk") &&
      u.protocol === "https:"
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
      const html = await response.text();
      if (!html || html.length < 500) throw new Error("Tomt eller ufuldstændigt svar.");
      return { html, proxyName: proxy.name };
    } catch (err) {
      errors.push(`${proxy.name}: ${err.message || "ukendt fejl"}`);
      console.warn(`Proxy ${proxy.name} fejlede`, err);
    }
  }
  throw new Error("Kunne ikke hente indholdet. " + errors.join(" · "));
}

function parseLatestArticles(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tab = doc.querySelector("div.tabs > div.tab");
  if (!tab) return [];

  const items = [];
  tab.querySelectorAll("article").forEach((art) => {
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

function renderLatestList(items) {
  articleEl.replaceChildren();

  const header = document.createElement("h2");
  header.className = "latest-header";
  header.textContent = "Seneste artikler";
  articleEl.appendChild(header);

  if (!items.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Kunne ikke hente seneste artikler.";
    articleEl.appendChild(p);
    return;
  }

  const list = document.createElement("div");
  list.className = "latest-list";

  items.forEach((item) => {
    const a = document.createElement("a");
    a.className = "latest-item";
    a.href = item.url;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      urlInput.value = item.url;
      loadArticle(item.url);
    });

    if (item.img) {
      const img = document.createElement("img");
      img.className = "latest-thumb";
      img.src = item.img;
      img.alt = "";
      img.loading = "lazy";
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
    list.appendChild(a);
  });

  articleEl.appendChild(list);
}

function interceptInternalLinks(root) {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (isFolketidendeUrl(href)) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const full = new URL(href, window.__articleBase || BASE).href;
        urlInput.value = full;
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

  // Prefer pure body containers. Avoid falling back to <article>/<main>
  // which often include the header (title + hero) on non-plus pages.
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

  // Strip any leftover header/lead that some non-plus templates embed in the body
  bodyCopy
    .querySelectorAll(
      ".articleHeader, .headerImage, h1, .bylines, .kicker, " +
        "[class*='article-header'], [class*='story-header']"
    )
    .forEach((el) => el.remove());

  // Remove leading empty elements and pure ad blocks
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
    articleUrl = validateArticleUrl(
      (urlOverride || urlInput.value).trim()
    );
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = err.message;
    return;
  }

  loadButton.disabled = true;
  statusEl.className = "";
  statusEl.textContent = "Henter…";
  articleEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "placeholder";
  loading.textContent = "Henter artikel…";
  articleEl.appendChild(loading);

  try {
    const { html } = await fetchThroughProxy(articleUrl);
    const doc = new DOMParser().parseFromString(html, "text/html");
    renderArticle(doc, articleUrl);
    statusEl.className = "";
    statusEl.textContent = "";
    urlInput.value = articleUrl;

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
    loadButton.disabled = false;
  }
}

async function loadLatest({ pushHistory = true } = {}) {
  statusEl.className = "";
  statusEl.textContent = "";
  urlInput.value = "";
  articleEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "placeholder";
  loading.textContent = "Indlæser seneste artikler…";
  articleEl.appendChild(loading);

  try {
    const { html } = await fetchThroughProxy(BASE + "/");
    const items = parseLatestArticles(html);
    renderLatestList(items);
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

// History navigation (browser / phone back & forward)
window.addEventListener("popstate", (event) => {
  const state = event.state;
  if (!state || state.view === "list") {
    loadLatest({ pushHistory: false });
  } else if (state.view === "article" && state.url) {
    urlInput.value = state.url;
    loadArticle(state.url, { pushHistory: false });
  } else {
    loadLatest({ pushHistory: false });
  }
});

loadButton.addEventListener("click", () => loadArticle());
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadArticle();
});
homeLink.addEventListener("click", (e) => {
  e.preventDefault();
  statusEl.textContent = "";
  statusEl.className = "";
  loadLatest({ pushHistory: true });
});

// Initial load – replaceState so the first entry is the list
loadLatest({ pushHistory: false });
