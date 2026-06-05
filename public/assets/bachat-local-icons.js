(function () {
  var SPRITE = "/assets/bachat-icons.svg#";

  function svgIcon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttribute("class", "bachat-ui-icon bachat-nav-icon");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", SPRITE + name);
    svg.appendChild(use);
    return svg;
  }

  function replaceLeadingSpan(el, iconName) {
    if (!el || !iconName) return;
    if (el.querySelector(":scope > svg.bachat-ui-icon")) return;
    var first = el.firstElementChild;
    if (!first || first.tagName.toLowerCase() !== "span") return;
    first.replaceWith(svgIcon(iconName));
  }

  function applyBuyerIcons() {
    var sectionIcons = {
      "shopping-home": "icon-home",
      "dashboard-home": "icon-dashboard",
      "requests-section": "icon-document",
      "orders-section": "icon-box",
      "payments-section": "icon-card",
      "saved-section": "icon-star",
      "address-section": "icon-map-pin",
      "browse-section": "icon-cart",
      "cart-section": "icon-basket",
      "refer-section": "icon-gift",
      "profile-strip": "icon-user",
    };
    document.querySelectorAll("#user-sidebar-nav > a[data-section]").forEach(function (link) {
      replaceLeadingSpan(link, sectionIcons[link.getAttribute("data-section")]);
    });
  }

  function applyShopkeeperIcons() {
    var navIcons = {
      home: "icon-dashboard",
      shop: "icon-store",
      live: "icon-radio",
      quotes: "icon-message",
      orders: "icon-box",
      payouts: "icon-card",
      me: "icon-user",
    };
    document.querySelectorAll("#sk-sidebar-nav > button[data-sk-nav]").forEach(function (button) {
      replaceLeadingSpan(button, navIcons[button.getAttribute("data-sk-nav")]);
    });
    var notif = document.querySelector("#notif-btn > span[aria-hidden='true']");
    if (notif) notif.replaceWith(svgIcon("icon-bell"));
  }

  function applyDeliveryIcons() {
    var title = document.querySelector("body > header p.text-xs");
    if (!title || title.querySelector("svg")) return;
    title.prepend(svgIcon("icon-truck"), " ");
  }

  function apply() {
    applyBuyerIcons();
    applyShopkeeperIcons();
    applyDeliveryIcons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
