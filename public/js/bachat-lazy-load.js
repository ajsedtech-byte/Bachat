(function () {
  "use strict";

  var ready = false;
  var prioritySelector = '[loading="eager"], [fetchpriority="high"], [data-eager], [data-lazy="off"]';

  function isElement(value) {
    return value && value.nodeType === 1;
  }

  function isNearInitialViewport(element) {
    if (!ready || typeof element.getBoundingClientRect !== "function") return false;
    var rect = element.getBoundingClientRect();
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.top < viewportHeight * 1.15 && rect.bottom > -120;
  }

  function tuneImage(image) {
    if (!image || image.matches(prioritySelector)) return;
    if (!image.hasAttribute("decoding")) image.setAttribute("decoding", "async");
    if (!image.hasAttribute("loading")) {
      image.setAttribute("loading", isNearInitialViewport(image) ? "eager" : "lazy");
    }
  }

  function tuneFrame(frame) {
    if (!frame || frame.matches(prioritySelector)) return;
    if (!frame.hasAttribute("loading")) frame.setAttribute("loading", "lazy");
  }

  function scan(root) {
    if (!root) return;

    if (isElement(root)) {
      if (root.tagName === "IMG") tuneImage(root);
      if (root.tagName === "IFRAME") tuneFrame(root);
    }

    if (typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll("img").forEach(tuneImage);
    root.querySelectorAll("iframe").forEach(tuneFrame);
  }

  function observeNewMedia() {
    if (typeof MutationObserver !== "function") return;
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(scan);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    ready = true;
    scan(document);
    observeNewMedia();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    window.requestAnimationFrame(start);
  }
})();
