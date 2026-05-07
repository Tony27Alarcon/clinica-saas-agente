import express from 'express';
import { env } from './config/env';
import { logger, addLogSink } from './utils/logger';
import { LogService } from './services/log.service';
import { WebhookController } from './controllers/webhook.controller';
import { OAuth2Client } from 'google-auth-library';
import { ClinicasDbService } from './services/clinicas-db.service';
import { PromptRebuildService } from './services/prompt-rebuild.service';
import { ReminderScheduler } from './services/reminder-scheduler.service';

// ============================================================================
// Wiring del sink de persistencia: cada log emitido por el logger se buffer-ea
// y se inserta en batch en `clinicas.logs_eventos` (Supabase). Esto debe quedar
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

// Main webhook route for Kapso (incoming messages)
app.post('/webhook', WebhookController.handleKapsoWebhook);

// Webhook for outgoing messages sent from mobile / Kapso dashboard
app.post('/webhook/outgoing', WebhookController.handleOutgoingWebhook);

// ─── Google OAuth 2.0 (Google Calendar del staff) ────────────────────────────

/**
 * Inicia el flujo OAuth 2.0 de Google Calendar para un staff.
 * El agente admin genera este link y se lo manda al staff por WhatsApp.
 *
 * Query params requeridos:
 *   - staff_id:   UUID del miembro del staff
 *   - company_id: UUID de la clínica
 */
app.get('/auth/google/start', (req, res) => {
    const { staff_id, company_id } = req.query;

    if (!staff_id || !company_id) {
        res.status(400).send('Faltan parámetros: staff_id y company_id son requeridos.');
        return;
    }

    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI) {
        res.status(503).send('Google OAuth no está configurado en este servidor.');
        return;
    }

    const oauth2Client = new OAuth2Client(
        env.GOOGLE_OAUTH_CLIENT_ID,
        env.GOOGLE_OAUTH_CLIENT_SECRET,
        env.GOOGLE_OAUTH_REDIRECT_URI
    );

    const state = Buffer.from(
        JSON.stringify({ staffId: staff_id, companyId: company_id })
    ).toString('base64');

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt:      'consent', // Fuerza siempre el consent screen para garantizar refresh_token
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
            'openid',
        ],
        state,
    });

    res.redirect(authUrl);
});

/**
 * Callback de Google OAuth 2.0.
 * Google redirige aquí tras la autorización del staff.
 */
app.get('/auth/google/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        logger.warn(`[OAuth Callback] Error de Google: ${oauthError}`);
        res.status(400).send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>❌ Acceso cancelado</h2>
            <p>No se conectó Google Calendar. Puedes cerrar esta ventana y pedirle al asistente que te envíe el link nuevamente.</p>
            </body></html>
        `);
        return;
    }

    if (!code || !state) {
        res.status(400).send('Parámetros inválidos.');
        return;
    }

    let staffId: string;
    let companyId: string;
    try {
        const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString('utf8'));
        staffId   = decoded.staffId;
        companyId = decoded.companyId;
        if (!staffId || !companyId) throw new Error('state incompleto');
    } catch (err) {
        logger.warn(`[OAuth Callback] State inválido: ${(err as Error).message}`);
        res.status(400).send('El link de autorización es inválido o expiró.');
        return;
    }

    try {
        const oauth2Client = new OAuth2Client(
            env.GOOGLE_OAUTH_CLIENT_ID,
            env.GOOGLE_OAUTH_CLIENT_SECRET,
            env.GOOGLE_OAUTH_REDIRECT_URI
        );

        const { tokens } = await oauth2Client.getToken(code as string);

        if (!tokens.refresh_token) {
            logger.error(`[OAuth Callback] Google no devolvió refresh_token para staff ${staffId}`);
            res.status(500).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>⚠️ Error de autorización</h2>
                <p>Google no entregó los permisos necesarios. Por favor pide al asistente que te envíe un nuevo link.</p>
                </body></html>
            `);
            return;
        }

        // Extraer email del id_token
        oauth2Client.setCredentials(tokens);
        let email = '';
        if (tokens.id_token) {
            try {
                const ticket  = await oauth2Client.verifyIdToken({ idToken: tokens.id_token });
                const payload = ticket.getPayload();
                email = payload?.email || '';
            } catch (idTokenErr) {
                logger.warn(`[OAuth Callback] No se pudo verificar id_token: ${(idTokenErr as Error).message}`);
            }
        }

        await ClinicasDbService.saveStaffOAuthTokens(staffId, {
            refreshToken: tokens.refresh_token,
            email,
        });

        // Crear/actualizar fila en gcal_config para que el agente de pacientes
        // pueda ver la disponibilidad de este staff sin configuración manual.
        await ClinicasDbService.upsertStaffGCalConfig(staffId, companyId);

        logger.info(`[OAuth Callback] Staff ${staffId} conectó Google Calendar (${email})`);

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px;max-width:480px;margin:0 auto">
            <h2 style="color:#22c55e">✅ ¡Google Calendar conectado!</h2>
            <p>Tu cuenta <strong>${email}</strong> fue vinculada correctamente.</p>
            <p>Desde ahora el asistente puede crear citas en tu calendario automáticamente.</p>
            <p style="color:#6b7280;font-size:14px">Puedes cerrar esta ventana.</p>
            </body></html>
        `);

    } catch (err: any) {
        const detail = err?.response?.data
            ? JSON.stringify(err.response.data)
            : err.message;
        logger.error(`[OAuth Callback] Error intercambiando code: ${detail}`, err);
        res.status(500).send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>❌ Error del servidor</h2>
            <p>No se pudo completar la autorización. Intenta nuevamente más tarde.</p>
            <details style="margin-top:20px;text-align:left;font-size:12px;color:#9ca3af">
              <summary>Detalle técnico</summary>
              <pre>${detail}</pre>
            </details>
            </body></html>
        `);
    }
});

