export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/debug-calendar") {
      try {
        const apartment = url.searchParams.get("apartment") || "bilocale";
        const calendarId = apartment === "bilocale"
          ? env.GOOGLE_CALENDAR_ID_BILOCALE
          : env.GOOGLE_CALENDAR_ID_TRILOCALE;

        if (!calendarId) {
          return json({ ok: false, step: "calendar-id", apartment, error: "Calendar ID non configurato" }, 500);
        }

        const token = await googleToken(env);
        const start = startOfToday();
        const end = new Date(start);
        end.setMonth(end.getMonth() + 6);
        const busy = await googleBusy(calendarId, token, start, end);

        return json({
          ok: true,
          apartment,
          calendarId,
          range: { timeMin: start.toISOString(), timeMax: end.toISOString() },
          busyCount: busy.length,
          busy
        });
      } catch (error) {
        return json({ ok: false, step: "exception", error: error?.message || String(error) }, 500);
      }
    }

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, worker: 'nosside-v3' });
      if (url.pathname === '/api/availability' && request.method === 'GET') return await checkAvailability(request, env);
      if (url.pathname === '/api/quote' && request.method === 'POST') return await sendQuote(request, env);
      if (url.pathname === '/admin/quote' && request.method === 'GET') return await quoteAdminPage(request, env);
      if (url.pathname === '/api/admin/send-quote' && request.method === 'POST') return await sendApprovedQuote(request, env);
      if (url.pathname === '/quote/accept' && request.method === 'GET') return await quoteAcceptPage(request, env);
      if (url.pathname === '/api/quote/accept' && request.method === 'POST') return await acceptQuote(request, env);
      if (url.pathname === '/admin/block-calendar' && request.method === 'GET') return await blockCalendarPage(request, env);
      if (url.pathname === '/api/admin/block-calendar' && request.method === 'POST') return await blockCalendar(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('WORKER ERROR:', error);
      return json({ error: 'Errore interno del server.', debug: error?.message || String(error) }, 500);
    }
  }
};

async function checkAvailability(request, env) {
  const url = new URL(request.url);
  const apartment = url.searchParams.get('apartment');
  if (!['bilocale', 'trilocale'].includes(apartment)) return json({ error: 'Appartamento non valido.' }, 400);

  const calendarId = apartment === 'bilocale' ? env.GOOGLE_CALENDAR_ID_BILOCALE : env.GOOGLE_CALENDAR_ID_TRILOCALE;
  if (!calendarId) throw new Error('Calendar ID non configurato');
  const token = await googleToken(env);

  // Vista calendario: restituisce i periodi occupati dei prossimi 1-12 mesi.
  if (url.searchParams.get('view') === 'calendar') {
    const months = Math.min(12, Math.max(1, Number(url.searchParams.get('months')) || 3));
    const start = startOfToday();
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    const busy = await googleBusy(calendarId, token, start, end);
    return json({
      apartment,
      rangeStart: dateOnly(start),
      rangeEnd: dateOnly(end),
      busy: busy.map(period => ({ start: instantToRomeDate(period.start), end: instantToRomeDateInclusiveEnd(period.end) }))
    });
  }

  const checkin = url.searchParams.get('checkin');
  const checkout = url.searchParams.get('checkout');
  if (!isDateOnly(checkin) || !isDateOnly(checkout) || checkout <= checkin) return json({ error: 'Parametri non validi.' }, 400);

  // Mezzanotte locale Europe/Rome convertita in UTC con Intl, evitando offset +01/+02 hard-coded.
  const timeMin = romeMidnightToUTC(checkin);
  // Il checkout viene trattato come giorno occupato anche nella verifica finale,
  // così preview e controllo disponibilità usano esattamente la stessa regola.
  const checkoutNext = addRomeDays(checkout, 1);
  const timeMax = romeMidnightToUTC(checkoutNext);
  const busy = await googleBusy(calendarId, token, timeMin, timeMax);
  return json({ available: busy.length === 0 });
}

async function googleBusy(calendarId, token, timeMin, timeMax) {
  // Google FreeBusy rifiuta intervalli troppo lunghi. Dividiamo quindi
  // automaticamente la richiesta in blocchi da 60 giorni e uniamo i risultati.
  const MAX_CHUNK_DAYS = 60;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const allBusy = [];

  let chunkStart = new Date(timeMin);
  const finalEnd = new Date(timeMax);

  while (chunkStart < finalEnd) {
    const chunkEnd = new Date(Math.min(
      chunkStart.getTime() + MAX_CHUNK_DAYS * DAY_MS,
      finalEnd.getTime()
    ));

    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        timeMin: chunkStart.toISOString(),
        timeMax: chunkEnd.toISOString(),
        timeZone: 'Europe/Rome',
        items: [{ id: calendarId }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('GOOGLE FREEBUSY ERROR:', r.status, JSON.stringify(data));
      throw new Error(`Google Calendar non raggiungibile (${r.status})`);
    }

    const cal = data.calendars?.[calendarId];
    if (cal?.errors?.length) {
      console.error('GOOGLE CALENDAR ERROR:', JSON.stringify(cal.errors));
      throw new Error('Google Calendar: accesso al calendario non riuscito');
    }

    allBusy.push(...(cal?.busy || []));
    chunkStart = chunkEnd;
  }

  return allBusy;
}

