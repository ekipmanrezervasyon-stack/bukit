import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { supabaseHealthRoutes } from "./routes/supabase-health.js";
import { studioRoutes } from "./routes/studios.js";
import { equipmentRoutes } from "./routes/equipment.js";
import { authRoutes } from "./routes/auth.js";
import { reservationRoutes } from "./routes/reservations.js";

const app = Fastify({ logger: true });

app.register(cors, { origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN });
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
