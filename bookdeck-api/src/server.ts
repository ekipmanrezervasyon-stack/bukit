import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { supabaseHealthRoutes } from "./routes/supabase-health.js";
import { studioRoutes } from "./routes/studios.js";
import { equipmentRoutes } from "./routes/equipment.js";
import { authRoutes } from "./routes/auth.js";
import { reservationRoutes } from "./routes/reservations.js";

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

const allowedOrigins = String(env.CORS_ORIGIN || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes("*");

app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowAllOrigins) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: false,
  maxAge: 86400
});

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("X-XSS-Protection", "0");
  reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  return payload;
});
app.register(healthRoutes, { prefix: "/api" });
app.register(supabaseHealthRoutes, { prefix: "/api" });
app.register(studioRoutes, { prefix: "/api" });
app.register(equipmentRoutes, { prefix: "/api" });
app.register(authRoutes, { prefix: "/api" });
app.register(reservationRoutes, { prefix: "/api" });

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`bookdeck-api running on ${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