async function sendQuote(request, env) {
  const b = await request.json();
  const required = ['name','email','apartment','checkin','checkout','guests'];
  if (required.some(k => !b[k])) return json({ error: 'Compila tutti i campi obbligatori.' }, 400);
  if (!env.RESEND_API_KEY) throw new Error('Manca RESEND_API_KEY');
  if (!env.MAIL_FROM) throw new Error('Manca MAIL_FROM');
  if (!env.ADMIN_QUOTE_SECRET) throw new Error('Manca ADMIN_QUOTE_SECRET');

  const lang = normalizeLang(b.lang);
  const li = languageInfo(lang);
  const apartmentNameIt = b.apartment === 'trilocale' ? 'Trilocale' : 'Bilocale';
  const apartmentNameGuest = li.apt[b.apartment] || apartmentNameIt;
  const pricing = calculateQuote(b.apartment, Number(b.guests), b.checkin, b.checkout);
  const quoteId = makeQuoteId();
  const record = {
    quoteId, createdAt: new Date().toISOString(), lang,
    name:String(b.name), email:String(b.email), phone:String(b.phone || ''), message:String(b.message || ''),
    apartment:b.apartment, checkin:b.checkin, checkout:b.checkout, guests:Number(b.guests), pricing
  };
  const token = await signQuote(record, env.ADMIN_QUOTE_SECRET);
  const origin = new URL(request.url).origin;
  const confirmUrl = `${origin}/admin/quote?mode=confirm&token=${encodeURIComponent(token)}`;
  const editUrl = `${origin}/admin/quote?mode=edit&token=${encodeURIComponent(token)}`;

  const pricingHtml = pricing.ok
    ? `<div style="background:#f5f0e6;padding:18px 20px;margin:20px 0;border-radius:10px"><b>Preventivo calcolato automaticamente</b><br>Notti: ${pricing.nights}<br>Fascia ospiti: ${esc(pricing.guestBand)}<br>${pricing.weeklyApplied ? 'Tariffa settimanale applicata<br>' : ''}<b>Totale proposto: €${money(pricing.total)}</b>${pricing.breakdown?.length ? `<br><small>${pricing.breakdown.map(esc).join('<br>')}</small>` : ''}</div>`
    : `<div style="background:#fff4df;padding:18px 20px;margin:20px 0;border-radius:10px"><b>Prezzo da impostare manualmente</b><br>${esc(pricing.error)}</div>`;

  const subject = `${li.flag} ${pricing.ok ? `€${money(pricing.total)} · ` : ''}Richiesta preventivo ${apartmentNameIt} · ${b.checkin} → ${b.checkout}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#2b2620;line-height:1.55"><h2>Nuova richiesta dal sito</h2><p><b>ID:</b> ${esc(quoteId)}<br><b>Lingua usata:</b> ${li.flag} ${esc(li.label)} (${lang.toUpperCase()})</p><p><b>Appartamento:</b> ${esc(apartmentNameIt)}<br><b>Check-in:</b> ${esc(b.checkin)}<br><b>Check-out:</b> ${esc(b.checkout)}<br><b>Ospiti:</b> ${esc(String(b.guests))}</p><p><b>Nome:</b> ${esc(b.name)}<br><b>Email:</b> ${esc(b.email)}<br><b>Telefono:</b> ${esc(b.phone || '-')}</p><p><b>Messaggio:</b><br>${esc(b.message || '-')}</p>${pricingHtml}<p style="margin-top:26px"><a href="${esc(confirmUrl)}" style="display:inline-block;background:#176b5f;color:#fff;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:700;margin:0 8px 8px 0">Conferma e invia</a><a href="${esc(editUrl)}" style="display:inline-block;background:#b6a06f;color:#fff;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:700">Modifica preventivo</a></p><p style="font-size:12px;color:#777">Il cliente non riceve il prezzo finché non lo approvi da uno dei pulsanti qui sopra.</p></div>`;

  await resendEmail(env, {to:[env.MAIL_TO || 'paradisodinossidebooking@gmail.com'],reply_to:b.email,subject,html});

  // Al cliente arriva soltanto la conferma di ricezione. Nessun prezzo viene inviato in questa fase.
  const guestHtml = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;background:#fff;color:#2b2620;line-height:1.6;border:1px solid #eee6d8;border-radius:18px;overflow:hidden"><div style="background:#173f38;padding:28px;text-align:center"><div style="font-family:Georgia,serif;font-size:26px;letter-spacing:.08em;color:#fff">PARADISO DI NOSSIDE</div><div style="color:#d9c99f;font-size:13px;margin-top:5px">LOCRI · CALABRIA</div></div><div style="padding:30px"><p style="margin-top:0;color:#8a7750;font-weight:700;text-transform:uppercase;font-size:12px;letter-spacing:.12em">${esc(record.quoteId)}</p><h2 style="font-family:Georgia,serif;color:#176b5f;font-size:28px;margin:4px 0 8px">${L.title}</h2><p>${L.intro}</p><div style="background:#f7f3ea;padding:22px;margin:24px 0;border-radius:14px"><div style="font-size:19px;font-weight:700;color:#176b5f">${esc(apt)}</div><div style="margin-top:10px">Check-in: <b>${esc(record.checkin)}</b><br>Check-out: <b>${esc(record.checkout)}</b><br>${li.guests}: <b>${esc(String(record.guests))}</b><br>${L.nights}: <b>${esc(String(nights))}</b></div><hr style="border:0;border-top:1px solid #ddd1bd;margin:18px 0"><div style="font-size:13px;color:#70695e">${L.total}</div><strong style="font-family:Georgia,serif;font-size:34px;color:#176b5f">€${money(total)}</strong></div>${note ? `<div style="border-left:3px solid #b6a06f;padding:4px 0 4px 14px;margin:20px 0"><b>${L.note}</b><br>${esc(note)}</div>` : ''}<p style="font-size:13px;color:#70695e">${L.valid}</p><div style="text-align:center;margin:28px 0"><a href="${esc(acceptUrl)}" style="display:block;background:#176b5f;color:#fff;text-decoration:none;padding:16px 20px;border-radius:999px;font-weight:700;margin-bottom:12px">${L.accept}</a><a href="${esc(whatsappUrl)}" style="display:block;background:#25D366;color:#fff;text-decoration:none;padding:15px 20px;border-radius:999px;font-weight:700">${L.whatsapp}</a></div><p style="font-size:14px;color:#70695e">${L.footer}</p><p>${li.bye},<br><b>Paradiso di Nosside</b></p></div></div>`;
  await resendEmail(env, {to:[record.email],reply_to:env.MAIL_TO || 'paradisodinossidebooking@gmail.com',subject:`${li.flag} ${L.title} · Paradiso di Nosside · €${money(total)}`,html:guestHtml});
  return json({ok:true, quoteId:record.quoteId, total});
}

