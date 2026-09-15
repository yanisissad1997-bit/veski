
const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// VESKI uses codes like: VK-ABCD23
// Keep the state short-lived for this test/prototype.
const pending = new Map();
let lastIncoming = null;

function corsHeaders() {
  let allowed = String(ALLOWED_ORIGIN).trim();
  if (allowed !== "*" && !/^https?:\/\//i.test(allowed)) {
    allowed = "https://" + allowed;
  }
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders()
  });
  res.end(JSON.stringify(data));
}

function sendTwiml(res) {
  res.writeHead(200, {
    "Content-Type": "text/xml; charset=utf-8",
    ...corsHeaders()
  });
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
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

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function validVeskiCode(code) {
  return /^VK-[A-Z0-9]{6}$/.test(code);
}

function extractVeskiCode(text) {
  const raw = String(text || "").toUpperCase();

  // Preferred format: VK-XXXXXX
  const direct = raw.match(/\bVK-[A-Z0-9]{6}\b/);
  if (direct) return direct[0];

  // Be a little forgiving if the hyphen/space was altered by SMS client.
  const compact = raw.match(/\bVK[\s-]?([A-Z0-9]{6})\b/);
  if (compact) return "VK-" + compact[1];

  return null;
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
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, { ok: true });
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    // ------------------------------------------------------------
    // Health
    // ------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "VESKI Twilio backend v4",
        configured: true,
        pendingCodes: pending.size,
        lastIncomingReceived: Boolean(lastIncoming),
        lastIncomingCode: lastIncoming ? lastIncoming.code : null
      });
    }

    // ------------------------------------------------------------
    // VESKI registers the generated VK-XXXXXX code
    // ------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/mo-register") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};

      const phone = String(body.phone || "").trim();
      const code = normalizeCode(body.code);

      if (!validVeskiCode(code)) {
        return sendJson(res, 400, {
          ok: false,
          error: "Code VESKI invalide. Format attendu : VK-XXXXXX."
        });
      }

      pending.set(code, {
        phone,
        createdAt: Date.now(),
        verified: false,
        from: null
      });

      // Handle an extremely fast incoming SMS race.
      if (lastIncoming && lastIncoming.code === code) {
        const item = pending.get(code);
        item.verified = true;
        item.from = lastIncoming.from;
        item.verifiedAt = lastIncoming.at;
      }

      console.log("[VESKI REGISTER]", {
        phone,
        code,
        time: new Date().toISOString()
      });

      return sendJson(res, 200, {
        ok: true,
        registered: true,
        expiresInSeconds: 600
      });
    }

    // ------------------------------------------------------------
    // Existing VESKI frontend polls GET /api/mo-status?code=...
    // ------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/mo-status") {
      const code = normalizeCode(url.searchParams.get("code"));
      let item = pending.get(code);

      // Reconcile with the most recent inbound SMS.
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

      return sendJson(res, 200, {
        ok: true,
        verified: Boolean(item && item.verified),
        status: item && item.verified ? "approved" : "pending"
      });
    }

    // ------------------------------------------------------------
    // Twilio webhook for inbound SMS
    // ------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/sms") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);

      const from = String(params.get("From") || "").trim();
      const body = String(params.get("Body") || "").trim();
      const code = extractVeskiCode(body);

      console.log("[VESKI SMS]", {
        from,
        body,
        code,
        time: new Date().toISOString()
      });

      if (code) {
        lastIncoming = {
          code,
          from,
          at: Date.now()
        };

        const item = pending.get(code);

        if (item) {
          item.verified = true;
          item.from = from || null;
          item.verifiedAt = Date.now();
        } else {
          // Keep it for reconciliation in case the register request
          // and webhook arrived in the opposite order.
          pending.set(code, {
            phone: "",
            createdAt: Date.now(),
            verified: true,
            from: from || null,
            verifiedAt: Date.now()
          });
        }
      }

      // Do not send an automatic SMS reply.
      return sendTwiml(res);
    }

    return sendJson(res, 404, {
      ok: false,
      error: "Route introuvable."
    });

  } catch (error) {
    console.error("[VESKI ERROR]", error);
    return sendJson(res, 400, {
      ok: false,
      error: error.message || "Erreur serveur"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("VESKI Twilio backend v4 listening on " + PORT);
});
