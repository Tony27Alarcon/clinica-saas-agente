import { Request, Response } from 'express';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { AiService } from '../services/ai.service';
import { KapsoService } from '../services/kapso.service';
import { KapsoHistoryImportService } from '../services/kapso-history-import.service';
import { MediaService } from '../services/media.service';
import { MediaPartsService, type GeminiPart } from '../services/media-parts.service';
import { NotificationService } from '../services/notification.service';
import { TestModeService } from '../services/test-mode.service';
import { processTestModeTurn } from '../pipelines/test-mode.pipeline';
import { TEST_MODE_COMMANDS } from '../config/constants';
import { logger, newRequestId, getContext, toErrorMessage } from '../utils/logger';
import { LOG_EVENTS, LOG_REASONS } from '../utils/log-events';
import { env } from '../config/env';

/**
 * Tipos de mensaje que NO se pueden marcar como leídos en Meta (devuelven
 * error #100 "Invalid parameter"). Los filtramos antes de llamar a markRead
 * para no contaminar los logs con errores que no son la causa real de nada.
 */
const UNREADABLE_MESSAGE_TYPES = new Set(['unsupported', 'unknown', 'system']);

/**
 * Normaliza un mensaje para comparación de duplicados:
 * minúsculas, colapsa whitespace, recorta a primeros 200 chars.
 * Mantiene emojis (son señales válidas) pero descarta diferencias triviales.
 */
function normalizeForCompare(s: string): string {
    return (s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 200);
}

/**
 * Detecta si el contacto está enviando el mismo mensaje repetidamente
 * (típicamente otro bot con respuesta automática en bucle).
 *
 * Devuelve true si los últimos `n` mensajes del usuario son idénticos
 * (normalizados) al mensaje entrante actual.
 */
function contactIsRepeating(
    historial: Array<{ role: 'user' | 'assistant'; content: string }>,
    incomingText: string,
    n: number = 2
): boolean {
    const normalizedIncoming = normalizeForCompare(incomingText);
    if (!normalizedIncoming) return false;

    const userMsgs = historial.filter(m => m.role === 'user').slice(-n);
    if (userMsgs.length < n) return false;

    return userMsgs.every(m => normalizeForCompare(m.content) === normalizedIncoming);
}

/**
 * Detecta si el agente ya respondió el mismo contenido recientemente.
 * Si el último assistant message ya es similar al que vamos a enviar, evita
 * mandarlo (señal de que estamos atascados).
 */
function assistantIsRepeating(
    historial: Array<{ role: 'user' | 'assistant'; content: string }>,
    n: number = 2
): boolean {
    const assistantMsgs = historial.filter(m => m.role === 'assistant').slice(-n);
    if (assistantMsgs.length < n) return false;
    const first = normalizeForCompare(assistantMsgs[0].content);
    if (!first) return false;
    return assistantMsgs.every(m => normalizeForCompare(m.content) === first);
}

/**
 * Construye el `content` que se guardará en DB para un mensaje entrante.
 *
 * Antes se guardaba el literal '[media]' cuando no había texto, lo que hacía
 * que el agente IA perdiera completamente el contexto: no sabía si el paciente
 * envió una imagen, una nota de voz, un sticker o un documento.
 *
 * Este helper devuelve contenido descriptivo legible por la IA:
 *   - Texto tal cual si existe (aunque sea caption de imagen).
 *   - Descripción del tipo de media si no hay texto.
 *
 * Si el mensaje tiene texto (o caption), lo preservamos y agregamos el tipo
 * como prefijo entre corchetes, así:
 *   "[Imagen] Mi alergia al látex"
 *   "[Audio] (ver enlace adjunto)"
 *   "[Sticker]"
 */
function buildIncomingContent(
    text: string,
    messageType: string,
    hasMediaUrl: boolean
): string {
    const clean = (text || '').trim();

    const typeLabel = ((): string | null => {
        switch (messageType) {
            case 'image':     return 'Imagen';
            case 'audio':     return 'Nota de voz';
            case 'voice':     return 'Nota de voz';
            case 'video':     return 'Video';
            case 'sticker':   return 'Sticker';
            case 'document':  return 'Documento';
            case 'location':  return 'Ubicación';
            case 'contacts':  return 'Contacto compartido';
            case 'contact':   return 'Contacto compartido';
            case 'reaction':  return 'Reacción';
            case 'media':     return hasMediaUrl ? 'Archivo adjunto' : null;
            default:          return null;
        }
    })();

    if (clean && typeLabel) return `[${typeLabel}] ${clean}`;
    if (clean) return clean;
    if (typeLabel) return `[${typeLabel}]`;
    return '[mensaje vacío]';
}

