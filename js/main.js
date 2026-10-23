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

  // Contact form: sent by FormSubmit (formsubmit.co) to the inbox below. The very first
  // message triggers a one-time activation email to that inbox; after that, messages arrive.
  var FORM_ENDPOINT = 'https://formsubmit.co/ajax/theanalyst.automation@gmail.com';
  var form = document.getElementById('contactForm');
  var msg = document.getElementById('formMsg');
  function showMsg(text, ok) {
    msg.hidden = false;
    msg.style.color = ok ? '' : 'var(--fail)';
    msg.style.borderColor = ok ? '' : 'rgba(255,122,110,.4)';
    msg.textContent = text;
  }
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('f-name');
    var email = document.getElementById('f-email');
    if (!name.value.trim() || !email.value.trim() || !email.checkValidity()) {
      showMsg('Add your name and a valid work email, then try again.', false);
      return;
    }
    if (form.elements._honey.value) return;   // filled in only by bots

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Sending…';
    fetch(FORM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        name: name.value.trim(),
        email: email.value.trim(),   // FormSubmit sets this as the reply-to address
        company: document.getElementById('f-company').value.trim(),
        need: document.getElementById('f-need').value,
        message: document.getElementById('f-msg').value.trim(),
        _subject: 'New enquiry from the AgentM website',
        _template: 'table'
      })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (String(data.success) === 'true') {
          form.reset();
          showMsg('Thanks, your message was sent. We will get back to you by email soon.', true);
        } else {
          showMsg(data.message || 'Your message could not be sent. Please email us at theanalyst.automation@gmail.com.', false);
        }
      })
      .catch(function () {
        showMsg('Your message could not be sent. Check your connection, or email us at theanalyst.automation@gmail.com.', false);
      })
      .then(function () { btn.disabled = false; btn.textContent = 'Send message'; });
  });
})();
