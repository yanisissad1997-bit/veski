const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// VESKI — Twilio backend v3
const pending = new Map();
let lastIncoming = null;

function getCorsHeaders(req) {
  let allowed = String(ALLOWED_ORIGIN).trim();

  if (allowed !== "*" && !/^https?:\/\//i.test(allowed)) {
    allowed = "https://" + allowed;
  }

  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : allowed,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function json(res, req, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...getCorsHeaders(req)
  });

  res.end(JSON.stringify(data));
}

function twiml(res, req) {
  res.writeHead(200, {
    "Content-Type": "text/xml; charset=utf-8",
    ...getCorsHeaders(req)
  });

  res.end(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 20000) {
        reject(new Error("Payload trop volumineux"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function validPhone(phone) {
  return !phone || /^\+[1-9]\d{7,14}$/.test(phone);
}

function extractCode(text) {
  const matches = String(text || "").match(/\b(\d{4,10})\b/g);

  if (!matches) return null;

  return matches[matches.length - 1];
}

function cleanup() {
  const now = Date.now();

  for (const [code, item] of pending.entries()) {
    if (now - item.createdAt > 10 * 60 * 1000) {
      pending.delete(code);
    }
  }

  if (lastIncoming && now - lastIncoming.at > 10 * 60 * 1000) {
    lastIncoming = null;
  }
}

setInterval(cleanup, 60 * 1000).unref();

const server = http.createServer(async (req, res) => {

  // CORS
  if (req.method === "OPTIONS") {
    return json(res, req, 204, { ok: true });
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {

    // --------------------------------------------------
    // HEALTH
    // --------------------------------------------------

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, req, 200, {
        ok: true,
        service: "VESKI Twilio backend v3",
        configured: true,
        pendingCodes: pending.size,
        lastIncomingReceived: Boolean(lastIncoming)
      });
    }

    // --------------------------------------------------
    // VESKI → ENREGISTRER LE CODE
    // --------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/api/mo-register"
    ) {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};

      const phone = String(body.phone || "").trim();
      const code = String(body.code || "").trim();

      if (!/^\d{4,10}$/.test(code)) {
        return json(res, req, 400, {
          ok: false,
          error: "Code invalide."
        });
      }

      if (!validPhone(phone)) {
        return json(res, req, 400, {
          ok: false,
          error: "Numéro invalide."
        });
      }

      pending.set(code, {
        phone: phone,
        createdAt: Date.now(),
        verified: false,
        from: null
      });

      // Si le SMS était déjà arrivé
      if (lastIncoming && lastIncoming.code === code) {
        const item = pending.get(code);

        item.verified = true;
        item.from = lastIncoming.from;
        item.verifiedAt = lastIncoming.at;
      }

      console.log("[VESKI REGISTER]", {
        phone: phone,
        code: code
      });

      return json(res, req, 200, {
        ok: true,
        registered: true,
        expiresInSeconds: 600
      });
    }

    // --------------------------------------------------
    // VESKI → VÉRIFIER LE CODE
    // --------------------------------------------------

    if (
      req.method === "GET" &&
      url.pathname === "/api/mo-status"
    ) {
      const code = String(
        url.searchParams.get("code") || ""
      ).trim();

      let item = pending.get(code);

      // Vérification supplémentaire avec le dernier SMS reçu
      if (lastIncoming && lastIncoming.code === code) {

        if (!item) {

          item = {
            phone: "",
            createdAt: Date.now(),
            verified: true,
            from: lastIncoming.from,
            verifiedAt: lastIncoming.at
          };

          pending.set(code, item);

        } else {

          item.verified = true;
          item.from = lastIncoming.from;
          item.verifiedAt = lastIncoming.at;

        }
      }

      return json(res, req, 200, {
        ok: true,
        verified: Boolean(item && item.verified),
        status:
          item && item.verified
            ? "approved"
            : "pending"
      });
    }

    // --------------------------------------------------
    // TWILIO → RÉCEPTION SMS
    // --------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/sms"
    ) {
      const raw = await readBody(req);

      const params = new URLSearchParams(raw);

      const from = String(
        params.get("From") || ""
      ).trim();

      const body = String(
        params.get("Body") || ""
      ).trim();

      const code = extractCode(body);

      console.log("[VESKI SMS]", {
        from: from,
        body: body,
        code: code,
        time: new Date().toISOString()
      });

      // Si un code numérique est trouvé
      if (code) {

        lastIncoming = {
          code: code,
          from: from,
          at: Date.now()
        };

        const item = pending.get(code);

        if (item) {

          item.verified = true;
          item.from = from || null;
          item.verifiedAt = Date.now();

        } else {

          // Permet de reconnaître le code même
          // si le serveur a redémarré entre temps.
          pending.set(code, {
            phone: "",
            createdAt: Date.now(),
            verified: true,
            from: from || null,
            verifiedAt: Date.now()
          });

        }
      }

      // Réponse Twilio sans SMS automatique
      return twiml(res, req);
    }

    // --------------------------------------------------
    // 404
    // --------------------------------------------------

    return json(res, req, 404, {
      ok: false,
      error: "Route introuvable."
    });

  } catch (error) {

    console.error("[VESKI ERROR]", error);

    return json(res, req, 400, {
      ok: false,
      error: error.message || "Erreur serveur"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "VESKI Twilio backend v3 listening on " + PORT
  );
});