export class WebhookController {
    /**
     * Procesa el webhook entrante de Kapso.
     *
     * Filosofía de manejo de errores:
     *  - El HTTP response se envía SIEMPRE 200 OK inmediato (Kapso reintenta
     *    si recibe otra cosa, y no queremos amplificar el problema).
     *  - El procesamiento real corre en background dentro de un setTimeout(0).
     *  - Cada evento del batch se procesa en su PROPIO try/catch + contexto.
     *    Si un evento explota, los demás del batch siguen.
     *  - Cualquier excepción que se escape acá igual la atrapan los handlers
     *    globales en index.ts (unhandledRejection / uncaughtException), pero
     *    eso es el último resorte.
     */
    static async handleKapsoWebhook(req: Request, res: Response): Promise<void> {
        try {
            // 0. Validar Secreto del Webhook (Seguridad)
            const secret = req.headers['x-kapso-secret'] || req.body.secret;
            if (env.KAPSO_WEBHOOK_SECRET && secret !== env.KAPSO_WEBHOOK_SECRET) {
                logger.warn('Intento de acceso al webhook con secreto inválido.');
                res.status(401).send('Unauthorized: Secret mismatch');
                return;
            }

            // 1. Normalizar a un array de eventos (Soporte para Batching de Kapso)
            const body = req.body;
            let events: any[] = [];

            if (body.batch === true && Array.isArray(body.data)) {
                events = body.data;
            } else {
                // Si no es batch, tratamos el body (o body.data/payload) como un solo evento
                const singleData = body.data || body.payload || body;
                events = [singleData];
            }

            // Responder 200 inmediatamente para evitar timeouts y reintentos de Kapso
            res.status(200).send('OK');

            // 2. Procesar cada evento secuencialmente en segundo plano.
            //    setTimeout(0) lo desacopla del ciclo de vida de la request HTTP.
            setTimeout(() => {
                WebhookController.processBatch(events).catch((err) => {
                    // Última red de seguridad: si processBatch deja escapar algo
                    // (no debería, porque cada evento tiene su propio try/catch),
                    // queda como CRITICAL para que sea imposible no verlo.
                    logger.critical('processBatch dejó escapar una excepción', err);
                });
            }, 0);
        } catch (error) {
            logger.critical('Error en handleKapsoWebhook (antes de responder)', error);
            res.status(500).send('Internal Server Error');
        }
    }

    /**
     * Procesa un lote de eventos. Cada evento se aísla en su propio contexto
     * de logging (con requestId único) y su propio try/catch, así un evento
     * que explota no afecta a los demás.
     *
     * Cuando un evento explota:
     *  1. Loggeamos CRITICAL con todo el contexto (el AsyncLocalStorage ya
     *     tiene contacto/conv/stage gracias a `enrichContext` durante la
     *     ejecución de processEvent).
     *  2. Notificamos al equipo de soporte por WhatsApp con el detalle.
     *     IMPORTANTE: NO le decimos nada al usuario — para él, el error es
     *     silencioso. Esto es por requerimiento de producto: un texto de
     *     "tengo un pequeño inconveniente" confunde al lead más que ayudar.
     */
    private static async processBatch(events: any[]): Promise<void> {
        for (const event of events) {
            const requestId = newRequestId();
            await logger.runWithContext({ requestId }, async () => {
                try {
                    await WebhookController.processEvent(event);
                } catch (err) {
                    const eventPreview = WebhookController.previewEvent(event);

                    logger.critical(
                        'processEvent falló: el usuario NO recibe respuesta. Notificando a soporte.',
                        err,
                        { eventPreview }
                    );

                    // Notificar al equipo de soporte. Best-effort: notifySupport
                    // no tira excepciones (las absorbe internamente).
                    const phoneNumberId =
                        event?.phone_number_id ||
                        event?.message?.phone_number_id ||
                        event?.conversation?.phone_number_id ||
                        env.KAPSO_PHONE_NUMBER_ID;
                    const body = NotificationService.buildSystemErrorBody({
                        message:
                            'El pipeline se cayó procesando un mensaje. Revisar logs en `logs_eventos` filtrando por el request_id de abajo.',
                        error: err,
                        eventPreview,
                    });

                    // dedupeKey: estable para "el mismo error en el mismo stage".
                    // Incluye el stage del AsyncLocalStorage (qué etapa explotó) +
                    // el mensaje del Error normalizado. NO incluye contacto/conv/
                    // requestId porque queremos que distintos contactos golpeando
                    // el mismo bug compartan el dedup → 1 sola notificación.
                    const stageFromCtx = getContext()?.stage || 'unknown';
                    const errMsg =
                        err instanceof Error
                            ? err.message.replace(/\s+/g, ' ').trim().substring(0, 200)
                            : String(err).substring(0, 200);
                    const dedupeKey = `pipeline:${stageFromCtx}:${errMsg}`;

                    await NotificationService.notifySupport(body, phoneNumberId, {
                        tipo: 'sistema_error',
                        titulo: 'Error en pipeline de Clara',
                        dedupeKey,
                    });
                }
            });
        }
    }

