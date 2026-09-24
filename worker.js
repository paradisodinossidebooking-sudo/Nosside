export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, worker: 'nosside-v3' });
      if (url.pathname === '/api/availability' && request.method === 'GET') return checkAvailability(request, env);
      if (url.pathname === '/api/quote' && request.method === 'POST') return sendQuote(request, env);
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

  // Vista calendario: restituisce i periodi occupati dei prossimi 1-6 mesi.
  if (url.searchParams.get('view') === 'calendar') {
    const months = Math.min(6, Math.max(1, Number(url.searchParams.get('months')) || 3));
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
  const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), timeZone: 'Europe/Rome', items: [{ id: calendarId }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Google Calendar non raggiungibile');
  const cal = data.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error('Google Calendar: accesso al calendario non riuscito');
  return cal?.busy || [];
}

async function sendQuote(request, env) {
  const b = await request.json();
  const required = ['name','email','apartment','checkin','checkout','guests'];
  if (required.some(k => !b[k])) return json({ error: 'Compila tutti i campi obbligatori.' }, 400);
  if (!env.RESEND_API_KEY) throw new Error('Manca RESEND_API_KEY');
  if (!env.MAIL_FROM) throw new Error('Manca MAIL_FROM');

  const subject = `Richiesta preventivo ${b.apartment} · ${b.checkin} → ${b.checkout}`;
  const html = `<h2>Nuova richiesta dal sito</h2><p><b>Appartamento:</b> ${esc(b.apartment)}<br><b>Check-in:</b> ${esc(b.checkin)}<br><b>Check-out:</b> ${esc(b.checkout)}<br><b>Ospiti:</b> ${esc(String(b.guests))}</p><p><b>Nome:</b> ${esc(b.name)}<br><b>Email:</b> ${esc(b.email)}<br><b>Telefono:</b> ${esc(b.phone || '-')}</p><p><b>Messaggio:</b><br>${esc(b.message || '-')}</p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [env.MAIL_TO || 'paradisodinossidebooking@gmail.com'], reply_to: b.email, subject, html })
  });
  if (!r.ok) {
    const detail = await r.text();
    console.error('RESEND ERROR:', detail);
    throw new Error('Invio email non riuscito');
  }
  return json({ ok: true });
}

async function googleToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error('Manca GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!env.GOOGLE_PRIVATE_KEY) throw new Error('Manca GOOGLE_PRIVATE_KEY');
  const now = Math.floor(Date.now() / 1000);
  const enc = o => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg:'RS256', typ:'JWT' }) + '.' + enc({ iss:env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope:'https://www.googleapis.com/auth/calendar.readonly', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600 });
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
