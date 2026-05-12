import { Request, Response } from 'express';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { AiService } from '../services/ai.service';
import { KapsoService } from '../services/kapso.service';
import { logger, newRequestId } from '../utils/logger';

const db = () => (supabase as any).schema('clinicas');

/* ── helpers ─────────────────────────────────────────────────────── */

const getDebugPhone = () => env.DEBUG_PHONE_NUMBER || null;
const getDebugCompanyId = () => env.DEBUG_COMPANY_ID || null;

/** Detecta si la company es la plataforma (Bruno) — misma lógica que el webhook. */
function isPlatformCompany(company: any): boolean {
    return company.kind === 'platform' ||
        (!!env.BRUNO_LAB_COMPANY_ID && company.id === env.BRUNO_LAB_COMPANY_ID);
}

/** Resuelve la company para debug: del body, de env, o error. */
async function resolveCompany(companyIdOverride?: string): Promise<any | null> {
    const companyId = companyIdOverride || getDebugCompanyId();
    if (!companyId) return null;

    const { data, error } = await db()
        .from('companies')
        .select('id, name, slug, plan, timezone, currency, active, kind')
        .eq('id', companyId)
        .eq('active', true)
        .maybeSingle();

    if (error || !data) return null;
    return data;
}

/** Resuelve el phoneNumberId del canal de WhatsApp de la company. */
async function resolvePhoneNumberId(companyId: string): Promise<string | null> {
    const { data, error } = await db()
        .from('channels')
        .select('provider_id')
        .eq('company_id', companyId)
        .eq('provider', 'whatsapp')
        .eq('active', true)
        .limit(1)
        .maybeSingle();

    if (error || !data) return null;
    return data.provider_id;
}

/* ── POST /debug/simulate ───────────────────────────────────────── */

/**
 * Simula un mensaje entrante de WhatsApp usando DEBUG_PHONE_NUMBER.
 * El mensaje pasa por el pipeline completo (Steps A→H) y la respuesta
 * llega al WhatsApp real.
 *
 * Body: { text: string, company_id?: string, new_session?: boolean, wait?: boolean }
 */
export async function handleDebugSimulate(req: Request, res: Response) {
    const requestId = newRequestId();

    await logger.runWithContext({ requestId }, async () => {
        try {
            const debugPhone = getDebugPhone();
            if (!debugPhone) {
                res.status(403).json({
                    error: 'debug_disabled',
                    message: 'DEBUG_PHONE_NUMBER no está configurado en .env',
                });
                return;
            }

            const { text, company_id, new_session } = req.body as {
                text?: string;
                company_id?: string;
                new_session?: boolean;
            };

            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                res.status(400).json({
                    error: 'missing_text',
                    message: 'El campo "text" es requerido.',
                });
                return;
            }

            // Resolver company
            const company = await resolveCompany(company_id);
            if (!company) {
                res.status(400).json({
                    error: 'no_company',
                    message: 'No se pudo resolver la company. Configura DEBUG_COMPANY_ID o pasa company_id en el body.',
                });
                return;
            }

            // Resolver phoneNumberId del canal WhatsApp de la company
            const phoneNumberId = await resolvePhoneNumberId(company.id);
            if (!phoneNumberId) {
                res.status(400).json({
                    error: 'no_channel',
                    message: `La company "${company.name}" no tiene un canal WhatsApp activo.`,
                });
                return;
            }

            const startedAt = Date.now();

            const isBruno = isPlatformCompany(company);
            const pipeline = isBruno ? 'superadmin' : 'clinicas';

            logger.info('[Debug] Simulando mensaje', {
                phone: debugPhone,
                companyId: company.id,
                companyName: company.name,
                pipeline,
                text_preview: text.slice(0, 80),
            });

            // ── new_session: borrar contacto para empezar de cero ──
            if (new_session) {
                await ClinicasDbService.deleteContact(company.id, debugPhone);
                logger.info('[Debug] Contacto debug borrado para nueva sesión');
            }

            // Step A: Obtener o crear contacto
            const contact = await ClinicasDbService.getOrCreateContact(
                company.id,
                debugPhone,
                'Debug Simulator'
            );

            // Step B: Obtener agente activo
            const agent = await ClinicasDbService.getActiveAgent(company.id);

            // Step C: Obtener o crear conversación
            const conversation = await ClinicasDbService.getOrCreateConversation(
                company.id,
                contact.id,
                agent.id,
                'whatsapp'
            );

            // Step D: Guardar mensaje entrante
            await ClinicasDbService.saveMessage(
                conversation.id,
                company.id,
                'contact',
                text.trim(),
                { source: 'debug_simulate', phone_number_id: phoneNumberId }
            );

            // Step E: Cargar historial
            const historial = await ClinicasDbService.getHistorial(conversation.id, isBruno ? 30 : 25);

            // Step F: Generar respuesta IA (pipeline auto-detectado)
            let respuesta: string | null;
            if (isBruno) {
                // Pipeline SuperAdmin: resolver staff comercial
                const platformStaff = await ClinicasDbService.listStaff(company.id, false);
                const advisors = platformStaff
                    .filter((s: any) => s.phone)
                    .map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        phone: s.phone,
                        role: s.role || undefined,
                    }));
                const assignedAdvisor = advisors[0] || {
                    id: 'default', name: 'Equipo Bruno Lab', phone: '', role: 'Asesor',
                };

                respuesta = await AiService.generarRespuestaSuperAdmin(
                    historial,
                    { phone: debugPhone, name: 'Debug Simulator' },
                    phoneNumberId,
                    { assignedAdvisor, availableStaff: advisors }
                );
            } else {
                respuesta = await AiService.generarRespuestaClinicas(
                    historial,
                    agent,
                    contact,
                    conversation,
                    phoneNumberId,
                    company,
                    null
                );
            }

            // Step G: Guardar respuesta
            if (respuesta && respuesta.trim()) {
                await ClinicasDbService.saveMessage(
                    conversation.id,
                    company.id,
                    'agent',
                    respuesta
                );
            }

            // Step H: Enviar por Kapso
            let sendError: string | null = null;
            if (respuesta && respuesta.trim()) {
                try {
                    await KapsoService.enviarMensaje(debugPhone, respuesta, phoneNumberId);
                } catch (err) {
                    sendError = String(err);
                    logger.error('[Debug] Fallo al enviar por Kapso', err);
                }
            }

            const durationMs = Date.now() - startedAt;

            res.status(200).json({
                status: 'done',
                pipeline,
                duration_ms: durationMs,
                response: respuesta
                    ? { text: respuesta, type: 'text' }
                    : null,
                conversation_id: conversation.id,
                contact_id: contact.id,
                company: { id: company.id, name: company.name },
                send_error: sendError,
            });
        } catch (error) {
            logger.error('[Debug] Error en simulate', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'debug_error', message: String(error) });
            }
        }
    });
}

