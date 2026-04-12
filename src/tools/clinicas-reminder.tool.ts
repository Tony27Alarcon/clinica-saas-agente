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
        `Ejemplos: "esta tarde" → hora 14:00 del día actual. "mañana a las 10" → 10:00 del día siguiente.`,

    inputSchema: z.object({
        fire_at: z
            .string()
            .describe(
                `Fecha y hora en que el agente debe contactar al usuario. ` +
                `Formato ISO 8601 en hora LOCAL de la clínica (${companyTimezone}). ` +
                `Ejemplo: "2026-04-11T14:00:00". No incluyas offset de timezone.`
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
            });

            logger.info(
                `[Reminder Tool] Recordatorio programado: ${reminder.id} ` +
                `para contactId ${contactId} en ${reminder.fire_at_utc}`
            );

            return {
                ok: true,
                reminder_id: reminder.id,
                fire_at_utc: reminder.fire_at_utc,
                fire_at_local: args.fire_at,
                timezone: companyTimezone,
            };
        } catch (err: any) {
            logger.error(`[Reminder Tool] scheduleReminder error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});