async function quoteAcceptPage(request, env) {
  if (!env.ADMIN_QUOTE_SECRET) return htmlResponse('<h1>Configurazione incompleta</h1>', 500);
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const record = await verifyQuote(token, env.ADMIN_QUOTE_SECRET);
  if (!record || !(Number(record.approvedTotal) > 0)) return htmlResponse('<h1>Link non valido</h1><p>Il link del preventivo non è valido o è stato alterato.</p>', 403);
  if (quoteExpired(record)) return htmlResponse(expiredQuoteHtml(record.lang), 410);
  const li = languageInfo(record.lang);
  const apt = li.apt[record.apartment];
  const t = {
    it:{title:'Conferma preventivo',text:'Controlla i dati e conferma che desideri accettare questo preventivo.',button:'Accetta il preventivo',sending:'Conferma in corso…',ok:'Preventivo accettato ✓',done:'Grazie! Abbiamo ricevuto la tua accettazione. Ti contatteremo per i prossimi passaggi.'},
    en:{title:'Confirm quote',text:'Check the details and confirm that you would like to accept this quote.',button:'Accept quote',sending:'Confirming…',ok:'Quote accepted ✓',done:'Thank you! We received your acceptance. We will contact you with the next steps.'},
    fr:{title:'Confirmer le devis',text:'Vérifiez les informations et confirmez que vous souhaitez accepter ce devis.',button:'Accepter le devis',sending:'Confirmation…',ok:'Devis accepté ✓',done:'Merci ! Nous avons reçu votre acceptation. Nous vous contacterons pour la suite.'},
    de:{title:'Angebot bestätigen',text:'Prüfen Sie die Angaben und bestätigen Sie, dass Sie dieses Angebot annehmen möchten.',button:'Angebot annehmen',sending:'Bestätigung läuft…',ok:'Angebot angenommen ✓',done:'Vielen Dank! Wir haben Ihre Annahme erhalten und melden uns wegen der nächsten Schritte.'}
  }[record.lang] || null;
  const T=t||{title:'Conferma preventivo',text:'Controlla i dati e conferma che desideri accettare questo preventivo.',button:'Accetta il preventivo',sending:'Conferma in corso…',ok:'Preventivo accettato ✓',done:'Grazie! Abbiamo ricevuto la tua accettazione. Ti contatteremo per i prossimi passaggi.'};
  return htmlResponse(`<!doctype html><html lang="${esc(record.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${T.title}</title><style>body{margin:0;background:#f5f0e6;color:#2b2620;font:16px/1.55 Arial,sans-serif}.wrap{max-width:620px;margin:40px auto;padding:20px}.card{background:#fff;border-radius:20px;padding:30px;box-shadow:0 16px 45px #0002}h1{font-family:Georgia,serif;color:#176b5f}.summary{background:#f7f3ea;border-radius:14px;padding:18px;margin:22px 0}.total{font-size:30px;font-weight:700;color:#176b5f}button{width:100%;border:0;border-radius:999px;padding:15px;background:#176b5f;color:#fff;font-weight:700;font-size:16px;cursor:pointer}.msg{text-align:center;margin-top:18px}</style></head><body><div class="wrap"><div class="card"><h1>${T.title}</h1><p>${T.text}</p><div class="summary"><b>${esc(apt)}</b><br>${esc(record.checkin)} → ${esc(record.checkout)}<br>${esc(String(record.guests))} ${esc(li.guests.toLowerCase())}<br><br><span class="total">€${money(record.approvedTotal)}</span>${record.approvedNote?`<p>${esc(record.approvedNote)}</p>`:''}</div><button id="accept">${T.button}</button><p id="msg" class="msg"></p></div></div><script>const b=document.querySelector('#accept'),m=document.querySelector('#msg');b.addEventListener('click',async()=>{b.disabled=true;m.textContent=${JSON.stringify(T.sending)};try{const r=await fetch('/api/quote/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Errore');document.querySelector('h1').textContent=${JSON.stringify(T.ok)};m.textContent=${JSON.stringify(T.done)};b.style.display='none'}catch(e){m.textContent=e.message;b.disabled=false}})</script></body></html>`);
}