/* ── GET /debug/history ─────────────────────────────────────────── */

/**
 * Devuelve los últimos N mensajes del contacto debug.
 *
 * Query params:
 *   - limit: número de mensajes (default 20, max 100)
 *   - company_id: override de la company
 */
export async function handleDebugHistory(req: Request, res: Response) {
    try {
        const debugPhone = getDebugPhone();
        if (!debugPhone) {
            res.status(403).json({
                error: 'debug_disabled',
                message: 'DEBUG_PHONE_NUMBER no está configurado.',
            });
            return;
        }

        const company = await resolveCompany(req.query.company_id as string);
        if (!company) {
            res.status(400).json({
                error: 'no_company',
                message: 'No se pudo resolver la company.',
            });
            return;
        }

        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

        // Buscar contacto debug
        const { data: contact } = await db()
            .from('contacts')
            .select('id, name, phone, status, created_at')
            .eq('company_id', company.id)
            .eq('phone', debugPhone)
            .maybeSingle();

        if (!contact) {
            res.json({ status: 'ok', messages: [], contact: null, conversation: null });
            return;
        }

        // Buscar conversación activa (channel='whatsapp')
        const { data: conversation } = await db()
            .from('conversations')
            .select('id, channel, created_at')
            .eq('company_id', company.id)
            .eq('contact_id', contact.id)
            .eq('channel', 'whatsapp')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!conversation) {
            res.json({ status: 'ok', messages: [], contact, conversation: null });
            return;
        }

        // Mensajes de la conversación
        const { data: messages } = await db()
            .from('messages')
            .select('id, role, content, metadata, created_at')
            .eq('conversation_id', conversation.id)
            .order('created_at', { ascending: false })
            .limit(limit);

        const orderedMessages = (messages ?? []).reverse();

        res.json({
            status: 'ok',
            conversation_id: conversation.id,
            contact,
            company: { id: company.id, name: company.name },
            message_count: orderedMessages.length,
            messages: orderedMessages.map((m: any) => ({
                role: m.role,
                content: m.content,
                created_at: m.created_at,
            })),
        });
    } catch (error) {
        logger.error('[Debug] Error en history', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'history_error', message: String(error) });
        }
    }
}

/* ── POST /debug/reset ──────────────────────────────────────────── */

/**
 * Borra el contacto debug y toda su data asociada (conversaciones, mensajes).
 * Útil para pruebas de onboarding desde cero.
 *
 * Body (opcional): { company_id?: string }
 */
export async function handleDebugReset(req: Request, res: Response) {
    try {
        const debugPhone = getDebugPhone();
        if (!debugPhone) {
            res.status(403).json({
                error: 'debug_disabled',
                message: 'DEBUG_PHONE_NUMBER no está configurado.',
            });
            return;
        }

        const company = await resolveCompany(req.body?.company_id);
        if (!company) {
            res.status(400).json({
                error: 'no_company',
                message: 'No se pudo resolver la company.',
            });
            return;
        }

        const deleted = await ClinicasDbService.deleteContact(company.id, debugPhone);

        logger.info('[Debug] Reset completado', { phone: debugPhone, companyId: company.id, deleted });

        res.json({
            status: 'ok',
            phone: debugPhone,
            company: { id: company.id, name: company.name },
            deleted,
        });
    } catch (error) {
        logger.error('[Debug] Error en reset', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'reset_error', message: String(error) });
        }
    }
}
