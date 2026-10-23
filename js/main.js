(function () {
  var btn = document.getElementById('menuBtn');
  var nav = document.getElementById('nav');
  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Close' : 'Menu';
  });
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Menu'; }
  });

  // Stagger the log lines (they start visible; this only adds a gentle sequence).
  var lines = document.querySelectorAll('#log .ln');
  lines.forEach(function (el, i) { el.style.animationDelay = (i * 0.09) + 's'; });

  // The copy button and contact form only exist on the home page.
  var copy = document.getElementById('copyEmail');
  if (copy) copy.addEventListener('click', function () {
    var text = document.getElementById('email').textContent;
    function selectIt() {
      var r = document.createRange(); r.selectNodeContents(document.getElementById('email'));
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      copy.textContent = 'Selected';
    }
    try {
      navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; }, selectIt);
    } catch (e) { selectIt(); }
    setTimeout(function () { copy.textContent = 'Copy'; }, 1800);
  });

  var form = document.getElementById('contactForm');
  var msg = document.getElementById('formMsg');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('f-name');
    var email = document.getElementById('f-email');
    msg.hidden = false;
    if (!name.value.trim() || !email.value.trim() || !email.checkValidity()) {
      msg.style.color = 'var(--fail)'; msg.style.borderColor = 'rgba(255,122,110,.4)';
      msg.textContent = 'Add your name and a valid work email, then try again.';
      return;
    }
    msg.style.color = ''; msg.style.borderColor = '';
    msg.textContent = 'Looks good. This is a preview form, so nothing was sent. Once it is connected to your inbox, messages will arrive there.';
  });
})();