async function acceptQuote(request, env) {
  if (!env.ADMIN_QUOTE_SECRET) return json({error:'Manca ADMIN_QUOTE_SECRET'}, 500);
  const b = await request.json();
  const record = await verifyQuote(String(b.token || ''), env.ADMIN_QUOTE_SECRET);
  if (!record || !(Number(record.approvedTotal) > 0)) return json({error:'Link del preventivo non valido.'}, 403);
  if (quoteExpired(record)) return json({error: acceptanceMessage(record.lang,'expired')}, 410);
  const calendarId = record.apartment === 'bilocale' ? env.GOOGLE_CALENDAR_ID_BILOCALE : env.GOOGLE_CALENDAR_ID_TRILOCALE;
  if (!calendarId) return json({error:acceptanceMessage(record.lang,'calendar')},500);
  const token = await googleToken(env);
  const busy = await googleBusy(calendarId, token, romeMidnightToUTC(record.checkin), romeMidnightToUTC(record.checkout));
  if (busy.length) return json({error:acceptanceMessage(record.lang,'unavailable')},409);
  const li = languageInfo(record.lang);
  const aptIt = record.apartment === 'trilocale' ? 'Trilocale' : 'Bilocale';
  const customerPhone = whatsappPhone(record.phone);
  const acceptedNights = Number.isFinite(Number(record.pricing?.nights)) && Number(record.pricing?.nights) > 0 ? Number(record.pricing.nights) : nightsBetween(record.checkin, record.checkout);
  const adminWaText = `Ciao ${record.name}, grazie per aver accettato il preventivo ${record.quoteId} di Paradiso di Nosside.

Riepilogo preventivo:
Appartamento: ${aptIt}
Check-in: ${record.checkin}
Check-out: ${record.checkout}
Ospiti: ${record.guests}
Notti: ${acceptedNights}
Totale: €${money(record.approvedTotal)}${record.approvedNote ? `\nNota: ${record.approvedNote}` : ''}

Ti contattiamo per i prossimi passaggi.`;
  const customerWaUrl = customerPhone ? `https://wa.me/${customerPhone}?text=${encodeURIComponent(adminWaText)}` : '';
  const blockToken = await signQuote({...record, acceptedAt:new Date().toISOString()}, env.ADMIN_QUOTE_SECRET);
  const blockUrl = `${new URL(request.url).origin}/admin/block-calendar?token=${encodeURIComponent(blockToken)}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#2b2620;line-height:1.6"><h2 style="color:#176b5f">Preventivo accettato dal cliente</h2><p><b>ID:</b> ${esc(record.quoteId)}<br><b>Cliente:</b> ${esc(record.name)}<br><b>Email:</b> ${esc(record.email)}<br><b>Telefono:</b> ${esc(record.phone || '-')}</p><p><b>Appartamento:</b> ${esc(aptIt)}<br><b>Check-in:</b> ${esc(record.checkin)}<br><b>Check-out:</b> ${esc(record.checkout)}<br><b>Ospiti:</b> ${esc(String(record.guests))}<br><b>Totale accettato:</b> €${money(record.approvedTotal)}</p>${record.approvedNote?`<p><b>Nota preventivo:</b><br>${esc(record.approvedNote)}</p>`:''}<p><b>Lingua cliente:</b> ${li.flag} ${esc(li.label)}</p>${customerWaUrl ? `<div style="margin:26px 0 10px"><a href="${esc(customerWaUrl)}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:14px 22px;border-radius:999px;font-weight:700">Scrivi al cliente su WhatsApp</a></div>` : '<p><i>Pulsante WhatsApp non disponibile: numero di telefono mancante o non valido.</i></p>'}<div style="margin:10px 0 26px"><a href="${esc(blockUrl)}" style="display:inline-block;background:#176b5f;color:#fff;text-decoration:none;padding:14px 22px;border-radius:999px;font-weight:700">Blocca calendario e conferma prenotazione</a></div><p style="font-size:12px;color:#777">Usa questo pulsante solo dopo aver ricevuto la caparra. Il cliente riceverà la conferma di prenotazione dopo il blocco del calendario.</p></div>`;
  await resendEmail(env,{to:[env.MAIL_TO || 'paradisodinossidebooking@gmail.com'],reply_to:record.email,subject:`✅ Preventivo accettato · ${record.quoteId} · €${money(record.approvedTotal)}`,html});
  return json({ok:true,quoteId:record.quoteId});
}

