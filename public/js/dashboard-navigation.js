(function initializeDashboardNavigation() {
  const main = document.querySelector("main, .dashboard");
  const links = [...document.querySelectorAll("[data-dashboard-link]")];
  if (!main || !links.length) return;

  const currentPath = window.location.pathname.replace(/\/$/, "") || "/";
  const activeLink = links.find((link) => new URL(link.href, window.location.origin).pathname.replace(/\/$/, "") === currentPath);
  if (!activeLink) return;

  links.forEach((link) => link.classList.toggle("active", link === activeLink));
  if (activeLink.dataset.dashboardHome === "true") {
    main.hidden = false;
    [...main.children].forEach((child) => {
      child.hidden = false;
    });
    return;
  }

  const targets = activeLink.dataset.dashboardTarget
    .split(",")
    .map((id) => document.querySelector(`#${id.trim()}`))
    .filter(Boolean);
  if (!targets.length) return;

  main.hidden = false;
  [...main.children].forEach((child) => {
    if (!child.matches("header, .topbar, .dashboard-header")) child.hidden = true;
  });

  const visibleTopLevel = new Set();
  targets.forEach((target) => {
    let node = target;
    while (node.parentElement && node.parentElement !== main) {
      node = node.parentElement;
    }
    visibleTopLevel.add(node);
  });

  [...main.children].forEach((child) => {
    if (child.matches("header, .topbar, .dashboard-header")) {
      child.hidden = false;
    } else {
      child.hidden = !visibleTopLevel.has(child);
    }
  });

  targets.forEach((target) => {
    target.hidden = false;
  });
  main.hidden = false;
})();
