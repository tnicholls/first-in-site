/* First In - the only script on the site.
   Pins the header and gives it a solid background once you scroll.
   Everything works without it: the header then just scrolls away. */
(function () {
  var root = document.documentElement;
  var header = document.querySelector(".site-header");
  if (!header) return;

  root.classList.add("js");

  var queued = false;
  function update() {
    queued = false;
    header.classList.toggle("is-solid", window.scrollY > 24);
  }

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
})();