function quoteExpired(record){ const x=Date.parse(record.expiresAt || (record.approvedAt ? new Date(Date.parse(record.approvedAt)+7*86400000).toISOString() : '')); return !Number.isFinite(x) || Date.now()>x; }
function acceptanceMessage(lang,key){ const d={it:{expired:'Questo preventivo è scaduto. Contattaci per riceverne uno nuovo.',unavailable:'Le date non sono più disponibili. Contattaci per verificare altre date.',calendar:'Impossibile verificare la disponibilità in questo momento.'},en:{expired:'This quote has expired. Contact us for a new quote.',unavailable:'These dates are no longer available. Contact us to check other dates.',calendar:'Availability cannot be checked right now.'},fr:{expired:'Ce devis a expiré. Contactez-nous pour recevoir un nouveau devis.',unavailable:'Ces dates ne sont plus disponibles. Contactez-nous pour vérifier d’autres dates.',calendar:'Impossible de vérifier les disponibilités pour le moment.'},de:{expired:'Dieses Angebot ist abgelaufen. Kontaktieren Sie uns für ein neues Angebot.',unavailable:'Diese Daten sind nicht mehr verfügbar. Kontaktieren Sie uns für andere Termine.',calendar:'Die Verfügbarkeit kann derzeit nicht geprüft werden.'}}; return (d[normalizeLang(lang)]||d.it)[key]; }
function expiredQuoteHtml(lang){ return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#f5f0e6;font:16px Arial;color:#2b2620"><div style="max-width:560px;margin:60px auto;padding:28px;background:#fff;border-radius:20px;text-align:center"><h1 style="font-family:Georgia;color:#176b5f">${esc(acceptanceMessage(lang,'expired'))}</h1><p>Paradiso di Nosside</p></div></body></html>`; }

async function blockCalendarPage(request, env){
  const token=new URL(request.url).searchParams.get('token')||''; const r=await verifyQuote(token,env.ADMIN_QUOTE_SECRET||'');
  if(!r) return htmlResponse('<h1>Link non valido</h1>',403);
  return htmlResponse(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blocca calendario</title><style>body{margin:0;background:#f5f0e6;font:16px Arial;color:#2b2620}.c{max-width:620px;margin:45px auto;padding:28px;background:#fff;border-radius:20px;box-shadow:0 16px 45px #0002}h1{font-family:Georgia;color:#176b5f}button{width:100%;padding:15px;border:0;border-radius:999px;background:#176b5f;color:#fff;font-weight:700;font-size:16px;cursor:pointer}</style></head><body><div class="c"><h1>Blocca calendario</h1><p><b>${esc(r.name)}</b><br>${esc(r.apartment==='trilocale'?'Trilocale':'Bilocale')} · ${esc(r.checkin)} → ${esc(r.checkout)}<br>€${money(r.approvedTotal)}</p><p>Confermando, le date verranno inserite nel Google Calendar e il cliente riceverà l’email di prenotazione confermata.</p><button id="b">Blocca calendario e conferma prenotazione</button><p id="m"></p></div><script>const b=document.querySelector('#b'),m=document.querySelector('#m');b.onclick=async()=>{b.disabled=true;m.textContent='Operazione in corso…';try{const x=await fetch('/api/admin/block-calendar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})}),d=await x.json();if(!x.ok)throw new Error(d.error||'Errore');m.innerHTML='<b>Calendario bloccato. Prenotazione confermata e cliente avvisato ✓</b>';b.style.display='none'}catch(e){m.textContent=e.message;b.disabled=false}}</script></body></html>`);
}
async function blockCalendar(request,env){
  if(!env.ADMIN_QUOTE_SECRET) return json({error:'Manca ADMIN_QUOTE_SECRET'},500); const b=await request.json(); const r=await verifyQuote(String(b.token||''),env.ADMIN_QUOTE_SECRET); if(!r) return json({error:'Link non valido.'},403);
  const calendarId=r.apartment==='bilocale'?env.GOOGLE_CALENDAR_ID_BILOCALE:env.GOOGLE_CALENDAR_ID_TRILOCALE; if(!calendarId)return json({error:'Calendar ID non configurato'},500); const gt=await googleToken(env);
  const busy=await googleBusy(calendarId,gt,romeMidnightToUTC(r.checkin),romeMidnightToUTC(r.checkout)); if(busy.length)return json({error:'Le date risultano già occupate nel calendario.'},409);
  const ev=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,{method:'POST',headers:{Authorization:`Bearer ${gt}`,'content-type':'application/json'},body:JSON.stringify({summary:`Reserved · ${r.name} · ${r.quoteId}`,description:`Prenotazione confermata dal sito\nCliente: ${r.name}\nEmail: ${r.email}\nTelefono: ${r.phone||'-'}\nOspiti: ${r.guests}\nTotale: €${money(r.approvedTotal)}`,start:{date:r.checkin},end:{date:r.checkout}})}); if(!ev.ok){console.error('GOOGLE EVENT ERROR',await ev.text());return json({error:'Non sono riuscito a bloccare il calendario.'},500);}
  const li=languageInfo(r.lang), apt=li.apt[r.apartment]||r.apartment; const tx={it:{title:'Prenotazione confermata',p:'La tua prenotazione è confermata. Le date sono state riservate per te.'},en:{title:'Booking confirmed',p:'Your booking is confirmed. The dates have been reserved for you.'},fr:{title:'Réservation confirmée',p:'Votre réservation est confirmée. Les dates ont été réservées pour vous.'},de:{title:'Buchung bestätigt',p:'Ihre Buchung ist bestätigt. Die Termine wurden für Sie reserviert.'}}[normalizeLang(r.lang)];
  const html=`<div style="font-family:Arial;max-width:620px;margin:auto;color:#2b2620;line-height:1.6"><div style="background:#173f38;color:#fff;padding:28px;text-align:center"><b style="font-family:Georgia;font-size:25px">PARADISO DI NOSSIDE</b></div><div style="padding:28px"><h2 style="font-family:Georgia;color:#176b5f">${tx.title} ✓</h2><p>${tx.p}</p><div style="background:#f7f3ea;padding:20px;border-radius:14px"><b>${esc(apt)}</b><br>Check-in: ${esc(r.checkin)}<br>Check-out: ${esc(r.checkout)}<br>${li.guests}: ${esc(String(r.guests))}<br><b>€${money(r.approvedTotal)}</b></div><p>${li.bye},<br><b>Paradiso di Nosside</b></p></div></div>`; await resendEmail(env,{to:[r.email],reply_to:env.MAIL_TO||'paradisodinossidebooking@gmail.com',subject:`✅ ${tx.title} · Paradiso di Nosside`,html}); return json({ok:true});
}

function whatsappPhone(value) {
  let n = String(value || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.startsWith('00')) n = n.slice(2);
  if (n.length === 10 && n.startsWith('3')) n = '39' + n;
  return n.length >= 8 && n.length <= 15 ? n : '';
}

function whatsappQuoteText(lang, q) {
  const lines = {
    it:[`Ciao Paradiso di Nosside, vi contatto per il preventivo ${q.quoteId}.`,`Nome: ${q.name}`,`Appartamento: ${q.apartment}`,`Check-in: ${q.checkin}`,`Check-out: ${q.checkout}`,`Ospiti: ${q.guests}`,`Notti: ${q.nights}`,`Totale preventivo: €${money(q.total)}`,q.note?`Nota: ${q.note}`:'','Vorrei ricevere maggiori informazioni.'],
    en:[`Hello Paradiso di Nosside, I am contacting you about quote ${q.quoteId}.`,`Name: ${q.name}`,`Apartment: ${q.apartment}`,`Check-in: ${q.checkin}`,`Check-out: ${q.checkout}`,`Guests: ${q.guests}`,`Nights: ${q.nights}`,`Quote total: €${money(q.total)}`,q.note?`Note: ${q.note}`:'','I would like more information.'],
    fr:[`Bonjour Paradiso di Nosside, je vous contacte au sujet du devis ${q.quoteId}.`,`Nom : ${q.name}`,`Appartement : ${q.apartment}`,`Arrivée : ${q.checkin}`,`Départ : ${q.checkout}`,`Voyageurs : ${q.guests}`,`Nuits : ${q.nights}`,`Total du devis : €${money(q.total)}`,q.note?`Note : ${q.note}`:'',"Je souhaiterais obtenir plus d'informations."],
    de:[`Hallo Paradiso di Nosside, ich kontaktiere Sie wegen des Angebots ${q.quoteId}.`,`Name: ${q.name}`,`Apartment: ${q.apartment}`,`Check-in: ${q.checkin}`,`Check-out: ${q.checkout}`,`Gäste: ${q.guests}`,`Nächte: ${q.nights}`,`Angebotssumme: €${money(q.total)}`,q.note?`Hinweis: ${q.note}`:'','Ich hätte gerne weitere Informationen.']
  }[normalizeLang(lang)];
  return lines.filter(Boolean).join('\n');
}

function calculateQuote(apartment, guests, checkin, checkout) {
  if (!['bilocale','trilocale'].includes(apartment)) return {ok:false,error:'Appartamento non valido.'};
  const max = apartment === 'bilocale' ? 4 : 6;
  if (!Number.isInteger(guests) || guests < 1 || guests > max) return {ok:false,error:`Numero ospiti non valido (massimo ${max}).`};
  const nights = nightsBetween(checkin, checkout);
  if (!Number.isInteger(nights) || nights < 1) return {ok:false,error:'Date non valide.'};
  const band = apartment === 'bilocale' ? (guests <= 3 ? 'low' : 'high') : (guests <= 5 ? 'low' : 'high');
  const guestBand = apartment === 'bilocale' ? (band === 'low' ? 'tariffa 1–3 ospiti' : 'tariffa 4 ospiti') : (band === 'low' ? 'tariffa 1–5 ospiti' : 'tariffa 6 ospiti');
  const days = [];
  for (let i=0;i<nights;i++) {
    const d = addDateOnlyDays(checkin, i);
    const rule = priceRule(apartment, d);
    if (!rule) return {ok:false,nights,guestBand,error:`Nessuna tariffa configurata per la notte del ${d}. Apri “Modifica preventivo” e inserisci il totale manualmente.`};
    days.push({date:d, rule, nightly:rule[band].nightly, weekly:rule[band].weekly});
  }
  const sameRule = days.every(x => x.rule.key === days[0].rule.key);
  let total = 0, weeklyApplied = false, breakdown=[];
  if (sameRule && nights >= 7) {
    const weeks = Math.floor(nights/7), rest=nights%7;
    total = weeks*days[0].weekly + rest*days[0].nightly;
    weeklyApplied = weeks > 0;
    breakdown.push(`${days[0].rule.label}: ${weeks} settimana/e × €${money(days[0].weekly)}${rest ? ` + ${rest} notte/i × €${money(days[0].nightly)}` : ''}`);
  } else {
    const groups=[];
    for (const x of days) { const last=groups[groups.length-1]; if(last && last.key===x.rule.key){last.count++;}else groups.push({key:x.rule.key,label:x.rule.label,count:1,nightly:x.nightly}); }
    for (const g of groups) { total += g.count*g.nightly; breakdown.push(`${g.label}: ${g.count} notte/i × €${money(g.nightly)}`); }
  }
  return {ok:true,nights,guestBand,total:Number(total.toFixed(2)),weeklyApplied,breakdown};
}

function priceRule(apartment, date) {
  const md = date.slice(5);
  const ranges = [
    ['05-31','06-06','31 maggio – 6 giugno',[75,500,90,600],[100,665,115,765]],
    ['06-07','06-13','7 – 13 giugno',[80,535,95,635],[105,700,120,800]],
    ['06-14','06-20','14 – 20 giugno',[85,565,100,665],[110,735,125,830]],
    ['06-21','06-27','21 – 27 giugno',[90,600,105,700],[115,765,130,865]],
    ['06-28','07-04','28 giugno – 4 luglio',[90,600,105,700],[120,800,135,900]],
    ['07-05','07-11','5 – 11 luglio',[95,635,110,735],[125,830,140,930]],
    ['07-12','07-18','12 – 18 luglio',[100,665,115,765],[130,865,145,965]],
    ['07-19','07-25','19 – 25 luglio',[105,700,120,800],[135,900,150,1000]],
    ['07-26','08-01','26 luglio – 1 agosto',[110,735,125,830],[140,930,155,1030]],
    ['08-02','08-08','2 – 8 agosto',[115,765,130,865],[150,1000,165,1095]],
    ['08-09','08-15','9 – 15 agosto · Ferragosto',[125,830,140,930],[170,1130,185,1230]],
    ['08-16','08-22','16 – 22 agosto',[115,765,130,865],[155,1030,170,1130]],
    ['08-23','08-29','23 – 29 agosto',[105,700,120,800],[140,930,155,1030]],
    ['08-30','09-05','30 agosto – 5 settembre',[95,635,110,735],[130,865,145,965]],
    ['09-06','09-12','6 – 12 settembre',[90,600,105,700],[120,800,135,900]],
    ['09-13','09-19','13 – 19 settembre',[85,565,100,665],[115,765,130,865]],
    ['09-20','09-26','20 – 26 settembre',[80,535,95,635],[105,700,120,800]],
    ['09-27','10-03','27 settembre – 3 ottobre',[75,500,90,600],[100,665,115,765]]
  ];
  const row = ranges.find(r => md >= r[0] && md <= r[1]);
  if (!row) return null;
  const a = apartment === 'bilocale' ? row[3] : row[4];
  return {key:row[0],label:row[2],low:{nightly:a[0],weekly:a[1]},high:{nightly:a[2],weekly:a[3]}};
}

function languageInfo(lang) {
  return {
    it:{flag:'🇮🇹',label:'Italiano',apt:{bilocale:'Bilocale',trilocale:'Trilocale'},subject:'Abbiamo ricevuto la tua richiesta · Paradiso di Nosside',hello:n=>`Grazie ${n}, richiesta ricevuta!`,received:'Abbiamo ricevuto la tua richiesta e ti risponderemo al più presto con tutte le informazioni per il soggiorno.',guests:'Ospiti',important:'Importante:',notice:'questa email conferma soltanto la ricezione della richiesta e non costituisce una conferma di prenotazione.',bye:'A presto'},
    en:{flag:'🇬🇧',label:'English',apt:{bilocale:'One-bedroom apartment',trilocale:'Two-bedroom apartment'},subject:'We received your request · Paradiso di Nosside',hello:n=>`Thank you ${n}, request received!`,received:'We have received your request and will get back to you as soon as possible with all the information for your stay.',guests:'Guests',important:'Important:',notice:'this email only confirms receipt of your request and does not constitute a booking confirmation.',bye:'See you soon'},
    fr:{flag:'🇫🇷',label:'Français',apt:{bilocale:'Appartement 1 chambre',trilocale:'Appartement 2 chambres'},subject:'Nous avons reçu votre demande · Paradiso di Nosside',hello:n=>`Merci ${n}, demande reçue !`,received:'Nous avons bien reçu votre demande et nous vous répondrons au plus vite avec toutes les informations pour votre séjour.',guests:'Voyageurs',important:'Important :',notice:'cet e-mail confirme uniquement la réception de votre demande et ne constitue pas une confirmation de réservation.',bye:'À bientôt'},
    de:{flag:'🇩🇪',label:'Deutsch',apt:{bilocale:'Apartment mit 1 Schlafzimmer',trilocale:'Apartment mit 2 Schlafzimmern'},subject:'Wir haben Ihre Anfrage erhalten · Paradiso di Nosside',hello:n=>`Vielen Dank ${n}, Anfrage erhalten!`,received:'Wir haben Ihre Anfrage erhalten und melden uns so schnell wie möglich mit allen Informationen zu Ihrem Aufenthalt.',guests:'Gäste',important:'Wichtig:',notice:'diese E-Mail bestätigt nur den Eingang Ihrer Anfrage und stellt keine Buchungsbestätigung dar.',bye:'Bis bald'}
  }[normalizeLang(lang)];
}
function normalizeLang(v){ const x=String(v||'').toLowerCase(); return ['it','en','fr','de'].includes(x)?x:'it'; }
function nightsBetween(a,b){ const A=Date.parse(a+'T00:00:00Z'), B=Date.parse(b+'T00:00:00Z'); return Math.round((B-A)/86400000); }
function addDateOnlyDays(s,n){ const d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function money(v){ return Number(v).toFixed(2).replace('.',','); }
function parseMoney(v){ const n=Number(String(v||'').trim().replace(/\s/g,'').replace(',','.')); return Number.isFinite(n)?Math.round(n*100)/100:NaN; }
function makeQuoteId(){ const d=new Date(); return `PDN-${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}-${crypto.randomUUID().slice(0,6).toUpperCase()}`; }
async function signQuote(record, secret){ const payload=utf8ToB64url(JSON.stringify(record)); const sig=await hmac(payload,secret); return `${payload}.${sig}`; }
async function verifyQuote(token, secret){ try{ const [payload,sig]=token.split('.'); if(!payload||!sig)return null; const expected=await hmac(payload,secret); if(!safeEqual(sig,expected))return null; return JSON.parse(b64urlToUtf8(payload)); }catch{return null;} }
async function hmac(text,secret){ const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)); return base64url(new Uint8Array(sig)); }
function utf8ToB64url(s){ return base64url(new TextEncoder().encode(s)); }
function b64urlToUtf8(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; const raw=atob(s); return new TextDecoder().decode(Uint8Array.from(raw,c=>c.charCodeAt(0))); }
function safeEqual(a,b){ if(a.length!==b.length)return false; let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i); return x===0; }
function htmlResponse(body,status=200){ return new Response(body,{status,headers:{'content-type':'text/html;charset=UTF-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'}}); }

