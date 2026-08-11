(function () {
  try {
    if (localStorage.getItem("chatwire_theme") === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) {}
})();
