import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { ReminderDbService } from '../services/reminder-db.service';

/**
 * Tool: scheduleReminder
 *
 * Permite al agente programar un contacto futuro proactivo.
 * Al dispararse, el scheduler inyecta el mensaje de contexto
 * y activa el agente sin que el usuario haya escrito nada.
 *
 * Disponible para agente paciente y agente admin.
 *
 * ---
 * Tools adicionales exportadas en este módulo:
 *   - createListRemindersTool   → listar recordatorios pendientes
 *   - createCancelReminderTool  → cancelar un recordatorio pendiente
 */
export const createScheduleReminderTool = (
    companyId: string,
    contactId: string,
    conversationId: string,
    agentType: 'patient' | 'admin',
    companyTimezone: string
) => tool({
    description:
        `Programa un recordatorio para retomar esta conversación en el futuro. ` +
        `Úsala cuando el usuario pida que lo contactes más tarde (ej: "escríbeme esta tarde", ` +
        `"hablamos mañana", "llámame en 2 horas"). ` +
        `Tras llamarla, despide al usuario con un mensaje cálido confirmando cuándo lo contactarás. ` +
        `fire_at debe estar en hora LOCAL de la clínica (timezone: ${companyTimezone}). ` +
        `Ejemplos: "esta tarde" → hora 14:00 del día actual. "mañana a las 10" → 10:00 del día siguiente. ` +
        `Para recordatorios recurrentes, usa el campo rrule con expresión cron de 5 campos.`,

    inputSchema: z.object({
        fire_at: z
            .string()
            .describe(
                `Fecha y hora en que el agente debe contactar al usuario. ` +
                `Formato ISO 8601 en hora LOCAL de la clínica (${companyTimezone}). ` +
                `Ejemplo: "2026-04-11T14:00:00". No incluyas offset de timezone. ` +
                `Para recurrentes, usa la fecha del PRIMER disparo.`
            ),
        message: z
            .string()
            .min(10)
            .max(500)
            .describe(
                'Contexto interno para el agente al activarse. ' +
                'Explica por qué se programa el recordatorio y qué debe hacer. ' +
                'Ej: "El usuario pidió contacto en la tarde para continuar la consulta sobre botox. ' +
                'Debe retomar la conversación proactivamente y ofrecer slots disponibles."'
            ),
        rrule: z
            .string()
            .optional()
            .describe(
                'Expresión cron de 5 campos para recordatorios recurrentes. ' +
                'Formato: "min hora día_mes mes día_sem". ' +
                'Ejemplos: "0 9 * * 1" = cada lunes a las 9am, "0 10 * * 1-5" = lunes a viernes a las 10am. ' +
                'Omitir para recordatorios de una sola vez (one-shot).'
            ),
    }),

    execute: async (args) => {
        try {
            const reminder = await ReminderDbService.create({
                companyId,
                contactId,
                conversationId,
                fireAt: args.fire_at,
                message: args.message,
                agentType,
                companyTimezone,
                rrule: args.rrule,
            });

            const tipoStr = args.rrule ? 'recurrente' : 'one-shot';
            logger.info(
                `[Reminder Tool] Recordatorio ${tipoStr} programado: ${reminder.id} ` +
                `para contactId ${contactId} — local: ${args.fire_at} (${companyTimezone}) → UTC: ${reminder.fire_at_utc}`
            );

            return {
                ok: true,
                reminder_id:  reminder.id,
                fire_at_utc:  reminder.fire_at_utc,
                fire_at_local: args.fire_at,
                timezone:     companyTimezone,
                recurrente:   !!args.rrule,
            };
        } catch (err: any) {
            logger.error(`[Reminder Tool] scheduleReminder error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: listReminders
 *
 * Lista los recordatorios pendientes del contacto actual.
 * Devuelve la hora en el timezone local de la clínica para mostrar al usuario.
 */
export const createListRemindersTool = (
    companyId: string,
    contactId: string,
    companyTimezone: string
) => tool({
    description:
        'Lista los recordatorios pendientes programados para este contacto. ' +
        'Úsala cuando el usuario pregunte "¿qué recordatorios tengo?", ' +
        '"¿cuándo me vas a escribir?", o similar. ' +
        'También úsala antes de cancelar un recordatorio para obtener su ID.',

    inputSchema: z.object({}),

    execute: async () => {
        try {
            const reminders = await ReminderDbService.listPending(companyId, contactId);

            if (reminders.length === 0) {
                return { ok: true, reminders: [], message: 'No hay recordatorios pendientes.' };
            }

            const list = reminders.map((r: any) => ({
                id:             r.id,
                fire_at_local:  ReminderDbService.utcToLocal(r.fire_at, companyTimezone),
                message_preview: r.message.substring(0, 80),
                recurrente:     !!r.rrule,
            }));

            return { ok: true, reminders: list };
        } catch (err: any) {
            logger.error(`[Reminder Tool] listReminders error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: cancelReminder
 *
 * Cancela un recordatorio pendiente por ID.
 * El ID se obtiene previamente con listReminders.
 */
export const createCancelReminderTool = (
    companyId: string,
    _contactId: string
) => tool({
    description:
        'Cancela un recordatorio pendiente. ' +
        'Primero usa listReminders para obtener el ID del recordatorio a cancelar. ' +
        'Úsala cuando el usuario pida cancelar, eliminar o borrar un recordatorio programado.',

    inputSchema: z.object({
        reminder_id: z
            .string()
            .uuid()
            .describe('ID del recordatorio a cancelar. Obtenido previamente con listReminders.'),
    }),

    execute: async ({ reminder_id }) => {
        try {
            const cancelled = await ReminderDbService.cancel(reminder_id, companyId);

            if (cancelled) {
                logger.info(`[Reminder Tool] Recordatorio ${reminder_id} cancelado`);
                return { ok: true, message: 'Recordatorio cancelado correctamente.' };
            } else {
                return {
                    ok: false,
                    message: 'No se encontró el recordatorio o ya fue procesado/cancelado.',
                };
            }
        } catch (err: any) {
            logger.error(`[Reminder Tool] cancelReminder error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});
