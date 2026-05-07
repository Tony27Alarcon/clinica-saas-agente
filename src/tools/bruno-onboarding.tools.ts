/**
 * Tools exclusivas de Bruno (agente comercial + onboarder).
 *
 * Alineadas con `commercial/omboarding_tecnico.md` y `commercial/BRUNO_AGENTE_COMERCIAL.md`.
 * NO deben exponerse al agente paciente ni al agente admin de otra clínica.
 *
 * Diseño:
 *   - El `companyId` objetivo NO viene del closure: empieza null y se resuelve
 *     (o se crea) con `start_onboarding`. A partir de ahí, las tools posteriores
 *     reciben el `companyId` como argumento del LLM (porque Bruno lo "recuerda").
 *   - `ownerPhone` y `brunoPhoneNumberId` SÍ vienen del closure — son el contexto
 *     de la conversación de WhatsApp, el LLM no los manipula.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { KapsoService } from '../services/kapso.service';
import { GoogleCalendarService } from '../services/google-calendar.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SLUG_MAX_LEN = 40;

/**
 * Genera un slug URL-friendly: lowercase, sin acentos, kebab-case, <= 40 chars.
 * No verifica unicidad — si colisiona, retry con sufijo numérico.
 */
function toSlug(raw: string): string {
    const base = raw
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return base.slice(0, SLUG_MAX_LEN) || 'clinica';
}

// ─── Tool 1: start_onboarding ───────────────────────────────────────────────

/**
 * Tool: start_onboarding
 *
 * Idempotente: si ya existe una company con un owner cuyo phone coincide con
 * el interlocutor, retorna su estado actual sin duplicar. Si no, crea company +
 * agent placeholder + channel pending + staff owner (todo en `provisionClinic`)
 * y marca al staff como owner.
 *
 * Solo Bruno debería tener acceso a esta tool. El system prompt define CUÁNDO
 * invocarla (intención clara de empezar — ver Fase 4/5 del playbook).
 */