// ─── Kapso Onboarding Callback ──────────────────────────────────────────────

/**
 * Callback que Kapso (o un admin) invoca tras completar el embedded signup.
 * Recibe el phoneNumberId real y lo asocia al canal pendiente de la clínica.
 *
 * POST /webhook/kapso/connect
 * Body: { company_id: UUID, phone_number_id: string, phone_number?: string }
 * Auth: x-internal-secret O x-kapso-secret
 *
 * También acepta query params (para configurar como redirect URL en Kapso):
 * GET /webhook/kapso/connect?company_id=...&phone_number_id=...
 */
app.post('/webhook/kapso/connect', async (req, res) => {
    const secret = req.headers['x-internal-secret'] || req.headers['x-kapso-secret'] || req.body?.secret;
    const validSecret =
        (env.INTERNAL_API_SECRET && secret === env.INTERNAL_API_SECRET) ||
        (env.KAPSO_WEBHOOK_SECRET && secret === env.KAPSO_WEBHOOK_SECRET);

    if (!validSecret) {
        res.status(401).json({ ok: false, error: 'No autorizado' });
        return;
    }

    const companyId = req.body?.company_id;
    const phoneNumberId = req.body?.phone_number_id;
    const phoneNumber = req.body?.phone_number; // E.164 opcional

    if (!companyId || !phoneNumberId) {
        res.status(400).json({ ok: false, error: 'Campos requeridos: company_id, phone_number_id' });
        return;
    }

    try {
        // Verificar que no exista ya otro canal con ese provider_id (evitar duplicados)
        const existing = await ClinicasDbService.getCompanyByWaPhone(phoneNumberId);
        if (existing) {
            if (existing.id === companyId) {
                res.json({ ok: true, already_connected: true, message: 'Canal ya conectado a esta empresa' });
            } else {
                res.status(409).json({ ok: false, error: `phoneNumberId ya asociado a otra empresa: ${existing.name}` });
            }
            return;
        }

        // Buscar canal pendiente de esta company
        const pending = await ClinicasDbService.findPendingChannel({ companyId });
        if (!pending) {
            res.status(404).json({ ok: false, error: `No hay canal pendiente para company ${companyId}` });
            return;
        }

        // Asociar el phoneNumberId real
        await ClinicasDbService.linkChannelToPhone(pending.channelId, phoneNumberId, phoneNumber);

        logger.info(
            `[Kapso Connect] Canal ${pending.channelId} de "${pending.companyName}" ` +
            `conectado con phoneNumberId=${phoneNumberId}`
        );

        res.json({
            ok: true,
            channel_id: pending.channelId,
            company_id: companyId,
            company_name: pending.companyName,
            phone_number_id: phoneNumberId,
            message: 'Canal conectado exitosamente. Los mensajes de WhatsApp ahora se enrutarán a esta clínica.',
        });
    } catch (err: any) {
        logger.error(`[Kapso Connect] Error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Versión GET para uso como redirect URL en el flujo de Kapso
app.get('/webhook/kapso/connect', async (req, res) => {
    const { company_id, phone_number_id, phone_number, secret } = req.query;

    const validSecret =
        (env.INTERNAL_API_SECRET && secret === env.INTERNAL_API_SECRET) ||
        (env.KAPSO_WEBHOOK_SECRET && secret === env.KAPSO_WEBHOOK_SECRET);

    if (!validSecret) {
        res.status(401).send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>❌ No autorizado</h2>
            <p>El link de conexión es inválido o expiró.</p>
            </body></html>
        `);
        return;
    }

    if (!company_id || !phone_number_id) {
        res.status(400).send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>⚠️ Parámetros faltantes</h2>
            <p>Se requiere company_id y phone_number_id.</p>
            </body></html>
        `);
        return;
    }

    try {
        const existing = await ClinicasDbService.getCompanyByWaPhone(phone_number_id as string);
        if (existing && existing.id === company_id) {
            res.send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2 style="color:#22c55e">✅ WhatsApp ya conectado</h2>
                <p>Tu número ya está vinculado a <strong>${existing.name}</strong>.</p>
                <p style="color:#6b7280;font-size:14px">Puedes cerrar esta ventana.</p>
                </body></html>
            `);
            return;
        }

        const pending = await ClinicasDbService.findPendingChannel({ companyId: company_id as string });
        if (!pending) {
            res.status(404).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>⚠️ Canal no encontrado</h2>
                <p>No se encontró un canal pendiente para esta clínica. Contacta soporte.</p>
                </body></html>
            `);
            return;
        }

        await ClinicasDbService.linkChannelToPhone(
            pending.channelId,
            phone_number_id as string,
            phone_number as string | undefined
        );

        logger.info(
            `[Kapso Connect GET] Canal ${pending.channelId} de "${pending.companyName}" ` +
            `conectado con phoneNumberId=${phone_number_id}`
        );

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px;max-width:480px;margin:0 auto">
            <h2 style="color:#22c55e">✅ ¡WhatsApp conectado!</h2>
            <p>El número fue vinculado correctamente a <strong>${pending.companyName}</strong>.</p>
            <p>Los mensajes de WhatsApp ahora serán atendidos por el asistente de tu clínica.</p>
            <p style="color:#6b7280;font-size:14px">Puedes cerrar esta ventana.</p>
            </body></html>
        `);
    } catch (err: any) {
        logger.error(`[Kapso Connect GET] Error: ${err.message}`);
        res.status(500).send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>❌ Error del servidor</h2>
            <p>No se pudo completar la conexión. Intenta nuevamente.</p>
            </body></html>
        `);
    }
});

// ─── Provisioning de clínica (interno) ──────────────────────────────────────

/**
 * Crea las 4 filas mínimas para que una clínica nueva pueda usar el agente:
 * companies, channels, agents, staff.
 *
 * POST /internal/provision-clinic
 * Header: x-internal-secret: <env.INTERNAL_API_SECRET>
 * Body: { name, slug, phoneNumberId, adminPhone, adminName?, plan?, timezone?, currency? }
 */
app.post('/internal/provision-clinic', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (!secret || secret !== env.INTERNAL_API_SECRET) {
        res.status(401).json({ ok: false, error: 'No autorizado' });
        return;
    }

    const { name, slug, phoneNumberId, adminPhone, adminName, plan, timezone, currency } = req.body;
    if (!name || !slug || !phoneNumberId || !adminPhone) {
        res.status(400).json({ ok: false, error: 'Campos requeridos: name, slug, phoneNumberId, adminPhone' });
        return;
    }

    try {
        const result = await ClinicasDbService.provisionClinic({
            name, slug, phoneNumberId, adminPhone, adminName, plan, timezone, currency,
        });
        if (!result.ok) {
            res.status(500).json(result);
            return;
        }
        res.json(result);
    } catch (err: any) {
        logger.error(`[Provision] Error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Prompt Rebuild (interno) ────────────────────────────────────────────────

/**
 * Fuerza la recompilación del system_prompt de una clínica.
 * Solo accesible con el API secret interno para evitar abuso.
 *
 * POST /internal/rebuild-prompt/:companyId
 * Header: x-internal-secret: <env.INTERNAL_API_SECRET>
 */
app.post('/internal/rebuild-prompt/:companyId', async (req, res) => {
    const secret = req.headers['x-internal-secret'];
    if (!secret || secret !== env.INTERNAL_API_SECRET) {
        res.status(401).json({ ok: false, error: 'No autorizado' });
        return;
    }

    const { companyId } = req.params;
    if (!companyId) {
        res.status(400).json({ ok: false, error: 'companyId requerido' });
        return;
    }

    try {
        await PromptRebuildService.rebuildPromptForCompany(companyId);
        res.json({ ok: true, message: `Prompt reconstruido para ${companyId}` });
    } catch (err: any) {
        logger.error(`[PromptRebuild] Error en endpoint: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

// Healthcheck / Root
app.get('/', (req, res) => {
    res.send('Bruno Lab is running! 🚀');
});

// Start server
const PORT = env.PORT;
const server = app.listen(PORT, () => {
    logger.info(`Servidor levantado en puerto ${PORT}`);
    logger.info('Listo para recibir peticiones webhook de Kapso.');

    // Procesar la cola de rebuilds pendientes al arranque (sin bloquear).
    // Captura cambios que ocurrieron mientras la app estaba caída.
    PromptRebuildService.processRebuildQueue().catch(err =>
        logger.warn(`[Startup] processRebuildQueue falló: ${(err as Error).message}`)
    );

    // Scheduler de recordatorios: smart timer que calcula cuándo vence el
    // próximo reminder en vez de hacer polling cada 60s (1,440 queries/día).
    // Cap máximo de 5min para detectar reminders creados externamente.
    ReminderScheduler.start().catch(err =>
        logger.error('[Scheduler] ReminderScheduler.start falló', err)
    );

    logger.info('Scheduler de recordatorios activo (smart timer).');
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

    // 0. Detener smart timer de reminders.
    ReminderScheduler.stop();

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
