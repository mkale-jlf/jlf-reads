import { loadRecommendations } from "./recommendations-data.js";
import { MEDIA_TYPES } from "./data.js";
import { resolveCover } from "./covers.js";

const TYPE_LABELS = { book: "Book", movie: "Film", article: "Article", podcast: "Podcast" };
const FILTER_LABELS = { all: "All", book: "Books", movie: "Films", article: "Articles", podcast: "Podcasts" };
const FILTER_ORDER = ["all", ...MEDIA_TYPES];

const grid = document.getElementById("grid");
const filtersNav = document.getElementById("filters");

const FADE_OUT_MS = 450;

let recommendations = [];
let activeFilter = "all";
let fadeTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function externalLink(href) {
  const link = el("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function buildLead(rec) {
  const label =
    rec.mediaType === "article" || rec.mediaType === "podcast"
      ? rec.source || rec.title
      : rec.title;
  const p = el("p", "lead");
  const em = el("em", null, label);
  if (isHttpUrl(rec.url)) {
    const link = externalLink(rec.url);
    link.append(em);
    p.append(link);
  } else {
    p.append(em);
  }
  return p;
}

function buildBlurb(rec) {
  if (!rec.blurb && !isHttpUrl(rec.url)) return null;
  const p = el("p", "blurb");
  if (rec.blurb) p.append(rec.blurb);
  if (isHttpUrl(rec.url)) {
    if (rec.blurb) p.append(" ");
    const more = externalLink(rec.url);
    more.className = "more";
    more.setAttribute("aria-label", `Read more about ${rec.title}`);
    more.append("more\u00A0\u00BB");
    p.append(more);
  }
  return p;
}

function buildVisualTile(rec) {
  const tile = el("figure", "tile tile--visual");
  const linked = isHttpUrl(rec.url);
  const frame = el(linked ? "a" : "div", "frame");
  if (linked) {
    frame.href = rec.url;
    frame.target = "_blank";
    frame.rel = "noopener noreferrer";
    frame.setAttribute("aria-label", `${rec.title} — opens in a new tab`);
  }
  const fallback = el("div", "fallback");
  fallback.append(el("span", "fb-kind", TYPE_LABELS[rec.mediaType]), el("span", "fb-title", rec.title));
  frame.append(fallback);

  const caption = el("figcaption");
  caption.append(buildLead(rec));
  const blurb = buildBlurb(rec);
  if (blurb) caption.append(blurb);

  tile.append(frame, caption);
  return tile;
}

function buildTextTile(rec) {
  const tile = el("article", "tile tile--text");
  tile.append(buildLead(rec));
  const blurb = buildBlurb(rec);
  if (blurb) tile.append(blurb);
  return tile;
}

async function hydrateCover(tile, rec) {
  const frame = tile.querySelector(".frame");
  const url = await resolveCover(rec);
  if (!url || !frame || !frame.isConnected) return;
  const img = new Image();
  img.alt = `${TYPE_LABELS[rec.mediaType]} artwork for ${rec.title}`;
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return;
  }
  if (frame.isConnected) frame.replaceChildren(img);
}

function boardMetrics() {
  const rootStyle = getComputedStyle(document.documentElement);
  const gapX = parseFloat(rootStyle.getPropertyValue("--gap-x")) || 0;
  const gapY = parseFloat(rootStyle.getPropertyValue("--gap-y")) || 0;
  const cardW = parseFloat(rootStyle.getPropertyValue("--card-w")) || 347;
  const parent = grid.parentElement;
  const parentStyle = getComputedStyle(parent);
  const avail =
    parent.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight);
  let cols = Math.floor((avail + gapX) / (cardW + gapX));
  if (cols < 1) cols = 1;
  return { cardW: Math.min(cardW, avail), gapX, gapY, cols };
}

function layoutBoard() {
  const tiles = [...grid.children].filter((node) => node.classList && node.classList.contains("tile"));
  if (!tiles.length) {
    grid.style.width = "";
    grid.style.height = "";
    return;
  }
  const { cardW, gapX, gapY, cols } = boardMetrics();
  tiles.forEach((tile) => {
    tile.style.width = `${cardW}px`;
  });
  const columnHeights = new Array(cols).fill(0);
  tiles.forEach((tile) => {
    let column = 0;
    for (let i = 1; i < cols; i += 1) {
      if (columnHeights[i] < columnHeights[column]) column = i;
    }
    const x = column * (cardW + gapX);
    const y = columnHeights[column];
    tile.style.left = `${x}px`;
    tile.style.top = `${y}px`;
    columnHeights[column] = y + tile.offsetHeight + gapY;
  });
  grid.style.width = `${cols * cardW + (cols - 1) * gapX}px`;
  grid.style.height = `${Math.max(...columnHeights) - gapY}px`;
}

let resizeTimer = null;

function scheduleLayout() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutBoard, 120);
}

function render({ animate = true } = {}) {
  const build = () => {
    const list =
      activeFilter === "all"
        ? recommendations
        : recommendations.filter((rec) => rec.mediaType === activeFilter);
    const ordered = [...list.filter((rec) => !rec.sink), ...list.filter((rec) => rec.sink)];
    grid.replaceChildren();
    if (!ordered.length) {
      grid.append(el("p", "notice", "Nothing here yet."));
      return;
    }
    ordered.forEach((rec, i) => {
      const visual = rec.mediaType === "book" || rec.mediaType === "movie";
      const tile = visual ? buildVisualTile(rec) : buildTextTile(rec);
      tile.style.setProperty("--stagger", Math.min(i, 10));
      grid.append(tile);
      if (visual) hydrateCover(tile, rec);
    });
    layoutBoard();
    grid.classList.remove("is-fading");
  };

  if (!animate) {
    build();
    return;
  }
  clearTimeout(fadeTimer);
  grid.classList.add("is-fading");
  fadeTimer = setTimeout(build, FADE_OUT_MS);
}

function renderFilters() {
  filtersNav.replaceChildren();
  for (const id of FILTER_ORDER) {
    const count =
      id === "all"
        ? recommendations.length
        : recommendations.filter((rec) => rec.mediaType === id).length;
    const button = el("button", "filter-button");
    button.type = "button";
    button.dataset.filter = id;
    button.setAttribute("aria-pressed", String(id === activeFilter));
    button.append(el("span", "filter-label", FILTER_LABELS[id]), el("span", "filter-count", String(count)));
    button.addEventListener("click", () => {
      if (id === activeFilter) return;
      activeFilter = id;
      renderFilters();
      render();
    });
    filtersNav.append(button);
  }
}

function showError(message) {
  grid.replaceChildren();
  const notice = el("section", "notice");
  notice.append(
    el("h2", null, "Recommendations unavailable"),
    el("p", null, message),
    el(
      "p",
      "fine",
      "If you opened index.html directly from disk, serve the folder instead: python3 -m http.server 8000, then visit http://localhost:8000."
    )
  );
  grid.append(notice);
}

function initChrome() {
  const dateLine = document.getElementById("dateline-date");
  if (dateLine) {
    dateLine.textContent = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date());
  }
  const year = document.getElementById("colophon-year");
  if (year) year.textContent = String(new Date().getFullYear());
}

initChrome();
window.addEventListener("resize", scheduleLayout);
if (document.fonts) {
  document.fonts.ready.then(layoutBoard);
  document.fonts.addEventListener("loadingdone", layoutBoard);
}
loadRecommendations()
  .then((data) => {
    recommendations = data;
    renderFilters();
    render({ animate: false });
  })
  .catch((error) => {
    console.error(error);
    showError(error.message);
  });
