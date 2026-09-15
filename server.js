const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

async function twilio(path, body) {
  const credentials = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const response = await fetch(`https://verify.twilio.com/v2/Services/${VERIFY_SERVICE_SID}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formEncode(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!response.ok) {
    const err = new Error(data.message || data.raw || `Twilio HTTP ${response.status}`);
    err.status = response.status;
    err.twilio = data;
    throw err;
  }
  return data;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}

function validPhone(phone) {
  // E.164: + followed by 8–15 digits.
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone);
}

function validateConfig() {
  return ACCOUNT_SID && AUTH_TOKEN && VERIFY_SERVICE_SID;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "VESKI Twilio backend",
      configured: Boolean(validateConfig())
    });
  }

  try {
    if (!validateConfig()) {
      return json(res, 500, { ok: false, error: "Variables Twilio manquantes côté serveur." });
    }

    if (req.method === "POST" && url.pathname === "/api/mo-register") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();

      if (!validPhone(phone)) {
        return json(res, 400, {
          ok: false,
          error: "Numéro invalide. Utilise le format international, ex. +33612345678."
        });
      }

      const data = await twilio("/Verifications", {
        To: phone,
        Channel: "sms"
      });

      return json(res, 200, {
        ok: true,
        status: data.status,
        sid: data.sid
      });
    }

    if (req.method === "POST" && url.pathname === "/api/mo-status") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const code = String(body.code || "").trim();

      if (!validPhone(phone) || !/^\d{4,10}$/.test(code)) {
        return json(res, 400, { ok: false, error: "Numéro ou code invalide." });
      }

      const data = await twilio("/VerificationCheck", {
        To: phone,
        Code: code
      });

      return json(res, 200, {
        ok: true,
        verified: data.status === "approved",
        status: data.status
      });
    }

    return json(res, 404, { ok: false, error: "Route introuvable." });
  } catch (err) {
    console.error(err);
    return json(res, err.status && err.status < 500 ? err.status : 500, {
      ok: false,
      error: err.message || "Erreur serveur",
      // Never return Twilio credentials.
      twilioCode: err.twilio && err.twilio.code ? err.twilio.code : undefined
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VESKI Twilio backend listening on 0.0.0.0:${PORT}`);
});