    /**
     * Procesa un único evento webhook. Se asume que ya estamos dentro de un
     * `runWithContext` con el requestId asignado.
     */
    private static async processEvent(event: any): Promise<void> {
        // ------------------------------------------------------------------
        // 1. Extracción de datos del evento (multi-formato)
        // ------------------------------------------------------------------
        const interactive = event.message?.interactive || event.interactive;
        const flowResponse =
            interactive?.nfm_reply?.response_json ||
            interactive?.flow_reply?.response_json;

        const from =
            event.from ||
            event.message?.from ||
            event.sender ||
            event.contact?.phone ||
            event.phone_number;

        const senderName =
            event.senderName ||
            event.name ||
            event.contact?.name ||
            event.conversation?.contact_name ||
            'Desconocido';

        let textBase =
            event.text?.body ||
            event.text ||
            event.body ||
            event.message?.text?.body ||
            event.message?.text ||
            event.message?.button?.text ||
            // Captions de media: WhatsApp permite adjuntar texto a imagen/video/documento.
            // Si no los extraíamos, el mensaje quedaba sin texto y un evento tipado
            // 'unsupported'/'unknown' con caption útil caía al fallback "no pude visualizarlo".
            event.message?.image?.caption ||
            event.message?.video?.caption ||
            event.message?.document?.caption ||
            event.message?.audio?.caption ||
            event.image?.caption ||
            event.video?.caption ||
            event.document?.caption ||
            event.audio?.caption ||
            // Soporte para botones interactivos (Reply Buttons)
            event.message?.interactive?.button_reply?.title ||
            event.message?.interactive?.button_reply?.id ||
            event.message?.interactive?.list_reply?.title ||
            event.message?.interactive?.list_reply?.id ||
            event.interactive?.button_reply?.title ||
            event.interactive?.button_reply?.id ||
            event.interactive?.list_reply?.title ||
            event.interactive?.list_reply?.id ||
            (flowResponse ? JSON.stringify(flowResponse) : '') ||
            event.message?.kapso?.content ||
            '';

        const replyContext = event.context || event.message?.context;
        let text = typeof textBase === 'string' ? textBase : String(textBase || '');
        
        // Si el usuario está respondiendo a un mensaje específico (citando), se lo indicamos a la IA
        if (replyContext?.message_id) {
            text = `[Respondiendo a un mensaje anterior] ${text}`.trim();
        }

        // Extraer URLs seguras y directas proveídas por Kapso (enlaces firmados a S3)
        const safeKapsoUrl =
            event.message?.kapso?.media_url ||
            event.message?.kapso?.media_data?.url ||
            event.kapso?.media_url ||
            event.kapso?.media_data?.url ||
            '';

        const metaDirectUrl =
            event.mediaUrl ||
            event.media?.url ||
            event.message?.image?.url ||
            event.message?.audio?.url ||
            event.message?.video?.url ||
            event.message?.document?.url ||
            event.message?.sticker?.url ||
            '';

        // Extraer el media_id como último recurso, preferiremos safeKapsoUrl
        const mediaId =
            event.message?.image?.id ||
            event.message?.audio?.id ||
            event.message?.video?.id ||
            event.message?.document?.id ||
            event.message?.sticker?.id ||
            '';

        const messageId = event.id || event.message?.id;
        const phoneNumberId =
            event.phone_number_id ||
            event.message?.phone_number_id ||
            event.conversation?.phone_number_id ||
            env.KAPSO_PHONE_NUMBER_ID;
        
        if (!phoneNumberId) {
            logger.error('No se pudo determinar el phone_number_id para el evento. Abortando procesamiento.', {
                messageId,
                from,
            });
            return;
        }

        const messageType =
            event.type ||
            event.message?.type ||
            (safeKapsoUrl || metaDirectUrl || mediaId ? 'media' : 'text');

        // Enriquecer el contexto de logging con lo que ya sabemos del evento.
        // A partir de acá, todos los logs llevarán tel/messageId automáticamente.
        logger.enrichContext({ contacto: from, messageId, tipo: messageType });

        logger.event({
            code: LOG_EVENTS.WEBHOOK_RECEIVED,
            outcome: 'ok',
            summary: `Webhook recibido: tipo=${messageType}`,
            data: {
                messageType,
                from,
                hasText: Boolean(typeof text === 'string' && text.trim()),
                hasMedia: Boolean(safeKapsoUrl || metaDirectUrl || mediaId),
            },
        });

        // ------------------------------------------------------------------
        // 2. Routing multi-tenant: ¿pertenece este phoneNumberId a una clínica?
        //
        // Si el wa_phone_number_id está registrado en clinicas.companies, el
        // evento se desvía al pipeline de clínicas y el resto de processEvent
        // no se ejecuta (return temprano).
        // Si no hay match, el pipeline público (Bruno) sigue como siempre.
        // ------------------------------------------------------------------
        const clinicaCompany = await ClinicasDbService.getCompanyByWaPhone(phoneNumberId);
        if (clinicaCompany) {
            logger.event({
                code: LOG_EVENTS.ROUTE_TENANT_MATCHED,
                outcome: 'ok',
                summary: `Tenant identificado: "${clinicaCompany.name}"`,
                data: { companyId: clinicaCompany.id, companyName: clinicaCompany.name, phoneNumberId },
            });

            // Mensajes salientes (enviados desde el móvil o dashboard Kapso):
            // direction='outbound' → solo guardar en DB, nunca invocar IA.
            const direction = event.direction || event.message?.direction;
            if (direction && direction !== 'inbound') {
                logger.event({
                    code: LOG_EVENTS.WEBHOOK_OUTBOUND_SAVED,
                    outcome: 'skipped',
                    reason: LOG_REASONS.OUTBOUND_DIRECTION,
                    summary: `Mensaje saliente (direction="${direction}") guardado sin IA`,
                    data: { direction },
                });
                await WebhookController.processOutgoingEvent(event);
                return;
            }

            // ── Routing SuperAdmin: si la company es la "platform" (Bruno Lab),
            //    despacha al agente SuperAdmin (Bruno comercial/onboarder). Ver
            //    commercial/BRUNO_AGENTE_COMERCIAL.md y doc de roles de agentes.
            const isPlatform =
                clinicaCompany.kind === 'platform' ||
                (env.BRUNO_LAB_COMPANY_ID && clinicaCompany.id === env.BRUNO_LAB_COMPANY_ID);

            if (isPlatform) {
                logger.info(`[SuperAdmin] Canal de plataforma detectado — enrutando a Bruno`);
                await WebhookController.processSuperAdminEvent({
                    event, company: clinicaCompany,
                    from, senderName, text, phoneNumberId, messageId, messageType,
                });
                return;
            }

            await WebhookController.processClinicasEvent({
                event, company: clinicaCompany,
                from, senderName, text, phoneNumberId, messageId, messageType,
                safeKapsoUrl, metaDirectUrl, mediaId,
            });
            return;
        }

        // phoneNumberId no registrado en ninguna clínica — descartamos sin fallback.
        logger.event({
            code: LOG_EVENTS.ROUTE_TENANT_UNKNOWN,
            outcome: 'skipped',
            reason: LOG_REASONS.TENANT_NOT_REGISTERED,
            summary: `phoneNumberId ${phoneNumberId} no pertenece a ninguna clínica; evento descartado`,
            data: { phoneNumberId },
        });
    }

