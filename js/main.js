// Paradiso di Nosside — disponibilità + preventivi
const $ = (s) => document.querySelector(s);

document.addEventListener('DOMContentLoaded', () => {
  const availabilityForm = $('#availability-form');
  const quoteForm = $('#quote-form');
  const apartment = $('#apartment');
  const guests = $('#guests');
  const checkin = $('#checkin');
  const checkout = $('#checkout');
  const availabilityResult = $('#availability-result');
  const quoteResult = $('#quote-result');
  const today = new Date().toISOString().slice(0,10);
  checkin.min = today; checkout.min = today;

  apartment.addEventListener('change', () => { guests.max = apartment.value === 'bilocale' ? 4 : 6; if (+guests.value > +guests.max) guests.value = guests.max; });
  checkin.addEventListener('change', () => { checkout.min = checkin.value || today; if (checkout.value && checkout.value <= checkin.value) checkout.value = ''; });

  availabilityForm.addEventListener('submit', async (e) => {
    e.preventDefault(); quoteForm.classList.add('is-hidden');
    availabilityResult.className='form-status'; availabilityResult.textContent='Controllo disponibilità…';
    if (!checkin.value || !checkout.value || checkout.value <= checkin.value) return setStatus(availabilityResult,'Inserisci date valide.','error');
    try {
      const q = new URLSearchParams({apartment: apartment.value, checkin: checkin.value, checkout: checkout.value});
      const r = await fetch('/api/availability?' + q); const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Errore durante il controllo.');
      if (!data.available) return setStatus(availabilityResult,'Questo periodo non è disponibile. Prova altre date.','error');
      setStatus(availabilityResult,'Periodo disponibile. Puoi inviare una richiesta di preventivo.','ok');
      ['apartment','checkin','checkout','guests'].forEach(k => $('#quote-'+k).value = $('#'+k).value);
      quoteForm.classList.remove('is-hidden'); quoteForm.scrollIntoView({behavior:'smooth',block:'nearest'});
    } catch(err) { setStatus(availabilityResult,err.message || 'Servizio momentaneamente non disponibile.','error'); }
  });

  quoteForm.addEventListener('submit', async (e) => {
    e.preventDefault(); setStatus(quoteResult,'Invio in corso…','');
    try {
      const payload=Object.fromEntries(new FormData(quoteForm).entries());
      const r=await fetch('/api/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}); const data=await r.json();
      if(!r.ok) throw new Error(data.error || 'Invio non riuscito.');
      setStatus(quoteResult,'Richiesta inviata! Ti risponderemo il prima possibile.','ok');
      quoteForm.querySelectorAll('input:not([type=hidden]), textarea').forEach(el=>{if(el.type==='checkbox')el.checked=false;else el.value='';});
    } catch(err){ setStatus(quoteResult,err.message || 'Invio non riuscito. Riprova.','error'); }
  });
});
function setStatus(el,msg,type){el.textContent=msg;el.className='form-status'+(type?' '+type:'');}