async function resendEmail(env, message) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, ...message })
  });
  if (!r.ok) {
    const detail = await r.text();
    console.error('RESEND ERROR:', detail);
    throw new Error('Invio email non riuscito');
  }
}

async function googleToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error('Manca GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!env.GOOGLE_PRIVATE_KEY) throw new Error('Manca GOOGLE_PRIVATE_KEY');
  const now = Math.floor(Date.now() / 1000);
  const enc = o => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg:'RS256', typ:'JWT' }) + '.' + enc({ iss:env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope:'https://www.googleapis.com/auth/calendar', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600 });
  const key = await crypto.subtle.importKey('pkcs8', pem(env.GOOGLE_PRIVATE_KEY), { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const jwt = unsigned + '.' + base64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:jwt }) });
  const d = await r.json();
  if (!r.ok) throw new Error('Google auth failed');
  return d.access_token;
}

function startOfToday() { const n=new Date(); return romeMidnightToUTC(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(n)); }
function dateOnly(d) { return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
function instantToRomeDate(s) { return dateOnly(new Date(s)); }
function instantToRomeDateInclusiveEnd(s) {
  const d = new Date(s);
  const localDate = dateOnly(d);
  const midnight = romeMidnightToUTC(localDate);
  // Google Calendar usa una fine esclusiva per gli eventi all-day.
  // Per la preview del sito consideriamo invece occupato anche il giorno finale.
  if (Math.abs(d.getTime() - midnight.getTime()) < 60000) return addRomeDays(localDate, 1);
  return addRomeDays(localDate, 1);
}
function addRomeDays(ymd, days) {
  const [y,m,d] = ymd.split('-').map(Number);
  const x = new Date(Date.UTC(y,m-1,d));
  x.setUTCDate(x.getUTCDate() + days);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth()+1).padStart(2,'0')}-${String(x.getUTCDate()).padStart(2,'0')}`;
}
function romeMidnightToUTC(ymd) {
  const [y,m,d] = ymd.split('-').map(Number);
  // Iterazione per ricavare l'offset Europe/Rome alla data richiesta.
  let guess = new Date(Date.UTC(y,m-1,d,0,0,0));
  for (let i=0;i<2;i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(guess).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const represented = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
    const target = Date.UTC(y,m-1,d,0,0,0);
    guess = new Date(guess.getTime() + (target-represented));
  }
  return guess;
}
function isDateOnly(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
function pem(s) { const b=s.replace(/\\n/g,'\n').replace(/-----[^-]+-----/g,'').replace(/\s/g,''); const raw=atob(b); return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer; }
function base64url(bytes) { let s=''; bytes.forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function esc(v) { return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function json(x,status=200) { return new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json;charset=UTF-8','cache-control':'no-store'}}); }
