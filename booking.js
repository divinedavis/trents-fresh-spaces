// Trent's Fresh Spaces — booking widget
(function () {
  var root = document.getElementById('booking');
  if (!root) return;

  var API = ''; // same-origin /api
  var state = { service: null, services: [], date: '', slot: null, tz: 'America/New_York', meta: null };

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayISO() {
    var t = new Date();
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }
  function addDaysISO(days) {
    var t = new Date();
    t.setDate(t.getDate() + days);
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  function render() {
    root.innerHTML = '';
    var svcOpts = state.services
      .map(function (s) {
        return (
          '<button type="button" class="svc-option' +
          (state.service === s.id ? ' selected' : '') +
          '" data-svc="' + s.id + '">' +
          '<span class="svc-name">' + s.label + '</span>' +
          '<span class="svc-dur">' + s.durationMin + ' min' +
          (s.id === 'estimate' ? ' · at your home' : ' · over the phone') + '</span>' +
          '</button>'
        );
      })
      .join('');

    var wrap = el(
      '<div class="booking">' +
        '<div class="booking-step"><h3><span class="step-num">1</span>What do you need?</h3>' +
          '<div class="svc-options">' + svcOpts + '</div>' +
        '</div>' +
        '<div class="booking-step"><h3><span class="step-num">2</span>Pick a day &amp; time</h3>' +
          '<div class="book-date">' +
            '<label for="bk-date">Date</label>' +
            '<input type="date" id="bk-date" min="' + todayISO() + '" max="' + addDaysISO(state.meta ? state.meta.maxDaysAhead : 45) + '" value="' + state.date + '">' +
            '<span class="book-tz">Times shown in Eastern (ET)</span>' +
          '</div>' +
          '<div class="slots" id="bk-slots"></div>' +
          '<div class="slots-msg" id="bk-slots-msg">Choose a service and date to see open times.</div>' +
        '</div>' +
        '<div class="booking-step"><h3><span class="step-num">3</span>Your details</h3>' +
          '<div class="book-fields">' +
            '<div class="field"><label for="bk-name">Name</label><input id="bk-name" type="text" placeholder="Your name" autocomplete="name"></div>' +
            '<div class="field"><label for="bk-phone">Phone</label><input id="bk-phone" type="tel" placeholder="(555) 123-4567" autocomplete="tel"></div>' +
            '<div class="field"><label for="bk-email">Email</label><input id="bk-email" type="email" placeholder="you@email.com" autocomplete="email"></div>' +
            '<div class="field" id="bk-addr-field"><label for="bk-address">Home address</label><input id="bk-address" type="text" placeholder="Where should Trent come?" autocomplete="street-address"></div>' +
            '<div class="field full"><label for="bk-notes">Anything else?</label><textarea id="bk-notes" rows="2" placeholder="Which rooms? Colors? Timeline?"></textarea></div>' +
          '</div>' +
        '</div>' +
        '<div class="booking-footer">' +
          '<div class="booking-summary" id="bk-summary">Select a service, date, and time.</div>' +
          '<button type="button" class="btn btn-primary btn-lg" id="bk-submit" disabled>Confirm Booking</button>' +
        '</div>' +
      '</div>'
    );
    root.appendChild(wrap);

    Array.prototype.forEach.call(root.querySelectorAll('.svc-option'), function (b) {
      b.addEventListener('click', function () {
        state.service = b.getAttribute('data-svc');
        state.slot = null;
        render(); // render() re-loads slots at its end; no second call (avoids duplicate fetch)
      });
    });
    var dateInput = root.querySelector('#bk-date');
    dateInput.addEventListener('change', function () {
      state.date = dateInput.value;
      state.slot = null;
      loadSlots();
    });

    // show/hide address field based on service
    var addrField = root.querySelector('#bk-addr-field');
    if (addrField) addrField.style.display = state.service === 'consult' ? 'none' : '';

    root.querySelector('#bk-submit').addEventListener('click', submit);
    updateSummary();
    if (state.service && state.date) loadSlots();
  }

  function loadSlots() {
    var slotsEl = root.querySelector('#bk-slots');
    var msgEl = root.querySelector('#bk-slots-msg');
    if (!state.service || !state.date) {
      slotsEl.innerHTML = '';
      msgEl.textContent = 'Choose a service and date to see open times.';
      return;
    }
    slotsEl.innerHTML = '';
    msgEl.className = 'slots-msg';
    msgEl.textContent = 'Loading open times…';
    var seq = (state._seq = (state._seq || 0) + 1); // ignore stale/overlapping responses
    fetch(API + '/api/availability?service=' + encodeURIComponent(state.service) + '&date=' + encodeURIComponent(state.date))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (seq !== state._seq) return; // a newer load started; drop this one
        slotsEl.innerHTML = '';
        if (!data.slots || !data.slots.length) {
          msgEl.textContent = 'No open times that day — try another date, or call (717) 882-1183.';
          return;
        }
        msgEl.textContent = '';
        data.slots.forEach(function (s) {
          var btn = el('<button type="button" class="slot" data-start="' + s.start + '">' + s.label + '</button>');
          btn.addEventListener('click', function () {
            state.slot = s;
            Array.prototype.forEach.call(slotsEl.querySelectorAll('.slot'), function (x) { x.classList.remove('selected'); });
            btn.classList.add('selected');
            updateSummary();
          });
          slotsEl.appendChild(btn);
        });
      })
      .catch(function () {
        msgEl.className = 'slots-msg error';
        msgEl.textContent = 'Could not load times. Please call or text (717) 882-1183.';
      });
  }

  function updateSummary() {
    var summary = root.querySelector('#bk-summary');
    var submit = root.querySelector('#bk-submit');
    if (!summary) return;
    var svc = state.services.filter(function (s) { return s.id === state.service; })[0];
    if (state.service && state.slot) {
      var d = new Date(state.date + 'T00:00:00');
      var ds = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      summary.innerHTML = '<strong>' + svc.label + '</strong> · ' + ds + ' at ' + state.slot.label;
      submit.disabled = false;
    } else {
      summary.textContent = 'Select a service, date, and time.';
      submit.disabled = true;
    }
  }

  function submit() {
    var submit = root.querySelector('#bk-submit');
    var name = root.querySelector('#bk-name').value.trim();
    var phone = root.querySelector('#bk-phone').value.trim();
    var email = root.querySelector('#bk-email').value.trim();
    var address = (root.querySelector('#bk-address') || {}).value || '';
    var notes = root.querySelector('#bk-notes').value.trim();

    if (name.length < 2) { alert('Please enter your name.'); return; }
    if (phone.replace(/\D/g, '').length < 10) { alert('Please enter a valid phone number.'); return; }
    if (state.service === 'estimate' && address.trim().length < 5) { alert('Please enter the address for your free estimate.'); return; }

    submit.disabled = true;
    submit.textContent = 'Booking…';

    fetch(API + '/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: state.service,
        start: state.slot.start,
        name: name, phone: phone, email: email, address: address.trim(), notes: notes,
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          alert(res.j.error || 'Sorry, that booking failed. Please call (717) 882-1183.');
          submit.disabled = false;
          submit.textContent = 'Confirm Booking';
          if (res.j.error && /available|booked/i.test(res.j.error)) loadSlots();
          return;
        }
        showDone(res.j);
      })
      .catch(function () {
        alert('Could not reach the booking server. Please call or text (717) 882-1183.');
        submit.disabled = false;
        submit.textContent = 'Confirm Booking';
      });
  }

  function showDone(j) {
    root.innerHTML = '';
    root.appendChild(
      el(
        '<div class="booking"><div class="booking-done">' +
          '<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
          '<h3>You\'re booked!</h3>' +
          '<p class="when">' + (j.service || 'Appointment') + '</p>' +
          '<p class="when">' + (j.when || '') + '</p>' +
          '<p>' + (j.emailed ? 'A confirmation and calendar invite are on the way to your email.' : 'Trent will reach out to confirm. Need anything? Call or text (717) 882-1183.') + '</p>' +
        '</div></div>'
      )
    );
    // Bring the confirmation into view so the customer always sees it.
    try {
      var sec = document.getElementById('book') || root;
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (_) {}
  }

  function showUnavailable() {
    root.innerHTML = '';
    root.appendChild(
      el(
        '<div class="booking"><div class="booking-unavailable">' +
          'Online booking is warming up. Please call or text <a href="tel:+17178821183">(717) 882-1183</a> and we\'ll get you scheduled.' +
        '</div></div>'
      )
    );
  }

  // boot
  fetch(API + '/api/services')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      state.services = data.services || [];
      state.meta = data;
      state.tz = data.timezone || state.tz;
      state.date = todayISO();
      if (!state.services.length) { showUnavailable(); return; }
      render();
    })
    .catch(showUnavailable);
})();
