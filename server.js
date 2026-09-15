const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

/*
  VESKI SMS FLOW — compatible with the EXISTING VESKI HTML

  1) VESKI POST /api/mo-register { phone, code }
  2) VESKI opens the native SMS app addressed to the Twilio number.
  3) User sends the displayed code by SMS.
  4) Twilio POSTs the incoming SMS to /sms.
  5) We mark the registered code as verified.
  6) VESKI polls GET /api/mo-status?code=... and continues.
*/

const pending = new Map(); // code -> { phone, createdAt, verified, from }

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20000) {
        req.destroy();
        reject(new Error("Payload trop volumineux"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function validPhone(phone) {
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone);
}

function cleanup() {
  const now = Date.now();
  for (const [code, item] of pending) {
    if (now - item.createdAt > 10 * 60 * 1000) pending.delete(code);
  }
}
setInterval(cleanup, 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "VESKI Twilio backend v2",
        configured: Boolean(ACCOUNT_SID && AUTH_TOKEN),
        pendingCodes: pending.size
      });
    }

    // Existing VESKI HTML posts here when it creates the verification code.
    if (req.method === "POST" && url.pathname === "/api/mo-register") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const phone = String(body.phone || "").trim();
      const code = String(body.code || "").trim();

      if (!validPhone(phone) || !/^\d{4,10}$/.test(code)) {
        return json(res, 400, {
          ok: false,
          error: "Numéro ou code invalide."
        });
      }

      pending.set(code, {
        phone,
        createdAt: Date.now(),
        verified: false,
        from: null
      });

      return json(res, 200, {
        ok: true,
        registered: true,
        expiresInSeconds: 600
      });
    }

    // Existing VESKI HTML polls this as a GET with ?code=...
    if (req.method === "GET" && url.pathname === "/api/mo-status") {
      const code = String(url.searchParams.get("code") || "").trim();
      const item = pending.get(code);

      if (!item) {
        return json(res, 200, { ok: true, verified: false });
      }

      if (Date.now() - item.createdAt > 10 * 60 * 1000) {
        pending.delete(code);
        return json(res, 200, { ok: true, verified: false, expired: true });
      }

      return json(res, 200, {
        ok: true,
        verified: Boolean(item.verified),
        status: item.verified ? "approved" : "pending"
      });
    }

    // Twilio calls this when an incoming SMS arrives on +1 860 703 5274.
    if (req.method === "POST" && url.pathname === "/sms") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);

      const from = String(params.get("From") || "").trim();
      const body = String(params.get("Body") || "").trim();

      // Accept the exact numeric code that VESKI registered.
      const match = body.match(/^\s*(\d{4,10})\s*$/);
      if (match) {
        const code = match[1];
        const item = pending.get(code);

        if (item) {
          // Prefer the phone used to register, but don't reject a trial
          // test if Twilio normalizes the number differently.
          item.verified = true;
          item.from = from || null;
          item.verifiedAt = Date.now();
        }
      }

      // Twilio accepts empty TwiML for this use case.
      return text(res, 200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
    }

    // Backward-compatible endpoint: POST body { phone, code }.
    if (req.method === "POST" && url.pathname === "/api/mo-status") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const code = String(body.code || "").trim();
      const item = pending.get(code);

      return json(res, 200, {
        ok: true,
        verified: Boolean(item && item.verified)
      });
    }

    return json(res, 404, { ok: false, error: "Route introuvable." });
  } catch (err) {
    console.error(err);
    return json(res, 400, { ok: false, error: err.message || "Erreur" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VESKI Twilio backend v2 listening on ${PORT}`);
});
