/* First In - the only script on the site.
   1. Pins the header and gives it a solid background once you scroll.
   2. Fades sections and photos in as they scroll into view, like Squarespace's
      fade animation. They reset once well off screen, so they fade in again
      on the way back.
   Everything works without it: the header just scrolls away and nothing fades. */
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  /* ---- header ---- */
  var header = document.querySelector(".site-header");
  if (header) {
    var queued = false;
    var update = function () {
      queued = false;
      header.classList.toggle("is-solid", window.scrollY > 24);
    };
    window.addEventListener(
      "scroll",
      function () {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  /* ---- scroll fades ---- */
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;

  // [selector, style]
  var groups = [
    [".band__media", "photo"],
    [".band__text > *", "up"],
    [".editorial .display", "up"],
    [".editorial__rule", "line"],
    [".steps > li", "up"],
    [".editorial__note", "up"],
    [".collage .ph", "photo"],
    [".coords", "up"],
    [".divider", "up"],
    [".light__head > *", "up"],
    [".cards > .card", "up"],
    [".light__foot", "up"],
    [".credits > .display, .credits > p", "up"],
    [".credit", "up"]
  ];

  // Two observers, so an element's own fade offset (a slight zoom or slide) can
  // never push it back across the line it just crossed and make it flicker.
  // Show: once it's a little way up from the bottom of the screen. Things that
  // arrive together are staggered top to bottom, left to right.
  var show = new IntersectionObserver(
    function (entries) {
      var arriving = entries.filter(function (e) {
        return e.isIntersecting && !e.target.classList.contains("is-in");
      });
      arriving.sort(function (a, b) {
        return (
          a.boundingClientRect.top - b.boundingClientRect.top ||
          a.boundingClientRect.left - b.boundingClientRect.left
        );
      });
      arriving.forEach(function (e, n) {
        e.target.style.setProperty("--fade-delay", Math.min(n, 4) * 0.12 + "s");
        e.target.classList.add("is-in");
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0 }
  );

  // Hide: only once it's well off screen, so it can fade in again next time.
  var hide = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) e.target.classList.remove("is-in");
      });
    },
    { rootMargin: "15% 0px 15% 0px", threshold: 0 }
  );

  var vh = window.innerHeight;
  groups.forEach(function (group) {
    var els = document.querySelectorAll(group[0]);
    Array.prototype.forEach.call(els, function (el) {
      if (el.classList.contains("fade")) return;
      // anything already on screen when the page opens just shows, no flash
      var box = el.getBoundingClientRect();
      if (box.top < vh && box.bottom > 0) el.classList.add("is-in");
      el.classList.add("fade", "fade--" + group[1]);
      show.observe(el);
      hide.observe(el);
    });
  });
})();
