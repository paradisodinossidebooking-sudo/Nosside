// Paradiso di Nosside — modal disponibilità + preventivi
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const state = { apartment: null, busy: [], rangeStart: null, rangeEnd: null };

document.addEventListener('DOMContentLoaded', () => {
  const modal = $('#booking-modal');
  const apartmentStep = $('#apartment-step');
  const calendarStep = $('#calendar-step');
  const availabilityForm = $('#availability-form');
  const quoteForm = $('#quote-form');
  const apartment = $('#apartment');
  const guests = $('#guests');
  const checkin = $('#checkin');
  const checkout = $('#checkout');
  const availabilityResult = $('#availability-result');
  const quoteResult = $('#quote-result');
  const today = localISO(new Date());

  checkin.min = today;
  checkout.min = today;

  $$('[data-open-booking]').forEach(btn => btn.addEventListener('click', openModal));
  $$('[data-close-booking]').forEach(btn => btn.addEventListener('click', closeModal));
  $$('.booking-apartment-card').forEach(btn => btn.addEventListener('click', () => selectApartment(btn.dataset.apartment)));
  $('#booking-back').addEventListener('click', resetToApartments);

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal(); });

  checkin.addEventListener('change', () => {
    checkout.min = checkin.value || today;
    if (checkout.value && checkout.value <= checkin.value) checkout.value = '';
    quoteForm.classList.add('is-hidden');
    availabilityResult.textContent = '';
  });
  checkout.addEventListener('change', () => { quoteForm.classList.add('is-hidden'); availabilityResult.textContent = ''; });

  availabilityForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    quoteForm.classList.add('is-hidden');
    setStatus(availabilityResult, 'Controllo finale delle date…', '');
    if (!checkin.value || !checkout.value || checkout.value <= checkin.value) return setStatus(availabilityResult, 'Inserisci date valide.', 'error');
    if (rangeTouchesBusy(checkin.value, checkout.value, state.busy)) return setStatus(availabilityResult, 'Queste date includono almeno un giorno già occupato. Scegli un altro periodo.', 'error');
    try {
      const q = new URLSearchParams({ apartment: apartment.value, checkin: checkin.value, checkout: checkout.value });
      const r = await fetch('/api/availability?' + q);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Errore durante il controllo.');
      if (!data.available) {
        setStatus(availabilityResult, 'Questo periodo non è più disponibile. Il calendario è stato aggiornato.', 'error');
        await loadCalendar(apartment.value);
        return;
      }
      setStatus(availabilityResult, 'Periodo disponibile! Completa la richiesta qui sotto.', 'ok');
      ['apartment','checkin','checkout','guests'].forEach(k => $('#quote-' + k).value = $('#' + k).value);
      quoteForm.classList.remove('is-hidden');
      quoteForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      setStatus(availabilityResult, err.message || 'Servizio momentaneamente non disponibile.', 'error');
    }
  });

  quoteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus(quoteResult, 'Invio in corso…', '');
    try {
      const payload = Object.fromEntries(new FormData(quoteForm).entries());
      const r = await fetch('/api/quote', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Invio non riuscito.');
      setStatus(quoteResult, 'Richiesta inviata! Ti risponderemo il prima possibile.', 'ok');
      quoteForm.querySelectorAll('input:not([type=hidden]), textarea').forEach(el => { if (el.type === 'checkbox') el.checked = false; else el.value = ''; });
    } catch (err) {
      setStatus(quoteResult, err.message || 'Invio non riuscito. Riprova.', 'error');
    }
  });

  function openModal() {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    setTimeout(() => $('.booking-close').focus(), 50);
  }

  function closeModal() {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  function resetToApartments() {
    calendarStep.classList.add('is-hidden');
    apartmentStep.classList.remove('is-hidden');
    quoteForm.classList.add('is-hidden');
    availabilityResult.textContent = '';
  }

  async function selectApartment(value) {
    state.apartment = value;
    apartment.value = value;
    guests.max = value === 'bilocale' ? 4 : 6;
    if (+guests.value > +guests.max) guests.value = guests.max;
    $('#selected-apartment-title').textContent = value === 'bilocale' ? 'Bilocale · max 4 persone' : 'Trilocale · max 6 persone';
    apartmentStep.classList.add('is-hidden');
    calendarStep.classList.remove('is-hidden');
    quoteForm.classList.add('is-hidden');
    checkin.value = '';
    checkout.value = '';
    availabilityResult.textContent = '';
    await loadCalendar(value);
  }

  async function loadCalendar(value) {
    const loading = $('#calendar-loading');
    const holder = $('#availability-calendars');
    const error = $('#calendar-error');
    loading.classList.remove('is-hidden');
    availabilityForm.classList.add('is-hidden');
    error.classList.add('is-hidden');
    holder.innerHTML = '';
    try {
      const r = await fetch('/api/availability?apartment=' + encodeURIComponent(value) + '&view=calendar&months=3');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Impossibile caricare il calendario.');
      state.busy = Array.isArray(data.busy) ? data.busy : [];
      state.rangeStart = data.rangeStart;
      state.rangeEnd = data.rangeEnd;
      renderCalendars(holder, state.busy, 3);
      availabilityForm.classList.remove('is-hidden');
    } catch (err) {
      error.textContent = err.message || 'Impossibile caricare le disponibilità.';
      error.classList.remove('is-hidden');
    } finally {
      loading.classList.add('is-hidden');
    }
  }
});

function renderCalendars(holder, busy, count) {
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    holder.appendChild(buildMonth(monthDate, busy));
  }
}

function buildMonth(monthDate, busy) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const today = localISO(new Date());
  const box = document.createElement('section');
  box.className = 'mini-calendar';
  const title = document.createElement('h3');
  title.textContent = new Intl.DateTimeFormat('it-IT', { month:'long', year:'numeric' }).format(monthDate);
  box.appendChild(title);
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  ['L','M','M','G','V','S','D'].forEach(d => { const el = document.createElement('span'); el.className='calendar-weekday'; el.textContent=d; grid.appendChild(el); });
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) { const blank=document.createElement('span'); blank.className='calendar-day blank'; grid.appendChild(blank); }
  const days = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const date = localISO(new Date(year, month, d));
    const el = document.createElement('span');
    const past = date < today;
    const occupied = !past && dateIsBusy(date, busy);
    el.className = 'calendar-day ' + (past ? 'past' : occupied ? 'busy' : 'available');
    el.textContent = d;
    el.title = past ? 'Data passata' : occupied ? 'Occupato' : 'Disponibile';
    grid.appendChild(el);
  }
  box.appendChild(grid);
  return box;
}

function dateIsBusy(date, busy) {
  return busy.some(period => date >= period.start && date < period.end);
}
function rangeTouchesBusy(start, end, busy) {
  return busy.some(period => start < period.end && end > period.start);
}
function localISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = 'form-status' + (type ? ' ' + type : '');
}