    /**
     * Pipeline de clínicas estéticas (schema `clinicas`).
     *
     * Ejecuta los pasos A→G equivalentes al pipeline público pero contra las
     * tablas del schema `clinicas`. El pipeline público queda intacto.
     *
     * Fase 1 (MVP): calificación y conversación. Sin agendamiento aún.
     */
    private static async processClinicasEvent(ctx: {
        event: any;
        company: any;
        from: string;
        senderName: string;
        text: string;
        phoneNumberId: string;
        messageId: string;
        messageType: string;
        safeKapsoUrl: string;
        metaDirectUrl: string;
        mediaId: string;
    }): Promise<void> {
        const { event, company, from, senderName, text, phoneNumberId, messageId, messageType, safeKapsoUrl, metaDirectUrl, mediaId } = ctx;

        // Filtros tempranos
        if (!from || (!text && !safeKapsoUrl && !metaDirectUrl && !mediaId)) {
            logger.event({
                code: LOG_EVENTS.WEBHOOK_IGNORED_EMPTY,
                outcome: 'noop',
                reason: LOG_REASONS.EMPTY_EVENT,
                summary: 'Evento ignorado: sin remitente o sin texto/media',
                data: { hasFrom: Boolean(from), hasText: Boolean(text), hasMedia: Boolean(safeKapsoUrl || metaDirectUrl || mediaId) },
            });
            return;
        }

        // Solo enviar el fallback "no pude visualizar" cuando el mensaje es REALMENTE
        // unsupported Y no trae texto recuperable. Algunos eventos llegan tipados como
        // 'unsupported' pero contienen body/caption útil — en ese caso seguimos el flujo
        // normal usando ese texto.
        if (UNREADABLE_MESSAGE_TYPES.has(messageType) && !text?.trim()) {
            // Evento estructurado para consumo por IA. Filtrable en logs_eventos
            // por event_code='webhook.fallback.sent' para medir recurrencia y
            // en v_reason_breakdown_7d para ver los tipos reales que caen acá.
            logger.event({
                code: LOG_EVENTS.WEBHOOK_FALLBACK_SENT,
                outcome: 'fallback',
                reason: LOG_REASONS.TYPE_IN_UNREADABLE_SET,
                summary: `Fallback "no pude visualizarlo": tipo=${messageType} sin texto recuperable`,
                data: {
                    messageType,
                    rawType: event.type,
                    innerType: event.message?.type,
                    hasReferral: Boolean(event.message?.referral || event.referral),
                    hasInteractive: Boolean(event.message?.interactive || event.interactive),
                    hasMedia: Boolean(safeKapsoUrl || metaDirectUrl || mediaId),
                    eventKeys: Object.keys(event || {}),
                    innerKeys: event.message ? Object.keys(event.message) : [],
                },
            });
            try {
                await KapsoService.enviarMensaje(
                    from,
                    'Recibí tu mensaje pero no pude visualizarlo bien 😅. ¿Podrías escribirlo como texto o foto?',
                    phoneNumberId
                );
            } catch (err) {
                logger.error('[Clinicas] No se pudo enviar fallback para mensaje unsupported', err);
            }
            return;
        }

        // Confirmación de lectura (fire-and-forget)
        if (messageId) {
            KapsoService.marcarComoLeido(messageId, phoneNumberId).catch((err) =>
                logger.error('[Clinicas] marcarComoLeido falló', err, { messageId })
            );
        }

        // Comando /borrar (testing)
        // Elimina el estado local del contacto y pre-crea una conversación limpia
        // con un mensaje seed para que el Step C5 NO reimporte el historial de Kapso.
        if (typeof text === 'string' && text.trim().toLowerCase() === '/borrar') {
            logger.event({
                code: LOG_EVENTS.PIPELINE_CONTACT_RESET,
                outcome: 'ok',
                summary: `Comando /borrar ejecutado: estado local del contacto reseteado`,
                data: { companyId: company.id },
            });
            await ClinicasDbService.deleteContact(company.id, from);

            // Pre-crear contacto + conversación + seed para bloquear el import de Kapso
            try {
                const freshAgent = await ClinicasDbService.getActiveAgent(company.id);
                const freshContact = await ClinicasDbService.getOrCreateContact(company.id, from, senderName);
                const freshConv = await ClinicasDbService.getOrCreateConversation(
                    company.id, freshContact.id, freshAgent.id, 'whatsapp'
                );
                await ClinicasDbService.saveMessage(
                    freshConv.id, company.id, 'system',
                    '--- Conversación reiniciada por /borrar (historial de Kapso omitido) ---'
                );
            } catch (seedErr) {
                logger.error('[Clinicas] /borrar: no se pudo pre-crear conversación limpia', seedErr);
            }

            await KapsoService.enviarMensaje(
                from,
                '✅ *Historial local borrado.* El próximo mensaje inicia una conversación limpia sin historial previo.',
                phoneNumberId
            );
            return;
        }

        // ── Admin Agent: detección de staff ─────────────────────────────────────
        const staffMember = await logger.stage('0', 'clinicas.findStaffByPhone', () =>
            ClinicasDbService.findStaffByPhone(company.id, from)
        );
        if (staffMember) {
            logger.event({
                code: LOG_EVENTS.ROUTE_ADMIN_DETECTED,
                outcome: 'ok',
                reason: LOG_REASONS.STAFF_MATCHED_BY_PHONE,
                summary: `Staff detectado: "${staffMember.name}"; enrutando a pipeline admin`,
                data: { staffId: staffMember.id, staffName: staffMember.name },
            });
            logger.enrichContext({ staffId: staffMember.id });

            // ── Modo test (/test, /exit, sesión activa) ─────────────────────────
            const cmd = (typeof text === 'string' ? text.trim().toLowerCase() : '');
            const testSession = await TestModeService.getActiveSession(staffMember.id);
            const isTestCommand = cmd === TEST_MODE_COMMANDS.START || cmd === TEST_MODE_COMMANDS.EXIT;

            if (testSession || isTestCommand) {
                // Resolver la conv admin (sin pasar por IA): sólo necesitamos el id
                // para poder inyectar el resumen al cerrar la sesión de test.
                const adminContact = await ClinicasDbService.getOrCreateContact(
                    company.id, from, staffMember.name, 'staff'
                );
                const adminAgent = await ClinicasDbService.getActiveAgent(company.id);
                const adminConv = await ClinicasDbService.getOrCreateConversation(
                    company.id, adminContact.id, adminAgent.id, 'admin'
                );

                const outcome = await processTestModeTurn({
                    event, company, staffMember, session: testSession,
                    adminConversationId: adminConv.id,
                    from, text, phoneNumberId, messageId, messageType,
                });

                if (outcome === 'handled') return;
                // passthrough_admin → el mensaje sigue al pipeline admin normal.
            }

            await WebhookController.processAdminEvent({
                event, company, staffMember,
                from, senderName, text, phoneNumberId, messageId, messageType,
            });
            return;
        }
        // ────────────────────────────────────────────────────────────────────────

        // Step A: Obtener o crear contacto en clinicas.contacts
        const contact = await logger.stage('A', 'clinicas.getOrCreateContact', () =>
            ClinicasDbService.getOrCreateContact(company.id, from, senderName)
        );
        logger.enrichContext({ contactoId: contact.id });

        // Step B: Obtener agente activo de la clínica
        const agent = await logger.stage('B', 'clinicas.getActiveAgent', () =>
            ClinicasDbService.getActiveAgent(company.id)
        );

        // Step C: Obtener o crear conversación abierta
        const conversation = await logger.stage('C', 'clinicas.getOrCreateConversation', () =>
            ClinicasDbService.getOrCreateConversation(company.id, contact.id, agent.id, 'whatsapp')
        );
        logger.enrichContext({ conversacionId: conversation.id });

        // Step C5: Si la conversación no tiene mensajes, importar historial previo de Kapso.
        // Esto le da al agente contexto de conversaciones anteriores (incluyendo mensajes
        // enviados directamente desde el número sin pasar por el agente).
        // NOTA: /borrar pre-crea la conversación con un mensaje seed 'system', por lo que
        // tienesMensajes=true y este import se salta — permitiendo pruebas desde cero.
        const tienesMensajes = await ClinicasDbService.hasMessages(conversation.id);
        if (!tienesMensajes) {
            await logger.stage('C5', 'clinicas.KapsoHistoryImport', () =>
                KapsoHistoryImportService.importarHistorialPrevio(
                    company.id,
                    conversation.id,
                    from,
                    phoneNumberId
                )
            );
        }

        // Step D: Guardar mensaje entrante (con deduplicación por messageId para descartar webhooks duplicados)
        if (messageId) {
            const alreadyProcessed = await ClinicasDbService.hasMessageByKapsoId(messageId);
            if (alreadyProcessed) {
                logger.event({
                    code: LOG_EVENTS.WEBHOOK_DEDUPED,
                    outcome: 'skipped',
                    reason: LOG_REASONS.DUPLICATE_MESSAGE_ID,
                    summary: `messageId ya procesado: evento duplicado descartado`,
                    data: { messageId },
                });
                return;
            }
        }

        const incomingMetadata = {
            raw_payload: event,
            media_url: safeKapsoUrl || metaDirectUrl,
            message_type: messageType,
            phone_number_id: phoneNumberId,
        };
        const incomingContent = buildIncomingContent(
            text,
            messageType,
            Boolean(safeKapsoUrl || metaDirectUrl || mediaId)
        );
        await logger.stage('D', 'clinicas.saveMessage (entrante)', () =>
            messageId
                ? ClinicasDbService.saveMessageDeduped(
                    conversation.id, company.id, 'contact', incomingContent, messageId, incomingMetadata
                )
                : ClinicasDbService.saveMessage(conversation.id, company.id, 'contact', incomingContent, incomingMetadata)
        );

        // Step E: Cargar historial
        const historial = await logger.stage('E', 'clinicas.getHistorial', () =>
            ClinicasDbService.getHistorial(conversation.id, 25)
        );

        // ── Capa 3: Guardarraíles por historial ──────────────────────────────────
        // (a) Si los últimos LOOP_THRESHOLD mensajes consecutivos son todos
        //     'assistant', el agente está enviando mensajes sin que nadie responda
        //     (bug, reminder mal configurado, o loop interno).
        const LOOP_THRESHOLD = 4;
        if (historial.length >= LOOP_THRESHOLD) {
            const tail = historial.slice(-LOOP_THRESHOLD);
            if (tail.every(m => m.role === 'assistant')) {
                logger.event({
                    code: LOG_EVENTS.PIPELINE_LOOP_DETECTED,
                    outcome: 'skipped',
                    reason: LOG_REASONS.ASSISTANT_LOOP_THRESHOLD,
                    summary: `Bucle detectado: últimos ${LOOP_THRESHOLD} mensajes son del agente; silencio`,
                    data: { threshold: LOOP_THRESHOLD },
                });
                return;
            }
        }

        // (b) Detección determinística de bot del otro lado: si los últimos 2
        //     mensajes del usuario son IDÉNTICOS al actual (mismo texto
        //     normalizado), estamos contra una respuesta automática en bucle
        //     (ej. otro agente con auto-reply). Cortamos sin invocar IA.
        //     Nota: el mensaje entrante ya fue guardado en Step D, así que el
        //     historial incluye el actual + los 2 previos = 3 idénticos en total.
        if (text && contactIsRepeating(historial, text, 3)) {
            logger.event({
                code: LOG_EVENTS.PIPELINE_LOOP_DETECTED,
                outcome: 'skipped',
                reason: LOG_REASONS.CONTACT_REPEATING_INPUT,
                summary: 'Loop bot↔bot: últimos 3 mensajes del usuario idénticos; silencio total',
                data: { sampleLen: text.length },
            });
            return;
        }

        // (c) Si los últimos 2 mensajes del agente fueron idénticos, ya estamos
        //     repitiéndonos. Cortar antes de generar otra variación inútil.
        if (assistantIsRepeating(historial, 2)) {
            logger.event({
                code: LOG_EVENTS.PIPELINE_LOOP_DETECTED,
                outcome: 'skipped',
                reason: LOG_REASONS.ASSISTANT_REPEATING_OUTPUT,
                summary: 'Agente repitiéndose: últimos 2 mensajes del assistant idénticos; silencio',
                data: {},
            });
            return;
        }
        // ────────────────────────────────────────────────────────────────────────

        // Step E2: Si el mensaje entrante trae media, construir parts multimodales
        // para que Gemini reciba la imagen/audio/documento nativamente.
        let currentUserParts: GeminiPart[] | null = null;
        const hasIncomingMedia = Boolean(safeKapsoUrl || metaDirectUrl || mediaId);
        const isMediaType = ['image', 'audio', 'voice', 'video', 'document', 'sticker'].includes(messageType);
        if (hasIncomingMedia && isMediaType) {
            currentUserParts = await logger.stage('E2', 'clinicas.MediaParts.buildFromIncoming', () =>
                MediaPartsService.buildFromIncoming(
                    {
                        mediaId: mediaId || undefined,
                        phoneNumberId,
                        url: safeKapsoUrl || metaDirectUrl || undefined,
                        messageType,
                        caption: text || undefined,
                    },
                    `contact-${contact.id}`
                )
            );
        }

        // Step F: Generar respuesta IA (con multimodal si aplica)
        const respuesta = await logger.stage('F', 'clinicas.AiService.generarRespuestaClinicas', () =>
            AiService.generarRespuestaClinicas(historial, agent, contact, conversation, phoneNumberId, company, currentUserParts)
        );

        // Step G/H: Guardar y enviar respuesta
        //   null  = noReply tool activada → silencio total, no guardar, no enviar
        //   ''    = tool interactiva exitosa → ya se envió por la tool
        //   texto = respuesta normal → guardar en DB y enviar por Kapso
        if (respuesta === null) {
            logger.event({
                code: LOG_EVENTS.AI_NOREPLY_DECIDED,
                outcome: 'noop',
                reason: LOG_REASONS.AI_NOREPLY_GUARDRAIL,
                summary: 'noReply tool activada: silencio total, no guardar ni enviar',
            });
        } else if (respuesta && respuesta.trim()) {
            await logger.stage('G', 'clinicas.saveMessage (respuesta)', () =>
                ClinicasDbService.saveMessage(conversation.id, company.id, 'agent', respuesta)
            );

            try {
                await logger.stage('H', 'clinicas.KapsoService.enviarMensaje', async () => {
                    await KapsoService.enviarMensaje(from, respuesta, phoneNumberId);
                });
                logger.event({
                    code: LOG_EVENTS.KAPSO_SEND_OK,
                    outcome: 'ok',
                    summary: `Respuesta enviada al usuario (${respuesta.length} chars)`,
                    data: { responseLength: respuesta.length },
                });
            } catch (sendError) {
                // El mensaje ya fue guardado en DB (step G). El fallo de envío
                // se loguea como error pero no rompe el pipeline.
                logger.event({
                    code: LOG_EVENTS.KAPSO_SEND_FAILED,
                    outcome: 'failed',
                    reason: LOG_REASONS.KAPSO_API_ERROR,
                    summary: 'Fallo al enviar respuesta por Kapso (respuesta ya guardada en DB)',
                    error: sendError,
                    data: { responseLength: respuesta.length },
                });
            }
        } else {
            logger.info('[Clinicas] Step G: sin texto — respuesta gestionada vía tool de envío');
        }
    }

