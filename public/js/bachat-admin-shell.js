/**
 * Shared admin / ops dashboard chrome (sidebar + top header).
 * Set <body data-bachat-admin="analytics"> (etc.) before including this script.
 * Requires elements: [data-bachat-sidebar], [data-bachat-topbar]
 */
(function () {
  var active = (document.body && document.body.getAttribute("data-bachat-admin")) || "analytics";

  var me = {};
  try {
    me = JSON.parse(localStorage.getItem("ajs_user") || "{}");
  } catch (e) {
    me = {};
  }
  var isSales = me.role === "sales";

  var rawItems = [
    { id: "dashboard", label: "Dashboard", href: "/AdminDashboard.html", icon: "M4 6h16M4 12h16M4 18h7" },
    { id: "analytics", label: "Analytics", href: "/admin-analytics.html", icon: "M11 3v18M6 8l5-5 5 5M17 16l-5 5-5-5" },
    { id: "requests", label: "Requests", href: "/admin-requests.html", icon: "M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
    { id: "orders", label: "Orders", href: "/admin-orders.html", icon: "M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" },
    { id: "sellers", label: "Sellers", href: "/admin-sellers.html", icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" },
    { id: "users", label: "Users", href: "/admin-users.html", icon: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" },
    { id: "payments", label: "Payments", href: "/admin-finance.html", icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" },
    { id: "disputes", label: "Disputes", href: "/admin-disputes.html", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
    { id: "support", label: "Support", href: "/admin-support.html", icon: "M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" },
    { id: "notifications", label: "Alerts", href: "/admin-notifications.html", icon: "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" },
    { id: "delivery", label: "Delivery", href: "/admin-delivery.html", icon: "M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" },
    { id: "marketing", label: "Growth", href: "/admin-marketing.html", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" },
    { id: "category", label: "Categories", href: "/admin-category.html", icon: "M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" },
    { id: "sales", label: "Field Sales", href: "/admin-sales.html", icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z" },
    { id: "reports", label: "Reports", href: "/admin-analytics.html", icon: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { id: "settings", label: "Settings", href: "#", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
  ];

  var items = isSales
    ? [
        {
          id: "sales",
          label: "Field sales & leads",
          href: "/admin-sales.html",
          icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z",
        },
      ]
    : rawItems;

  function iconSvg(d) {
    return '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' + d + '"/></svg>';
  }

  var sb = document.querySelector("[data-bachat-sidebar]");
  if (sb) {
    var navHtml =
      '<div class="flex flex-col h-full">' +
      '<a href="/" class="flex flex-col items-start gap-1 px-4 py-5 border-b border-slate-100">' +
      '<img src="/assets/bachat-logo.svg" alt="" class="h-10 w-auto max-w-[140px] object-contain object-left" />' +
      "</a>" +
      '<nav class="flex-1 overflow-y-auto py-4 px-3 space-y-0.5 text-sm font-semibold text-slate-600">';
    items.forEach(function (it) {
      var on = it.id === active;
      navHtml +=
        '<a href="' +
        it.href +
        '" class="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ' +
        (on ? "bg-[#e8f1fc] text-[#0056d2] border-l-4 border-[#0056d2]" : "border-l-4 border-transparent hover:bg-slate-50") +
        '">' +
        iconSvg(it.icon) +
        "<span>" +
        it.label +
        "</span></a>";
    });
    navHtml +=
      "</nav>" +
      '<div class="p-4 border-t border-slate-100">' +
      '<div class="rounded-xl bg-gradient-to-br from-[#0056d2] to-[#0044a8] text-white p-4 shadow-lg">' +
      '<p class="text-xs font-bold opacity-90">Need Help?</p>' +
      '<p class="text-[11px] mt-1 opacity-85">Internal support available 24/7</p>' +
      '<button type="button" class="mt-3 w-full py-2 rounded-lg bg-white text-[#0056d2] text-xs font-bold">Contact IT Team</button>' +
      "</div>" +
      '<div class="flex items-center gap-3 mt-4 px-1">' +
      '<div class="w-9 h-9 rounded-full bg-slate-200 shrink-0"></div>' +
      '<div class="min-w-0">' +
      '<p class="text-sm font-bold text-slate-900 truncate">Arjun Singh</p>' +
      '<p class="text-[11px] text-slate-500">Support Agent</p>' +
      "</div></div></div></div>";
    sb.innerHTML = navHtml;
  }

  var tb = document.querySelector("[data-bachat-topbar]");
  if (tb) {
    tb.innerHTML =
      '<div class="flex flex-wrap items-center gap-3 flex-1 min-w-0">' +
      '<div class="relative flex-1 min-w-[200px] max-w-xl">' +
      '<span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">' +
      iconSvg("M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z") +
      "</span>" +
      '<input type="search" placeholder="Search tickets, orders, users…" class="w-full pl-10 pr-16 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm outline-none focus:ring-2 focus:ring-[#0056d2]/25 focus:border-[#0056d2]" />' +
      '<kbd class="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 bg-white hidden sm:inline">⌘ K</kbd>' +
      "</div>" +
      "</div>" +
      '<div class="flex items-center gap-2 sm:gap-4 shrink-0">' +
      '<button type="button" class="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50">' +
      iconSvg("M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z") +
      " Indore </button>" +
      '<button type="button" class="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50">' +
      iconSvg("M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z") +
      ' <span class="hidden md:inline">May 18 – May 24, 2026</span></button>' +
      '<button type="button" class="relative p-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50">' +
      iconSvg("M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9") +
      '<span class="absolute top-1 right-1 w-4 h-4 text-[10px] font-bold bg-red-500 text-white rounded-full flex items-center justify-center">8</span></button>' +
      '<div class="flex items-center gap-2 pl-2 border-l border-slate-200">' +
      '<div class="w-9 h-9 rounded-full bg-slate-200"></div>' +
      '<div class="hidden sm:block">' +
      '<p class="text-sm font-bold text-slate-900 leading-tight">Arjun Singh</p>' +
      '<p class="text-[11px] text-slate-500">Support Agent</p>' +
      "</div></div></div>";
  }
})();
