import express from 'express';
import { env } from './config/env';
import { logger, addLogSink } from './utils/logger';
import { LogService } from './services/log.service';
import { WebhookController } from './controllers/webhook.controller';

// ============================================================================
// Wiring del sink de persistencia: cada log emitido por el logger se buffer-ea
// y se inserta en batch en `public.logs_eventos` (Supabase). Esto debe quedar
// configurado ANTES que cualquier otro código emita logs, para no perderlos.
// ============================================================================
addLogSink((entry) => LogService.enqueue(entry));
logger.info('LogService sink registrado', { stats: LogService.stats() });

// ============================================================================
// Handlers globales de errores (CRÍTICO)
// ============================================================================
//
// Sin estos handlers, una promesa rechazada en background (ej: dentro de un
// setTimeout(async () => ...) sin try/catch interno) podía CRASHEAR el proceso
// silenciosamente, llevándose todas las requests en vuelo y dejando contactos
// "en visto sin respuesta". Ahora cualquier error inesperado queda registrado
// como CRITICAL con stack trace completo, y el proceso sigue vivo.
//
// IMPORTANTE: estos handlers son el último resorte. Cualquier código que ya
// sepa cómo manejar un error debe hacerlo localmente con try/catch — esto es
// solo para los que se le escapan a alguien.

process.on('unhandledRejection', (reason, promise) => {
    logger.critical(
        'unhandledRejection: una promesa fue rechazada sin .catch()',
        reason,
        { promise: String(promise) }
    );
});

process.on('uncaughtException', (err, origin) => {
    logger.critical(
        'uncaughtException: excepción síncrona sin try/catch',
        err,
        { origin }
    );
    // Nota: en producción podrías querer hacer process.exit(1) acá y dejar que
    // el orquestador (Railway/Docker) reinicie el proceso. De momento dejamos
    // que siga corriendo para evitar romper requests in-flight, pero si ves
    // muchos uncaughtException seguidos en los logs, considerá reiniciar.
});

// ============================================================================
// Servidor Express
// ============================================================================

const app = express();

// Middlewares
app.use(express.json());

// Main webhook route for Kapso
app.post('/webhook', WebhookController.handleKapsoWebhook);

// Healthcheck / Root
app.get('/', (req, res) => {
    res.send('Mundo SOS Agentes Backend is running! 🚀');
});

// Start server
const PORT = env.PORT;
const server = app.listen(PORT, () => {
    logger.info(`Servidor levantado en puerto ${PORT}`);
    logger.info('Listo para recibir peticiones webhook de Kapso.');
});

// ============================================================================
// Graceful shutdown
// ============================================================================
//
// Cuando Railway/Docker manda SIGTERM (deploy nuevo, restart, OOM kill, etc.),
// Node tiene unos pocos segundos para cerrar limpio. Aprovechamos ese tiempo
// para drenar el buffer del LogService a Supabase, así no perdemos los últimos
// segundos de logs (que suelen ser los más interesantes en una crash).

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Recibido ${signal}, iniciando shutdown gracioso...`);

    // 1. Dejar de aceptar nuevas conexiones HTTP.
    server.close((err) => {
        if (err) logger.error('Error cerrando servidor HTTP', err);
    });

    // 2. Drenar buffer de logs al BD (best-effort, max 5s).
    try {
        await LogService.drain(5000);
    } catch (err) {
        console.error(`[shutdown] LogService.drain falló: ${(err as Error).message}`);
    }

    // 3. Salir.
    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