    /**
     * Pipeline del agente admin para staff de clínicas.
     *
     * Corre cuando el número que escribe está en clinicas.staff.phone.
     * Reutiliza las mismas tablas de contacts, conversations y messages
     * con status='staff' y channel='admin' para distinguirlos del pipeline
     * de pacientes. El pipeline de pacientes queda completamente intacto.
     */
    private static async processAdminEvent(ctx: {
        event: any;
        company: any;
        staffMember: any;
        from: string;
        senderName: string;
        text: string;
        phoneNumberId: string;
        messageId: string;
        messageType: string;
    }): Promise<void> {
        const { event, company, staffMember, from, senderName, text, phoneNumberId, messageId, messageType } = ctx;

        if (!from || !text) {
            logger.debug('[Admin] Evento ignorado (sin remitente o texto)');
            return;
        }

        // Confirmación de lectura (fire-and-forget)
        if (messageId) {
            KapsoService.marcarComoLeido(messageId, phoneNumberId).catch((err) =>
                logger.error('[Admin] marcarComoLeido falló', err, { messageId })
            );
        }

        // Step A: Obtener o crear contacto del staff (status='staff')
        const contact = await logger.stage('A', 'admin.getOrCreateContact', () =>
            ClinicasDbService.getOrCreateContact(company.id, from, staffMember.name, 'staff')
        );
        logger.enrichContext({ contactoId: contact.id });

        // Step B: Obtener agente activo (reutilizamos agent.id para la FK de conversación)
        const agent = await logger.stage('B', 'admin.getActiveAgent', () =>
            ClinicasDbService.getActiveAgent(company.id)
        );

        // Step C: Obtener o crear conversación admin
        const conversation = await logger.stage('C', 'admin.getOrCreateConversation', () =>
            ClinicasDbService.getOrCreateConversation(company.id, contact.id, agent.id, 'admin')
        );
        logger.enrichContext({ conversacionId: conversation.id });

        // Step D: Guardar mensaje entrante
        await logger.stage('D', 'admin.saveMessage (entrante)', () =>
            ClinicasDbService.saveMessage(conversation.id, company.id, 'contact', text, {
                raw_payload: event,
                message_type: messageType,
                phone_number_id: phoneNumberId,
                staff_id: staffMember.id,
            })
        );

        // Step E: Cargar historial
        const historial = await logger.stage('E', 'admin.getHistorial', () =>
            ClinicasDbService.getHistorial(conversation.id, 20)
        );

        // Step F: Generar respuesta del agente admin
        const respuesta = await logger.stage('F', 'admin.AiService.generarRespuestaAdmin', () =>
            AiService.generarRespuestaAdmin(historial, staffMember, company, contact, conversation, phoneNumberId)
        );

        // Step G: Guardar respuesta en DB (antes de enviar, mismo criterio que pipeline clínicas)
        if (respuesta && respuesta.trim()) {
            await logger.stage('G', 'admin.saveMessage (respuesta)', () =>
                ClinicasDbService.saveMessage(conversation.id, company.id, 'agent', respuesta)
            );

            try {
                await logger.stage('H', 'admin.KapsoService.enviarMensaje', async () => {
                    logger.info(`[Admin] Enviando respuesta: "${respuesta.substring(0, 80)}${respuesta.length > 80 ? '...' : ''}"`);
                    await KapsoService.enviarMensaje(from, respuesta, phoneNumberId);
                });
            } catch (sendError) {
                logger.error('[Admin] Step H: fallo al enviar por Kapso (respuesta ya guardada en DB)', sendError);
            }
        } else {
            logger.info('[Admin] Step G: sin texto a enviar');
        }
    }

