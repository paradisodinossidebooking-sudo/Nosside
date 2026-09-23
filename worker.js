export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // API: verifica disponibilità
      if (url.pathname === "/api/availability" && request.method === "GET") {
        return await checkAvailability(request, env);
      }

      // API: richiesta preventivo
      if (url.pathname === "/api/quote" && request.method === "POST") {
        return await sendQuote(request, env);
      }

      // Tutto il resto = sito statico
      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(error);

      return json(
        { error: "Errore interno del server." },
        500
      );
    }
  }
};


// ======================================================
// DISPONIBILITÀ
// ======================================================

async function checkAvailability(request, env) {

  const url = new URL(request.url);

  const apartment = url.searchParams.get("apartment");
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");

  if (
    !["bilocale", "trilocale"].includes(apartment) ||
    !checkin ||
    !checkout ||
    checkout <= checkin
  ) {
    return json(
      { error: "Parametri non validi." },
      400
    );
  }

  const available = await isAvailable(
    apartment,
    checkin,
    checkout,
    env
  );

  return json({ available });
}


// ======================================================
// CONTROLLO GOOGLE CALENDAR
// ======================================================

async function isAvailable(
  apartment,
  checkin,
  checkout,
  env
) {

  const calendarId =
    apartment === "bilocale"
      ? env.GOOGLE_CALENDAR_ID_BILOCALE
      : env.GOOGLE_CALENDAR_ID_TRILOCALE;

  if (!calendarId) {
    throw new Error("Calendar ID non configurato");
  }

  const token = await getGoogleToken(env);

  const params = new URLSearchParams({
    timeMin: new Date(
      checkin + "T00:00:00+02:00"
    ).toISOString(),

    timeMax: new Date(
      checkout + "T00:00:00+02:00"
    ).toISOString(),

    singleEvents: "true",
    maxResults: "1"
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(calendarId)
    }/events?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Google Calendar:", errorText);

    throw new Error(
      "Google Calendar non raggiungibile"
    );
  }

  const data = await response.json();

  return !(data.items || []).length;
}


// ======================================================
// RICHIESTA PREVENTIVO
// ======================================================

async function sendQuote(request, env) {

  const body = await request.json();

  const required = [
    "name",
    "email",
    "apartment",
    "checkin",
    "checkout",
    "guests"
  ];

  if (required.some(key => !body[key])) {
    return json(
      { error: "Compila tutti i campi obbligatori." },
      400
    );
  }

  if (
    !["bilocale", "trilocale"].includes(body.apartment) ||
    body.checkout <= body.checkin
  ) {
    return json(
      { error: "Dati della prenotazione non validi." },
      400
    );
  }


  // IMPORTANTE:
  // controlliamo di nuovo Calendar prima di inviare la mail.

  const available = await isAvailable(
    body.apartment,
    body.checkin,
    body.checkout,
    env
  );

  if (!available) {
    return json(
      {
        error:
          "Il periodo selezionato non è più disponibile."
      },
      409
    );
  }


  // ====================================================
  // EMAIL
  // ====================================================

  const apartmentName =
    body.apartment === "bilocale"
      ? "Bilocale"
      : "Trilocale";


  const subject =
    `Richiesta preventivo ${apartmentName} · ` +
    `${body.checkin} → ${body.checkout}`;


  const html = `
    <h2>Nuova richiesta dal sito</h2>

    <p>
      <strong>Appartamento:</strong>
      ${escapeHtml(apartmentName)}
      <br>

      <strong>Check-in:</strong>
      ${escapeHtml(body.checkin)}
      <br>

      <strong>Check-out:</strong>
      ${escapeHtml(body.checkout)}
      <br>

      <strong>Ospiti:</strong>
      ${escapeHtml(String(body.guests))}
    </p>

    <p>
      <strong>Nome:</strong>
      ${escapeHtml(body.name)}
      <br>

      <strong>Email:</strong>
      ${escapeHtml(body.email)}
      <br>

      <strong>Telefono:</strong>
      ${escapeHtml(body.phone || "-")}
    </p>

    <p>
      <strong>Messaggio:</strong><br>
      ${escapeHtml(body.message || "-")}
    </p>
  `;


  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${env.RESEND_API_KEY}`,

        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        from: env.MAIL_FROM,

        to: [
          env.MAIL_TO ||
          "paradisodinossidebooking@gmail.com"
        ],

        reply_to: body.email,

        subject,
        html
      })
    }
  );


  if (!response.ok) {

    const errorText =
      await response.text();

    console.error(
      "Errore Resend:",
      errorText
    );

    throw new Error(
      "Invio email non riuscito"
    );
  }


  return json({
    ok: true
  });
}


// ======================================================
// GOOGLE SERVICE ACCOUNT
// ======================================================

async function getGoogleToken(env) {

  if (
    !env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !env.GOOGLE_PRIVATE_KEY
  ) {
    throw new Error(
      "Credenziali Google non configurate"
    );
  }


  const now =
    Math.floor(Date.now() / 1000);


  const header = {
    alg: "RS256",
    typ: "JWT"
  };


  const payload = {
    iss:
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,

    scope:
      "https://www.googleapis.com/auth/calendar.readonly",

    aud:
      "https://oauth2.googleapis.com/token",

    iat: now,

    exp: now + 3600
  };


  const unsigned =
    base64UrlJson(header) +
    "." +
    base64UrlJson(payload);


  const privateKey =
    await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(
        env.GOOGLE_PRIVATE_KEY
      ),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );


  const signature =
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(unsigned)
    );


  const jwt =
    unsigned +
    "." +
    base64Url(
      new Uint8Array(signature)
    );


  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",

        assertion: jwt
      })
    }
  );


  const data =
    await response.json();


  if (!response.ok) {

    console.error(
      "Google authentication error",
      data
    );

    throw new Error(
      "Autenticazione Google fallita"
    );
  }


  return data.access_token;
}


// ======================================================
// HELPERS
// ======================================================

function base64UrlJson(object) {

  return btoa(
    JSON.stringify(object)
  )
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}


function base64Url(array) {

  let string = "";

  array.forEach(
    byte =>
      string +=
      String.fromCharCode(byte)
  );

  return btoa(string)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}


function pemToArrayBuffer(pem) {

  const normalized =
    pem.replace(/\\n/g, "\n");

  const base64 =
    normalized
      .replace(
        /-----BEGIN PRIVATE KEY-----/g,
        ""
      )
      .replace(
        /-----END PRIVATE KEY-----/g,
        ""
      )
      .replace(/\s/g, "");


  const binary =
    atob(base64);


  return Uint8Array.from(
    binary,
    char => char.charCodeAt(0)
  ).buffer;
}


function escapeHtml(value) {

  return String(value)
    .replace(
      /[&<>"']/g,
      char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]
    );
}


function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
