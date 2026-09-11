/* Project page script: nav highlight, figure lightbox, copy BibTeX. No dependencies. */
(function () {
  "use strict";

  /* ---- Nav highlight: mark the section currently in view ---- */
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav a[href^='#']"));
  var sections = links.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); }).filter(Boolean);
  function setCurrent(id) {
    links.forEach(function (a) {
      if (a.getAttribute("href") === "#" + id) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }
  if ("IntersectionObserver" in window && sections.length) {
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
      var best = null, bestRatio = 0;
      sections.forEach(function (s) { if ((visible[s.id] || 0) > bestRatio) { bestRatio = visible[s.id]; best = s.id; } });
      if (best) setCurrent(best);
    }, { rootMargin: "-40% 0px -50% 0px", threshold: [0, 0.1, 0.5, 1] });
    sections.forEach(function (s) { io.observe(s); });
  }

  /* ---- Lightbox ---- */
  var lb = document.getElementById("lightbox");
  if (lb) {
    var lbImg = lb.querySelector("img");
    var lbCap = lb.querySelector(".lb-cap");
    var closeBtn = lb.querySelector(".lb-close");
    var prevBtn = lb.querySelector(".lb-prev");
    var nextBtn = lb.querySelector(".lb-next");
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-lightbox]"));
    var index = -1, lastFocus = null;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function show(i) {
      index = (i + items.length) % items.length;
      var el = items[index];
      lbImg.src = el.getAttribute("href");
      lbImg.alt = el.getAttribute("data-alt") || "";
      lbCap.textContent = el.getAttribute("data-caption") || "";
    }
    function open(i) {
      lastFocus = document.activeElement;
      show(i);
      lb.classList.add("open");
      lb.setAttribute("aria-hidden", "false");
      document.body.classList.add("lb-open");
      requestAnimationFrame(function () { lb.classList.add("visible"); });
      closeBtn.focus();
    }
    function close() {
      lb.classList.remove("visible");
      var done = function () {
        lb.classList.remove("open");
        lb.setAttribute("aria-hidden", "true");
        document.body.classList.remove("lb-open");
        lbImg.removeAttribute("src");
        if (lastFocus && lastFocus.focus) lastFocus.focus();
      };
      if (reduce) done(); else setTimeout(done, 200);
    }
    items.forEach(function (el, i) {
      el.addEventListener("click", function (ev) { ev.preventDefault(); open(i); });
    });
    closeBtn.addEventListener("click", close);
    prevBtn.addEventListener("click", function () { show(index - 1); });
    nextBtn.addEventListener("click", function () { show(index + 1); });
    lb.addEventListener("click", function (ev) { if (ev.target === lb || ev.target.classList.contains("lb-body")) close(); });
    document.addEventListener("keydown", function (ev) {
      if (!lb.classList.contains("open")) return;
      if (ev.key === "Escape") { ev.preventDefault(); close(); }
      else if (ev.key === "ArrowRight") { show(index + 1); }
      else if (ev.key === "ArrowLeft") { show(index - 1); }
      else if (ev.key === "Tab") {
        /* keep focus inside the dialog */
        var focusable = [closeBtn, prevBtn, nextBtn];
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    });
  }

  /* ---- Copy BibTeX ---- */
  var copyBtn = document.getElementById("copy-bibtex");
  var bib = document.getElementById("bibtex");
  var copied = document.getElementById("copied-note");
  if (copyBtn && bib) {
    copyBtn.addEventListener("click", function () {
      var text = bib.textContent;
      var ok = function () {
        if (copied) { copied.hidden = false; setTimeout(function () { copied.hidden = true; }, 2500); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, function () { fallback(); });
      } else { fallback(); }
      function fallback() {
        var range = document.createRange(); range.selectNodeContents(bib);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        try { document.execCommand("copy"); ok(); } catch (e) { /* leave the text selected for manual copy */ }
      }
    });
  }
})();