    /**
     * Pipeline SuperAdmin (Bruno) — agente comercial + onboarder de la platform.
     *
     * Se ejecuta cuando el canal inbound corresponde a `companies.kind='platform'`
     * (Bruno Lab). El interlocutor es un PROSPECTO, no un tenant existente.
     * Bruno cumple dos roles en el mismo hilo:
     *  1. Comercial (calificación + cierre).
     *  2. Onboarder: cuando el prospecto acepta, crea el tenant y lo deja operativo.
     *
     * Los mensajes se persisten en la misma conversation (de la company platform),
     * así el hilo del prospecto queda auditado en BD.
     */
    private static async processSuperAdminEvent(ctx: {
        event: any;
        company: any;
        from: string;
        senderName: string;
        text: string;
        phoneNumberId: string;
        messageId: string;
        messageType: string;
    }): Promise<void> {
        const { event, company, from, senderName, text, phoneNumberId, messageId, messageType } = ctx;

        if (!from || !text) {
            logger.debug('[SuperAdmin] Evento ignorado (sin remitente o texto)');
            return;
        }

        // Confirmación de lectura (fire-and-forget)
        if (messageId) {
            KapsoService.marcarComoLeido(messageId, phoneNumberId).catch((err) =>
                logger.error('[SuperAdmin] marcarComoLeido falló', err, { messageId })
            );
        }

        // Equipo comercial que puede recibir notifyStaff. TODO: mover a tabla
        // de config o a clinicas.staff de la company platform con staff_role='admin'.
        // Por ahora leemos el staff de la platform directamente.
        const platformStaff = await ClinicasDbService.listStaff(company.id, false);
        const advisors = platformStaff
            .filter((s: any) => s.phone)
            .map((s: any) => ({
                id:   s.id,
                name: s.name,
                phone: s.phone,
                role: s.role || undefined,
            }));

        if (advisors.length === 0) {
            logger.warn(`[SuperAdmin] La company platform ${company.id} no tiene staff con phone — notifyStaff quedará deshabilitada`);
        }

        const assignedAdvisor = advisors[0] || {
            id: 'default', name: 'Equipo Bruno Lab', phone: '', role: 'Asesor',
        };

        // Step A: contacto del prospecto en la company platform (status='prospecto')
        const contact = await logger.stage('A', 'superadmin.getOrCreateContact', () =>
            ClinicasDbService.getOrCreateContact(company.id, from, senderName)
        );
        logger.enrichContext({ contactoId: contact.id });

        // Step B/C: agente activo de la platform + conversación
        const agent = await logger.stage('B', 'superadmin.getActiveAgent', () =>
            ClinicasDbService.getActiveAgent(company.id)
        );
        const conversation = await logger.stage('C', 'superadmin.getOrCreateConversation', () =>
            ClinicasDbService.getOrCreateConversation(company.id, contact.id, agent.id, 'whatsapp')
        );
        logger.enrichContext({ conversacionId: conversation.id });

        // Step D: guardar mensaje entrante
        if (messageId) {
            const already = await ClinicasDbService.hasMessageByKapsoId(messageId);
            if (already) {
                logger.debug('[SuperAdmin] messageId ya procesado — skip');
                return;
            }
        }
        await logger.stage('D', 'superadmin.saveMessage (entrante)', () =>
            messageId
                ? ClinicasDbService.saveMessageDeduped(
                    conversation.id, company.id, 'contact', text, messageId,
                    { raw_payload: event, message_type: messageType, phone_number_id: phoneNumberId, role: 'prospect' }
                )
                : ClinicasDbService.saveMessage(
                    conversation.id, company.id, 'contact', text,
                    { raw_payload: event, message_type: messageType, phone_number_id: phoneNumberId, role: 'prospect' }
                )
        );

        // Step E: historial
        const historial = await logger.stage('E', 'superadmin.getHistorial', () =>
            ClinicasDbService.getHistorial(conversation.id, 30)
        );

        // Step F: Bruno genera la respuesta
        const respuesta = await logger.stage('F', 'superadmin.AiService.generarRespuestaSuperAdmin', () =>
            AiService.generarRespuestaSuperAdmin(
                historial,
                { phone: from, name: senderName },
                phoneNumberId,
                { assignedAdvisor, availableStaff: advisors }
            )
        );

        // Step G/H: guardar y enviar
        if (respuesta && respuesta.trim()) {
            await logger.stage('G', 'superadmin.saveMessage (respuesta)', () =>
                ClinicasDbService.saveMessage(conversation.id, company.id, 'agent', respuesta)
            );
            try {
                await logger.stage('H', 'superadmin.KapsoService.enviarMensaje', async () => {
                    await KapsoService.enviarMensaje(from, respuesta, phoneNumberId);
                });
            } catch (sendError) {
                logger.error('[SuperAdmin] Fallo al enviar (respuesta ya en DB)', sendError);
            }
        } else {
            logger.info('[SuperAdmin] Sin texto a enviar (tool interactiva)');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Webhook de mensajes SALIENTES (enviados desde el móvil / dashboard Kapso)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Recibe el webhook de Kapso para mensajes salientes (sent_message).
     * Solo guarda el mensaje en DB como `agent`; nunca invoca la IA.
     */
    static async handleOutgoingWebhook(req: Request, res: Response): Promise<void> {
        try {
            const secret = req.headers['x-kapso-secret'] || req.body.secret;
            if (env.KAPSO_WEBHOOK_SECRET && secret !== env.KAPSO_WEBHOOK_SECRET) {
                logger.warn('[Outgoing] Intento de acceso con secreto inválido.');
                res.status(401).send('Unauthorized');
                return;
            }

            const body = req.body;
            let events: any[] = [];

            if (body.batch === true && Array.isArray(body.data)) {
                events = body.data;
            } else {
                events = [body.data || body.payload || body];
            }

            res.status(200).send('OK');

            setTimeout(() => {
                Promise.all(events.map((event) => {
                    const requestId = newRequestId();
                    return logger.runWithContext({ requestId }, () =>
                        WebhookController.processOutgoingEvent(event).catch((err) => {
                            logger.critical('[Outgoing] processOutgoingEvent dejó escapar una excepción', err);
                        })
                    );
                })).catch(() => {});
            }, 0);
        } catch (error) {
            logger.critical('[Outgoing] Error en handleOutgoingWebhook', error);
            res.status(500).send('Internal Server Error');
        }
    }

    /**
     * Procesa un único evento saliente: extrae campos, identifica la clínica
     * y el contacto por el número destinatario, y guarda como `agent`.
     */
    private static async processOutgoingEvent(event: any): Promise<void> {
        // Destinatario = el contacto (paciente) que recibió el mensaje
        const to =
            event.to ||
            event.message?.to ||
            event.recipient ||
            event.contact?.phone ||
            '';

        const text =
            event.text?.body ||
            event.text ||
            event.body ||
            event.message?.text?.body ||
            event.message?.text ||
            event.message?.kapso?.content ||
            '';

        const messageId = event.id || event.message?.id;

        const phoneNumberId =
            event.phone_number_id ||
            event.message?.phone_number_id ||
            event.conversation?.phone_number_id ||
            env.KAPSO_PHONE_NUMBER_ID;

        const messageType =
            event.type ||
            event.message?.type ||
            'text';

        logger.enrichContext({ contacto: to, messageId, tipo: messageType });

        if (!to || !text) {
            logger.debug('[Outgoing] Evento ignorado (sin destinatario o contenido)');
            return;
        }

        if (!phoneNumberId) {
            logger.warn('[Outgoing] Sin phoneNumberId — evento descartado');
            return;
        }

        logger.info(`📤 Saliente recibido`, { to, preview: text.substring(0, 60) });

        const company = await ClinicasDbService.getCompanyByWaPhone(phoneNumberId);
        if (!company) {
            logger.warn(`[Outgoing] phoneNumberId "${phoneNumberId}" no registrado. Descartando.`);
            return;
        }

        // Deduplicación temprana: si ya tenemos este messageId, ignorar
        if (messageId) {
            const alreadyProcessed = await ClinicasDbService.hasMessageByKapsoId(messageId);
            if (alreadyProcessed) {
                logger.info(`[Outgoing] messageId "${messageId}" ya guardado. Ignorando.`);
                return;
            }
        }

        // Obtener o crear contacto y conversación para poder guardar el mensaje
        const contact = await ClinicasDbService.getOrCreateContact(company.id, to, to);
        const agent   = await ClinicasDbService.getActiveAgent(company.id);
        const conversation = await ClinicasDbService.getOrCreateConversation(
            company.id, contact.id, agent.id, 'whatsapp'
        );

        const metadata: Record<string, any> = {
            raw_payload:    event,
            message_type:   messageType,
            phone_number_id: phoneNumberId,
            source:          'outgoing_mobile',
        };

        if (messageId) {
            await ClinicasDbService.saveMessageDeduped(
                conversation.id, company.id, 'agent', text, messageId, metadata
            );
        } else {
            await ClinicasDbService.saveMessage(conversation.id, company.id, 'agent', text, metadata);
        }

        logger.info(`[Outgoing] Mensaje saliente guardado en conv ${conversation.id}`);
    }

    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Genera un preview corto del evento para incluir en logs CRITICAL.
     * Evita volcar el payload completo (que puede ser enorme y tener PII),
     * pero deja suficiente para reproducir el caso en debug.
     */
    private static previewEvent(event: any): Record<string, unknown> {
        try {
            return {
                from: event?.from || event?.message?.from,
                type: event?.type || event?.message?.type,
                messageId: event?.id || event?.message?.id,
                hasInteractive: Boolean(event?.message?.interactive || event?.interactive),
                hasMedia: Boolean(
                    event?.message?.image ||
                        event?.message?.audio ||
                        event?.message?.video ||
                        event?.message?.document
                ),
            };
        } catch (err) {
            return { previewError: toErrorMessage(err) };
        }
    }
}
