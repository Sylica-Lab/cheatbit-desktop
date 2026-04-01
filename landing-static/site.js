const localRouteMap = {
  "/blogs/": "blogs/index.html",
  "/blog/": "blog/index.html",
  "/research/": "research/index.html",
  "/changelog/": "changelog/index.html",
  "/security/": "security/index.html",
  "/privacy/": "privacy/index.html",
  "/terms/": "terms/index.html",
};

const localHomeAnchors = new Set([
  "/#home",
  "/#about",
  "/#features",
  "/#pricing",
  "/#download",
  "/#benefits",
  "/#workflow",
]);

if (window.location.protocol === "file:") {
  const path = window.location.pathname.replace(/\\/g, "/");
  const isNestedIndexPage = /\/(blog|blogs|research|privacy|security|terms|changelog)\/index\.html$/i.test(path);
  const prefix = isNestedIndexPage ? "../" : "./";

  document.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute("href");

    if (!href) {
      return;
    }

    if (href in localRouteMap) {
      link.setAttribute("href", `${prefix}${localRouteMap[href]}`);
      return;
    }

    if (localHomeAnchors.has(href)) {
      link.setAttribute("href", `${prefix}index.html${href.slice(1)}`);
    }
  });
}

const toggle = document.querySelector("[data-menu-toggle]");
const nav = document.querySelector("[data-site-nav]");

if (toggle && nav) {
  toggle.addEventListener("click", () => {
    const isOpen = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!isOpen));
    nav.classList.toggle("is-open", !isOpen);
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      toggle.setAttribute("aria-expanded", "false");
      nav.classList.remove("is-open");
    });
  });
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const revealNodes = document.querySelectorAll(".reveal");

if (!prefersReducedMotion.matches && revealNodes.length > 0 && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.18,
      rootMargin: "0px 0px -8% 0px",
    }
  );

  revealNodes.forEach((node) => observer.observe(node));
} else {
  revealNodes.forEach((node) => node.classList.add("is-visible"));
}
