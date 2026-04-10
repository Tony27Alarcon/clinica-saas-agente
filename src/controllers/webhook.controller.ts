import { Request, Response } from 'express';
import { DbService } from '../services/db.service';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { AiService } from '../services/ai.service';
import { KapsoService } from '../services/kapso.service';
import { MediaService } from '../services/media.service';
import { NotificationService } from '../services/notification.service';
import { logger, newRequestId, getContext, toErrorMessage } from '../utils/logger';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { normalizePhone } from '../utils/phone';

/**
 * Tipos de mensaje que NO se pueden marcar como leídos en Meta (devuelven
 * error #100 "Invalid parameter"). Los filtramos antes de llamar a markRead
 * para no contaminar los logs con errores que no son la causa real de nada.
 */
const UNREADABLE_MESSAGE_TYPES = new Set(['unsupported', 'unknown', 'system']);

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

        logger.info(`📥 Webhook recibido`, {
            tipo: messageType,
            from,
            preview: typeof text === 'string' ? text.substring(0, 60) : '[no-text]',
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
            logger.info(`[Clinicas] Tenant identificado: "${clinicaCompany.name}" (${clinicaCompany.id})`);
            await WebhookController.processClinicasEvent({
                event, company: clinicaCompany,
                from, senderName, text, phoneNumberId, messageId, messageType,
                safeKapsoUrl, metaDirectUrl, mediaId,
            });
            return;
        }

        // ------------------------------------------------------------------
        // 3. Filtros tempranos (pipeline público existente — sin cambios)
        // ------------------------------------------------------------------

        // 3a. Si no hay remitente ni contenido, es un evento de estado (visto,
        //     entregado) o inválido — lo descartamos sin ruido.
        if (!from || (!text && !safeKapsoUrl && !metaDirectUrl && !mediaId)) {
            logger.debug('Evento ignorado (estado o datos incompletos)');
            return;
        }

        // 3b. Mensajes "unsupported" / "unknown" llegan cuando el usuario manda
        //     algo que Meta no sabe procesar (stickers raros, mensajes editados
        //     que se esfumaron, etc.). Si igual los procesamos, le mandamos al
        //     LLM un placeholder vacío y desperdiciamos una llamada a Gemini.
        //     Mejor responder algo amable y cortar.
        if (UNREADABLE_MESSAGE_TYPES.has(messageType)) {
            logger.warn(
                `Mensaje tipo "${messageType}" no procesable por la IA. Respondiendo con fallback amable.`
            );
            try {
                await KapsoService.enviarMensaje(
                    from,
                    'Recibí tu mensaje pero no pude visualizarlo bien 😅. ¿Podrías escribirlo como texto, foto o audio? Así te ayudo mejor.',
                    phoneNumberId
                );
            } catch (err) {
                logger.error(
                    'No se pudo enviar el fallback para mensaje unsupported',
                    err
                );
            }
            return;
        }

        // 3c. Confirmación de lectura (fire-and-forget, NO bloquea el pipeline).
        //     Solo para tipos legibles — los unsupported ya cortaron arriba.
        if (messageId) {
            KapsoService.marcarComoLeido(messageId, phoneNumberId).catch((err) =>
                logger.error('marcarComoLeido falló', err, { messageId })
            );
        }

        // 3d. Detección de SOPORTE: si quien escribe es el equipo de soporte
        //     (env.SUPPORT_PHONE_NUMBER), aprovechamos la ventana de 24h
        //     reabierta para flushear las notificaciones de error pendientes.
        //     A diferencia de los comerciales, NO bloqueamos el procesamiento
        //     normal: el dev de soporte puede ser también un contacto/cliente
        //     que está testeando a Clara, y queremos que su flujo siga.
        //     Fire-and-forget: el flush corre en background.
        if (
            env.SUPPORT_PHONE_NUMBER &&
            DbService.normalizePhone(from) === env.SUPPORT_PHONE_NUMBER
        ) {
            logger.info(`📞 Mensaje del equipo de soporte. Disparando flush del outbox de soporte.`);
            NotificationService.flushPendingForSupport(phoneNumberId).catch((err) =>
                logger.error('flushPendingForSupport falló', err)
            );
        }

        // ------------------------------------------------------------------
        // 3. Detección de comercial: flush silencioso del outbox
        // ------------------------------------------------------------------
        const comercial = await DbService.findComercialByPhone(from);
        if (comercial) {
            logger.info(
                `📨 Mensaje de comercial conocido ${comercial.id} (${
                    comercial.full_name || comercial.phone
                }). Disparando flush del outbox.`
            );
            try {
                const result = await NotificationService.flushPendingForCommercial(
                    comercial.id,
                    comercial.phone || from,
                    phoneNumberId
                );
                if (result.enviados > 0 || result.fallidos > 0) {
                    logger.info(
                        `Outbox flush comercial ${comercial.id}: ${result.enviados} enviados, ${result.fallidos} fallidos`
                    );
                }
            } catch (flushErr) {
                logger.error(
                    `Outbox flush para comercial ${comercial.id} falló`,
                    flushErr
                );
            }
            return; // No procesar como lead.
        }

        // ------------------------------------------------------------------
        // 4. Comandos especiales (testing)
        // ------------------------------------------------------------------
        if (typeof text === 'string' && text.trim().toLowerCase() === '/borrar') {
            logger.info(`🧹 Comando /borrar detectado para ${from}`);
            await DbService.deleteContacto(from);
            await KapsoService.enviarMensaje(
                from,
                "✅ *Historial borrado exitosamente.* El siguiente 'Hola' será tratado como una conversación nueva.",
                phoneNumberId
            );
            return;
        }

        // ------------------------------------------------------------------
        // 5. Pipeline principal (Steps A → G)
        // ------------------------------------------------------------------

        // Step A: Obtener o crear contacto
        const contacto = await logger.stage('A', 'getOrCreateContacto', () =>
            DbService.getOrCreateContacto(from, senderName)
        );
        logger.enrichContext({ contactoId: contacto.id });

        // Step B: Obtener o crear conversación activa
        const { conversacion, agente } = await logger.stage(
            'B',
            'getOrCreateConversacion',
            () => DbService.getOrCreateConversacion(contacto.id, 'CLARA')
        );
        logger.enrichContext({ conversacionId: conversacion.id });

        // ------------------------------------------------------------------
        // 6. Procesamiento de media (si aplica)
        // ------------------------------------------------------------------
        const folder = `contactos/${contacto.id}`;
        let finalMediaUrl = safeKapsoUrl || metaDirectUrl;
        let mediaInfo: Awaited<ReturnType<typeof MediaService.procesarMedia>> | null = null;

        // NO procesar stickers como media (se tratarán como texto)
        const isSticker =
            messageType === 'sticker' || event.message?.sticker || event.sticker;

        if (!isSticker) {
            try {
                if (safeKapsoUrl) {
                    logger.info(`📎 Descargando media via URL segura de Kapso`);
                    mediaInfo = await MediaService.procesarMedia(
                        safeKapsoUrl,
                        folder,
                        undefined,
                        mediaId,
                        phoneNumberId
                    );
                } else if (mediaId) {
                    logger.info(`📎 Descargando media via media_id`);
                    mediaInfo = await MediaService.procesarMediaPorId(
                        mediaId,
                        phoneNumberId,
                        folder
                    );
                } else if (metaDirectUrl) {
                    logger.info(`📎 Descargando media via URL directa Meta (riesgo de 401)`);
                    mediaInfo = await MediaService.procesarMedia(
                        metaDirectUrl,
                        folder,
                        undefined,
                        mediaId,
                        phoneNumberId
                    );
                }
            } catch (mediaErr) {
                // El procesamiento de media NO debe romper el pipeline. Si algo
                // falla, seguimos sin media adjunta y el LLM recibe solo texto.
                logger.error('Procesamiento de media falló, sigo sin media', mediaErr);
                mediaInfo = null;
            }
        }

        if (mediaInfo && mediaInfo.publicUrl) {
            finalMediaUrl = mediaInfo.publicUrl;
            logger.info(`✓ Media subida a Supabase: ${finalMediaUrl}`);

            // Guardar en media_assets (best-effort, no rompe el pipeline si falla)
            try {
                await supabase.from('media_assets').insert([
                    {
                        contacto_id: contacto.id,
                        rol: 'user',
                        kind: mediaInfo.kind,
                        url_publica: finalMediaUrl,
                        metadata: { mime_type: mediaInfo.mimeType },
                    },
                ]);
            } catch (insertErr) {
                logger.error('Insert en media_assets falló', insertErr);
            }
        }

        // Step C: Guardar mensaje entrante
        await logger.stage('C', 'saveMensaje (entrante)', () =>
            DbService.saveMensaje(conversacion.id, text, 'contacto', {
                raw_payload: event,
                media_url: finalMediaUrl,
                mime_type: mediaInfo?.mimeType,
                media_kind: mediaInfo?.kind,
                interactive_payload: interactive,
                message_type: messageType,
                phone_number_id: phoneNumberId,
            })
        );

        // Step D: Cargar historial
        const historial = await logger.stage('D', 'getHistorialMensajes', () =>
            DbService.getHistorialMensajes(conversacion.id, 25)
        );

        // Step E: Generar respuesta IA
        const respuestaAgente = await logger.stage('E', 'AiService.generarRespuesta', () =>
            AiService.generarRespuesta(historial, agente, contacto, conversacion, phoneNumberId)
        );

        // Step F: Enviar vía Kapso (solo si hay texto). Si no hay texto, la IA
        // ya gestionó la respuesta vía herramienta de envío (interactive/media).
        if (respuestaAgente && respuestaAgente.trim()) {
            await logger.stage('F', 'KapsoService.enviarMensaje', async () => {
                logger.info(
                    `📤 Enviando respuesta a Kapso: "${respuestaAgente.substring(0, 80)}${
                        respuestaAgente.length > 80 ? '...' : ''
                    }"`
                );
                await KapsoService.enviarMensaje(from, respuestaAgente, phoneNumberId);
            });

            // Step G: Guardar respuesta en BD
            await logger.stage('G', 'saveMensaje (respuesta)', () =>
                DbService.saveMensaje(conversacion.id, respuestaAgente, 'agente')
            );
        } else {
            logger.info(
                `Step F: sin texto a enviar — la IA gestionó la respuesta vía tool de envío`
            );
        }
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
            logger.debug('[Clinicas] Evento ignorado (estado o datos incompletos)');
            return;
        }

        if (UNREADABLE_MESSAGE_TYPES.has(messageType)) {
            logger.warn(`[Clinicas] Mensaje tipo "${messageType}" no procesable.`);
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
        if (typeof text === 'string' && text.trim().toLowerCase() === '/borrar') {
            logger.info(`[Clinicas] Comando /borrar para ${from}`);
            await ClinicasDbService.deleteContact(company.id, from);
            await KapsoService.enviarMensaje(
                from,
                '✅ *Historial borrado.* El próximo mensaje inicia una conversación nueva.',
                phoneNumberId
            );
            return;
        }

        // ── Admin Agent: detección de staff ─────────────────────────────────────
        const staffMember = await logger.stage('0', 'clinicas.findStaffByPhone', () =>
            ClinicasDbService.findStaffByPhone(company.id, from)
        );
        if (staffMember) {
            logger.info(`[Admin] Staff detectado: "${staffMember.name}" (${staffMember.id})`);
            logger.enrichContext({ staffId: staffMember.id });
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

        // Step D: Guardar mensaje entrante
        await logger.stage('D', 'clinicas.saveMessage (entrante)', () =>
            ClinicasDbService.saveMessage(conversation.id, company.id, 'contact', text || '[media]', {
                raw_payload: event,
                media_url: safeKapsoUrl || metaDirectUrl,
                message_type: messageType,
                phone_number_id: phoneNumberId,
            })
        );

        // Step E: Cargar historial
        const historial = await logger.stage('E', 'clinicas.getHistorial', () =>
            ClinicasDbService.getHistorial(conversation.id, 25)
        );

        // Step F: Generar respuesta IA
        const respuesta = await logger.stage('F', 'clinicas.AiService.generarRespuestaClinicas', () =>
            AiService.generarRespuestaClinicas(historial, agent, contact, conversation, phoneNumberId)
        );

        // Step G: Enviar y guardar respuesta
        if (respuesta && respuesta.trim()) {
            await logger.stage('G', 'clinicas.KapsoService.enviarMensaje', async () => {
                logger.info(`[Clinicas] Enviando respuesta: "${respuesta.substring(0, 80)}${respuesta.length > 80 ? '...' : ''}"`);
                await KapsoService.enviarMensaje(from, respuesta, phoneNumberId);
            });

            await logger.stage('H', 'clinicas.saveMessage (respuesta)', () =>
                ClinicasDbService.saveMessage(conversation.id, company.id, 'agent', respuesta)
            );
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

        // Step G: Enviar y guardar respuesta
        if (respuesta && respuesta.trim()) {
            await logger.stage('G', 'admin.KapsoService.enviarMensaje', async () => {
                logger.info(`[Admin] Enviando respuesta: "${respuesta.substring(0, 80)}${respuesta.length > 80 ? '...' : ''}"`);
                await KapsoService.enviarMensaje(from, respuesta, phoneNumberId);
            });

            await logger.stage('H', 'admin.saveMessage (respuesta)', () =>
                ClinicasDbService.saveMessage(conversation.id, company.id, 'agent', respuesta)
            );
        } else {
            logger.info('[Admin] Step G: sin texto a enviar');
        }
    }

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
