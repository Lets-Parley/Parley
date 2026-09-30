(function () {
  "use strict";
  var root = document.getElementById("root");
  window.parley.onState(function (session) {
    var s = (session && session.state) || {};
    root.textContent = s.greeting || "Hello";
  });
  window.parley.ready();
})();
