import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { KapsoService } from '../services/kapso.service';

/**
 * Tool: searchContacts
 * Busca pacientes/leads de la clínica por nombre, teléfono o estado.
 * companyId viene del closure — el LLM no puede cambiar el tenant.
 */
export const createAdminSearchContactsTool = (companyId: string) => tool({
    description: 'Busca contactos (pacientes o leads) de la clínica. Filtra por nombre (parcial), teléfono exacto o estado del pipeline.',
    inputSchema: z.object({
        name: z.string().optional().describe('Texto parcial del nombre a buscar (case-insensitive)'),
        phone: z.string().optional().describe('Teléfono exacto del contacto'),
        status: z.enum(['prospecto', 'calificado', 'agendado', 'paciente', 'descartado', 'inactivo'])
            .optional()
            .describe('Estado del contacto en el pipeline'),
        limit: z.number().int().min(1).max(50).default(10).describe('Máximo de resultados a retornar'),
    }),
    execute: async (args) => {
        try {
            const results = await ClinicasDbService.searchContacts(
                companyId,
                { name: args.name, phone: args.phone, status: args.status },
                args.limit
            );
            logger.info(`[Admin Tool] searchContacts: ${results.length} resultados`);
            return { ok: true, data: results, total: results.length };
        } catch (err: any) {
            logger.error(`[Admin Tool] searchContacts error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: getUpcomingAppointments
 * Retorna las citas próximas de la clínica (scheduled + confirmed).
 */
export const createAdminGetAppointmentsTool = (companyId: string) => tool({
    description: 'Obtiene las citas programadas y confirmadas de la clínica en los próximos N días.',
    inputSchema: z.object({
        days: z.number().int().min(1).max(30).default(7).describe('Cuántos días hacia adelante revisar'),
    }),
    execute: async (args) => {
        try {
            const appointments = await ClinicasDbService.getUpcomingAppointments(companyId, args.days);
            logger.info(`[Admin Tool] getUpcomingAppointments: ${appointments.length} citas en ${args.days} días`);
            return { ok: true, data: appointments, total: appointments.length };
        } catch (err: any) {
            logger.error(`[Admin Tool] getUpcomingAppointments error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: getFreeSlots
 * Retorna slots de disponibilidad libres para agendar citas.
 * Si la clínica tiene Google Calendar configurado, consulta freebusy en tiempo real.
 * Si no, usa la tabla availability_slots de BD como fallback.
 */
export const createAdminGetFreeSlotsTool = (companyId: string) => tool({
    description: 'Consulta los horarios disponibles para agendar citas. Usa Google Calendar si está configurado, o los slots de la base de datos.',
    inputSchema: z.object({
        treatmentId: z.string().uuid().optional().describe('UUID del tratamiento para filtrar slots compatibles'),
        slotDurationMin: z.number().int().min(15).max(240).optional().describe('Duración del slot en minutos (del tratamiento seleccionado)'),
        limit: z.number().int().min(1).max(50).default(10).describe('Máximo de slots a retornar'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.getFreeSlotsMerged(
                companyId,
                args.treatmentId,
                args.slotDurationMin,
                args.limit
            );
            logger.info(`[Admin Tool] getFreeSlots: ${result.slots.length} slots (source: ${result.source})`);
            return { ok: true, data: result.slots, total: result.slots.length, source: result.source };
        } catch (err: any) {
            logger.error(`[Admin Tool] getFreeSlots error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: updateAppointmentStatus
 * Actualiza el estado de una cita. Verifica ownership antes de operar.
 * Si la cita tiene evento en Google Calendar, lo sincroniza automáticamente.
 */
export const createAdminUpdateAppointmentTool = (companyId: string) => tool({
    description: 'Actualiza el estado de una cita (completada, cancelada, no-show, confirmada, reprogramada). Si se completa, se crean follow-ups automáticamente. Si se cancela o reprograma, se sincroniza con Google Calendar.',
    inputSchema: z.object({
        appointmentId: z.string().uuid().describe('UUID de la cita a actualizar'),
        status: z.enum(['completed', 'no_show', 'cancelled', 'confirmed', 'rescheduled'])
            .describe('Nuevo estado de la cita'),
        notes: z.string().max(500).optional().describe('Notas adicionales sobre la actualización'),
        newStartsAt: z.string().optional().describe('ISO 8601: nueva fecha/hora de inicio (requerido si status=rescheduled)'),
        newEndsAt: z.string().optional().describe('ISO 8601: nueva fecha/hora de fin (requerido si status=rescheduled)'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.updateAppointmentStatus(
                companyId,
                args.appointmentId,
                args.status,
                args.notes,
                args.newStartsAt,
                args.newEndsAt
            );
            logger.info(`[Admin Tool] updateAppointmentStatus: ${args.appointmentId} → ${args.status}`);
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] updateAppointmentStatus error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: getContactSummary
 * Retorna el resumen completo de un contacto: datos, citas recientes e historial.
 */
export const createAdminGetContactSummaryTool = (companyId: string) => tool({
    description: 'Obtiene el resumen completo de un contacto: información de perfil, citas recientes e historial de mensajes.',
    inputSchema: z.object({
        contactId: z.string().uuid().describe('UUID del contacto a consultar'),
    }),
    execute: async (args) => {
        try {
            const summary = await ClinicasDbService.getContactSummary(companyId, args.contactId);
            if (!summary) {
                return { ok: false, error: 'Contacto no encontrado o sin permisos' };
            }
            logger.info(`[Admin Tool] getContactSummary: ${args.contactId}`);
            return { ok: true, data: summary };
        } catch (err: any) {
            logger.error(`[Admin Tool] getContactSummary error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: sendMessageToPatient
 * Envía un mensaje de WhatsApp a un paciente desde el número de la clínica.
 * phoneNumberId viene del closure — el LLM no puede cambiar el canal.
 */
export const createAdminSendMessageToPatientTool = (
    companyId: string,
    phoneNumberId: string
) => tool({
    description: 'Envía un mensaje de WhatsApp a un paciente desde el número de la clínica. Usar solo con confirmación explícita del staff.',
    inputSchema: z.object({
        patientPhone: z.string().describe('Número de teléfono del paciente (formato internacional, ej: 573001234567)'),
        message: z.string().max(1000).describe('Texto del mensaje a enviar al paciente'),
        contactId: z.string().uuid().optional().describe('UUID del contacto (para auditoría)'),
    }),
    execute: async (args) => {
        try {
            await KapsoService.enviarMensaje(args.patientPhone, args.message, phoneNumberId);
            logger.info(`[Admin Tool] sendMessageToPatient: → ${args.patientPhone} (companyId: ${companyId})`);
            return { ok: true, sent: true, to: args.patientPhone };
        } catch (err: any) {
            logger.error(`[Admin Tool] sendMessageToPatient error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: getDailySummary
 * Retorna el resumen del día: citas, leads nuevos, escalaciones y follow-ups pendientes.
 */
export const createAdminGetDailySummaryTool = (companyId: string, timezone: string) => tool({
    description: 'Obtiene el resumen del día: citas programadas para hoy, nuevos leads, conversaciones escaladas y follow-ups pendientes.',
    inputSchema: z.object({}),
    execute: async () => {
        try {
            const summary = await ClinicasDbService.getDailySummary(companyId, timezone);
            logger.info(`[Admin Tool] getDailySummary: ${summary.todayAppointments.length} citas hoy`);
            return { ok: true, data: summary };
        } catch (err: any) {
            logger.error(`[Admin Tool] getDailySummary error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});