export const createBrunoStartOnboardingTool = (
    ownerPhone: string,
    brunoPhoneNumberId: string
) => tool({
    description:
        'Crea la empresa (tenant) del prospecto e inicializa el onboarding. ' +
        'IDEMPOTENTE — si ya existe una empresa asociada al prospecto, retorna su estado sin duplicar. ' +
        'Invocar SOLO cuando el prospecto haya aceptado explícitamente empezar la implementación ' +
        '("vamos", "empecemos", "dale", "arranquemos"). Requiere al menos name y city.',

    inputSchema: z.object({
        name:         z.string().min(1).max(200).describe('Nombre comercial del consultorio/clínica'),
        city:         z.string().min(1).describe('Ciudad (ej: "Medellín")'),
        country_code: z.string().length(2).describe('ISO-2 (CO, MX, PE, AR, CL, US, ...)'),
        timezone:     z.string().describe('IANA timezone (ej: America/Bogota). Usa defaults por país si no estás seguro.'),
        currency:     z.string().length(3).describe('ISO-4217 (COP, MXN, PEN, ARS, CLP, USD)'),
        owner_name:   z.string().optional().describe('Nombre del tomador de decisión (= owner). Si se omite queda "Administrador".'),
        referred_by_slug: z.string().optional().describe('Slug de la clínica embajadora que refirió al prospecto, si aplica.'),
    }),

    execute: async (args) => {
        try {
            // 1. Idempotencia: ¿ya existe?
            const existing = await ClinicasDbService.findPendingOnboardingByOwner(ownerPhone);
            if (existing) {
                logger.info(`[Bruno Tool] start_onboarding: reutilizando company ${existing.id}`);
                return {
                    ok: true,
                    already_exists: true,
                    company_id: existing.id,
                    slug: existing.slug,
                    onboarding_completed_at: existing.onboarding_completed_at,
                };
            }

            // 2. Provisión nueva
            const slug = toSlug(args.name);
            const provision = await ClinicasDbService.provisionClinic({
                name: args.name,
                slug,
                phoneNumberId: `pending-${ownerPhone}-${Date.now()}`, // placeholder único; se reemplaza al conectar Kapso
                adminPhone: ownerPhone,
                adminName: args.owner_name || 'Administrador',
                plan: 'basico',
                timezone: args.timezone,
                currency: args.currency,
            });

            if (!provision.ok || !provision.companyId || !provision.staffId || !provision.channelId) {
                return { ok: false, error: provision.error || 'No se pudo provisionar la clínica' };
            }

            // 3. Marcar staff como owner + canal como pending
            await ClinicasDbService.setStaffRole(provision.staffId, 'owner');
            await ClinicasDbService.updateChannelConnectionStatus(provision.channelId, 'pending');

            // 4. Referido (opcional) — solo loggeamos; el lookup por slug se hace
            //    desde un proceso batch para no bloquear el onboarding si el slug no matchea.
            if (args.referred_by_slug) {
                logger.info(`[Bruno Tool] start_onboarding: referred_by_slug="${args.referred_by_slug}" (pendiente de resolver a UUID)`);
            }

            logger.info(
                `[Bruno Tool] start_onboarding: company ${provision.companyId} creada ` +
                `(slug=${slug}, owner=${ownerPhone}, channel=${provision.channelId})`
            );

            return {
                ok: true,
                already_exists: false,
                company_id: provision.companyId,
                staff_id:   provision.staffId,
                channel_id: provision.channelId,
                agent_id:   provision.agentId,
                slug,
                next_step: 'send_kapso_connection_link',
            };
        } catch (err: any) {
            logger.error(`[Bruno Tool] start_onboarding error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});


// ─── Tool 2: send_kapso_connection_link ─────────────────────────────────────

/**
 * Tool: send_kapso_connection_link
 *
 * Envía al owner el link de onboarding de Kapso (embedded signup de Meta)
 * con parámetros que correlacionan la conexión al `companyId` recién creado.
 * Al completarse el flow, el webhook recibirá el primer inbound y el backend
 * marcará el canal como `connected`.
 */
export const createBrunoSendKapsoLinkTool = (
    ownerPhone: string,
    brunoPhoneNumberId: string
) => tool({
    description:
        'Envía al prospecto (owner) el link de Kapso para conectar su número de WhatsApp Business. ' +
        'Invocar DESPUÉS de start_onboarding y del bloque 6 del setup conversacional. ' +
        'El sistema detecta la conexión automáticamente cuando el canal reciba su primer webhook.',

    inputSchema: z.object({
        company_id: z.string().uuid().describe('UUID retornado por start_onboarding'),
    }),

    execute: async ({ company_id }) => {
        try {
            if (!env.KAPSO_ONBOARDING_URL) {
                return { ok: false, error: 'KAPSO_ONBOARDING_URL no está configurado en el servidor' };
            }

            const company = await ClinicasDbService.getCompanyById(company_id);
            if (!company) return { ok: false, error: `Company ${company_id} no encontrada` };

            const url = new URL(env.KAPSO_ONBOARDING_URL);
            url.searchParams.set('company_id', company_id);
            url.searchParams.set('slug', company.slug);

            // Construir callback_url para que Kapso notifique el phoneNumberId
            // real tras completar el embedded signup.
            // Fuente de baseUrl: WEBHOOK_BASE_URL (explícita) → GOOGLE_OAUTH_REDIRECT_URI (derivada)
            let serverBaseUrl = env.WEBHOOK_BASE_URL;
            if (!serverBaseUrl && env.GOOGLE_OAUTH_REDIRECT_URI) {
                try {
                    const parsed = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
                    serverBaseUrl = `${parsed.protocol}//${parsed.host}`;
                } catch { /* derivación falló, seguimos sin callback */ }
            }

            if (serverBaseUrl) {
                const callbackUrl = new URL(`${serverBaseUrl}/webhook/kapso/connect`);
                callbackUrl.searchParams.set('company_id', company_id);
                if (env.KAPSO_WEBHOOK_SECRET) {
                    callbackUrl.searchParams.set('secret', env.KAPSO_WEBHOOK_SECRET);
                } else if (env.INTERNAL_API_SECRET) {
                    callbackUrl.searchParams.set('secret', env.INTERNAL_API_SECRET);
                }
                url.searchParams.set('callback_url', callbackUrl.toString());
                url.searchParams.set('webhook_url', `${serverBaseUrl}/webhook`);
            }

            const mensaje =
                `Último paso: conectar tu WhatsApp Business. Toma ~3 minutos.\n\n` +
                `🔗 ${url.toString()}\n\n` +
                `*Qué vas a hacer:*\n` +
                `1. Abre el link (mejor desde computador).\n` +
                `2. Login con la cuenta de Meta/Facebook del negocio.\n` +
                `3. Selecciona el número del consultorio.\n` +
                `4. Autoriza los permisos (mensajes + plantillas).\n\n` +
                `Acá te espero — si algo no entiendes, mándame screenshot. 📸`;

            await KapsoService.enviarMensaje(ownerPhone, mensaje, brunoPhoneNumberId);

            logger.info(`[Bruno Tool] send_kapso_connection_link: enviado a ${ownerPhone} (company ${company_id})`);
            return { ok: true, link_sent: true, to: ownerPhone, url: url.toString() };
        } catch (err: any) {
            logger.error(`[Bruno Tool] send_kapso_connection_link error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});


// ─── Tool 3: connect_google_calendar_owner ──────────────────────────────────

/**
 * Tool: connect_google_calendar_owner
 *
 * Envía al owner un link OAuth para que autorice el acceso del sistema a su
 * Google Calendar. El flujo es idéntico al de createAdminConnectGoogleCalendarTool,
 * pero con companyId y staffId dinámicos (los del tenant recién creado).
 *
 * Requerido ANTES de poder usar `configure_availability`.
 */
export const createBrunoConnectGoogleCalendarTool = (
    ownerPhone: string,
    brunoPhoneNumberId: string
) => tool({
    description:
        'Envía al owner un link para conectar su Google Calendar (OAuth). ' +
        'Invocar cuando el prospecto acepte el paso de disponibilidad. Obligatorio antes de configure_availability.',

    inputSchema: z.object({
        company_id: z.string().uuid(),
        staff_id:   z.string().uuid().describe('UUID del owner retornado por start_onboarding'),
    }),

    execute: async ({ company_id, staff_id }) => {
        try {
            if (!env.GOOGLE_OAUTH_REDIRECT_URI) {
                return { ok: false, error: 'Google OAuth no está configurado en el servidor' };
            }

            let baseUrl = '';
            try {
                const parsed = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
                baseUrl = `${parsed.protocol}//${parsed.host}`;
            } catch {
                baseUrl = env.GOOGLE_OAUTH_REDIRECT_URI.replace('/auth/google/callback', '');
            }

            const startUrl =
                `${baseUrl}/auth/google/start` +
                `?staff_id=${encodeURIComponent(staff_id)}` +
                `&company_id=${encodeURIComponent(company_id)}`;

            const mensaje =
                `Para que tu agenda funcione sin roces, necesito conectar tu Google Calendar.\n\n` +
                `Abre este link y autoriza con tu cuenta de Google:\n${startUrl}\n\n` +
                `Es personal — no lo compartas. Te espero acá. 👀`;

            await KapsoService.enviarMensaje(ownerPhone, mensaje, brunoPhoneNumberId);

            logger.info(`[Bruno Tool] connect_google_calendar_owner: link enviado a ${ownerPhone} (staff ${staff_id})`);
            return { ok: true, link_sent: true, to: ownerPhone };
        } catch (err: any) {
            logger.error(`[Bruno Tool] connect_google_calendar_owner error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});


// ─── Tool 4: configure_availability ─────────────────────────────────────────

/**
 * Tool: configure_availability
 *
 * Modelo invertido: la disponibilidad se define marcando lo OCUPADO.
 * Opera sobre el Google Calendar primario del owner via OAuth. Todos los
 * eventos creados llevan la marca `extendedProperties.private.bruno_managed=true`
 * — por eso solo se pueden modificar/eliminar con esta misma tool (el servicio
 * valida la marca antes de cada patch/delete).
 *
 * Una sola tool con `action` en lugar de cuatro tools distintas, para que el
 * LLM mantenga el contexto entre operaciones del mismo bloque.
 */
export const createBrunoConfigureAvailabilityTool = () => tool({
    description:
        'Gestiona bloques de tiempo OCUPADO en el Google Calendar del owner. ' +
        'La disponibilidad se deduce por contraste: todo lo que NO esté bloqueado es libre. ' +
        'Requiere que el owner haya conectado su Google Calendar (tool connect_google_calendar_owner). ' +
        'Actions: "list" (rango), "create" (nuevo bloque), "update" (cambiar horario/título), "delete" (quitar).',

    inputSchema: z.object({
        company_id: z.string().uuid(),
        staff_id:   z.string().uuid().describe('UUID del owner (staff con staff_role=owner)'),
        action:     z.enum(['list', 'create', 'update', 'delete']),

        // Comunes a create/update
        summary:  z.string().optional().describe('Título del bloque (ej: "Almuerzo", "Cerrado", "Cita privada")'),
        start_at: z.string().optional().describe('ISO 8601 (ej: 2026-05-01T12:00:00-05:00)'),
        end_at:   z.string().optional(),

        // Solo update/delete
        event_id: z.string().optional().describe('ID del evento a modificar/borrar. Obtenlo con action=list.'),

        // Solo list
        range_from: z.string().optional().describe('ISO 8601 — inicio del rango (default: ahora)'),
        range_to:   z.string().optional().describe('ISO 8601 — fin del rango (default: +14d)'),
    }),

    execute: async (args) => {
        try {
            const company = await ClinicasDbService.getCompanyById(args.company_id);
            if (!company) return { ok: false, error: `Company ${args.company_id} no encontrada` };

            const tokens = await ClinicasDbService.getStaffOAuthTokens(args.staff_id);
            if (!tokens?.refreshToken) {
                return { ok: false, error: 'El owner aún no conectó su Google Calendar. Invoca connect_google_calendar_owner primero.' };
            }
            const refreshToken = tokens.refreshToken;
            const timezone = company.timezone || 'America/Bogota';

            switch (args.action) {
                case 'list': {
                    const now = new Date();
                    const timeMin = args.range_from || now.toISOString();
                    const timeMax = args.range_to   || new Date(now.getTime() + 14 * 86_400_000).toISOString();
                    const blocks = await GoogleCalendarService.listBusyBlocks({ refreshToken, timeMin, timeMax });
                    return { ok: true, blocks, total: blocks.length };
                }

                case 'create': {
                    if (!args.summary || !args.start_at || !args.end_at) {
                        return { ok: false, error: 'create requiere summary, start_at y end_at' };
                    }
                    const eventId = await GoogleCalendarService.createBusyBlock({
                        refreshToken, timezone,
                        summary: args.summary,
                        startAt: args.start_at,
                        endAt:   args.end_at,
                    });
                    return { ok: true, event_id: eventId };
                }

                case 'update': {
                    if (!args.event_id) return { ok: false, error: 'update requiere event_id' };
                    await GoogleCalendarService.updateBusyBlock({
                        refreshToken, timezone,
                        eventId:    args.event_id,
                        newSummary: args.summary,
                        newStartAt: args.start_at,
                        newEndAt:   args.end_at,
                    });
                    return { ok: true, event_id: args.event_id };
                }

                case 'delete': {
                    if (!args.event_id) return { ok: false, error: 'delete requiere event_id' };
                    await GoogleCalendarService.deleteBusyBlock(refreshToken, args.event_id);
                    return { ok: true, event_id: args.event_id };
                }

                default:
                    return { ok: false, error: `Action desconocida: ${args.action}` };
            }
        } catch (err: any) {
            logger.error(`[Bruno Tool] configure_availability error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});
