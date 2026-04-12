import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { KapsoService } from '../services/kapso.service';

/**
 * Tool: updateContactProfile
 * Actualiza el perfil del lead/paciente en clinicas.contacts después de
 * recopilar información durante la calificación (Fase 1).
 */
export const createClinicasUpdateContactTool = (contactId: string) => tool({
    description: 'Actualiza el perfil del contacto tras recopilar información de calificación. Llámala cuando descubras el nombre real, el nivel de interés o el email del paciente.',
    inputSchema: z.object({
        status: z
            .enum(['prospecto', 'calificado', 'agendado', 'descartado', 'inactivo'])
            .optional()
            .describe('Estado del lead en el pipeline'),
        temperature: z
            .enum(['frio', 'tibio', 'caliente'])
            .optional()
            .describe('Nivel de interés del lead'),
        name: z
            .string()
            .optional()
            .describe('Nombre real del contacto si lo reveló durante la conversación'),
        email: z
            .string()
            .email()
            .optional()
            .describe('Correo electrónico del contacto'),
    }),
    execute: async (args) => {
        try {
            const updates: Record<string, string> = {};
            if (args.status)      updates.status = args.status;
            if (args.temperature) updates.temperature = args.temperature;
            if (args.name)        updates.name = args.name;
            if (args.email)       updates.email = args.email;

            if (Object.keys(updates).length === 0) {
                return { ok: false, error: 'Sin campos a actualizar' };
            }

            await ClinicasDbService.updateContact(contactId, updates);
            logger.info(`[Clinicas Tool] updateContact: ${JSON.stringify(updates)} → contactId ${contactId}`);
            return { ok: true, updated: updates };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] updateContact error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: getServices
 * Retorna el catálogo de tratamientos activos de la clínica desde la BD.
 * Silenciosa: el agente la usa para responder consultas sobre servicios con
 * datos reales (precios, duración, preparación) en lugar de depender solo del
 * system prompt que puede estar desactualizado.
 */
export const createClinicasGetServicesTool = (companyId: string) => tool({
    description: 'Obtiene el catálogo actualizado de tratamientos y servicios disponibles en la clínica. Úsala cuando el paciente pregunte qué servicios hay, cuánto cuestan, cuánto duran o qué incluyen. También úsala antes de mostrar slots para saber el id del tratamiento que el paciente quiere.',
    inputSchema: z.object({
        category: z
            .string()
            .optional()
            .describe('Filtra por categoría si el paciente ya especificó una (ej: "facial", "corporal"). Si no filtra, retorna todo el catálogo.'),
    }),
    execute: async (args) => {
        try {
            const treatments = await ClinicasDbService.getActiveTreatments(companyId);
            const filtered = args.category
                ? treatments.filter((t: any) =>
                    (t.category || '').toLowerCase().includes(args.category!.toLowerCase())
                )
                : treatments;

            logger.info(`[Clinicas Tool] getServices: ${filtered.length} tratamientos (company: ${companyId})`);
            return { ok: true, total: filtered.length, services: filtered };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] getServices error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: getAvailableSlots
 * Consulta la disponibilidad real desde Google Calendar (o BD como fallback).
 * Silenciosa: el agente presenta los slots al paciente de forma conversacional.
 * SIEMPRE ofrece exactamente 2 opciones, nunca pregunte "¿cuándo puedes?" abierto.
 */
export const createClinicasGetSlotsTool = (companyId: string) => tool({
    description: 'Consulta los horarios disponibles para agendar una cita. Úsala después de que el paciente haya elegido (o mostrado interés en) un tratamiento específico. Retorna slots reales desde Google Calendar o la base de datos.',
    inputSchema: z.object({
        treatment_id: z
            .string()
            .uuid()
            .optional()
            .describe('UUID del tratamiento elegido por el paciente. Obtenlo con getServices primero.'),
        slot_duration_min: z
            .number()
            .int()
            .min(15)
            .max(240)
            .optional()
            .describe('Duración del slot en minutos. Si se omite se usa la duración por defecto del calendario.'),
        limit: z
            .number()
            .int()
            .min(2)
            .max(10)
            .default(4)
            .describe('Cuántos slots traer. Mínimo 4 para poder ofrecer siempre 2 opciones y tener alternativas.'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.getFreeSlotsMerged(
                companyId,
                args.treatment_id,
                args.slot_duration_min,
                args.limit
            );
            logger.info(`[Clinicas Tool] getAvailableSlots: ${result.slots.length} slots (source: ${result.source})`);
            return { ok: true, source: result.source, total: result.slots.length, slots: result.slots };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] getAvailableSlots error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: bookAppointment
 * Reserva la cita del paciente. Une GCal y BD en una sola operación atómica.
 * Silenciosa: después de ejecutarla, el agente envía la confirmación al paciente.
 *
 * IMPORTANTE: Solo llamar después de que el paciente confirme explícitamente
 * el slot elegido. No reservar por suposición.
 */
export const createClinicasBookAppointmentTool = (
    companyId: string,
    contactId: string,
    phoneNumberId: string
) => tool({
    description: 'Reserva la cita del paciente en el horario confirmado. Úsala SOLO cuando el paciente haya dicho explícitamente que quiere ese horario (ej: "sí, ese me sirve", "perfecto, ese", "agéndame ahí"). Después de ejecutarla, confirma la cita con un mensaje cálido al paciente.',
    inputSchema: z.object({
        slot_id: z
            .string()
            .describe('ID del slot a reservar. Viene del campo "id" retornado por getAvailableSlots.'),
        starts_at: z
            .string()
            .describe('ISO 8601 de inicio del turno (requerido para slots de GCal, ej: 2024-01-15T09:00:00-05:00). Viene del campo "starts_at" del slot.'),
        ends_at: z
            .string()
            .describe('ISO 8601 de fin del turno (requerido para slots de GCal). Viene del campo "ends_at" del slot.'),
        treatment_id: z
            .string()
            .uuid()
            .optional()
            .describe('UUID del tratamiento elegido. Obtenlo con getServices.'),
        contact_name: z
            .string()
            .optional()
            .describe('Nombre del paciente tal como lo dio durante la conversación.'),
        contact_email: z
            .string()
            .email()
            .optional()
            .describe('Email del paciente si lo proporcionó (para invitar al evento de GCal).'),
        notes: z
            .string()
            .max(500)
            .optional()
            .describe('Notas relevantes sobre la cita: motivo de consulta, condición previa, preferencias, etc.'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.bookAppointmentMerged({
                companyId,
                contactId,
                slotId:       args.slot_id,
                treatmentId:  args.treatment_id,
                notes:        args.notes,
                startsAt:     args.starts_at,
                endsAt:       args.ends_at,
                contactName:  args.contact_name,
                contactEmail: args.contact_email,
            });

            if (!result.ok) {
                logger.warn(`[Clinicas Tool] bookAppointment falló: ${result.error}`);
                return { ok: false, error: result.error };
            }

            logger.info(`[Clinicas Tool] bookAppointment OK — appointment: ${result.appointment?.id} | gcal: ${result.gcalEventId || 'N/A'}`);
            return {
                ok: true,
                appointment_id: result.appointment?.id,
                scheduled_at:   args.starts_at,
                gcal_event_id:  result.gcalEventId || null,
            };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] bookAppointment error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// ─── Tools de notas de contacto ──────────────────────────────────────────────
//
// Las 4 tools comparten el mismo closure (companyId + contactId) para garantizar
// que el agente solo opera sobre notas del contacto activo. Nunca puede acceder
// ni modificar notas de otro contacto aunque conozca su ID.

/**
 * Tool: getNotes
 * Retorna las notas activas del contacto. Silenciosa — el agente las incorpora
 * a su respuesta de forma natural, sin mostrar IDs ni metadatos al paciente.
 */
export const createClinicasGetNotesTool = (companyId: string, contactId: string) => tool({
    description: 'Obtiene las notas internas del contacto actual. Úsala al inicio de una conversación relevante para recordar contexto previo (condiciones, preferencias, observaciones del equipo), o cuando necesites el ID de una nota para editarla o archivarla.',
    inputSchema: z.object({
        include_archived: z
            .boolean()
            .default(false)
            .describe('Si es true, incluye también las notas archivadas. Úsalo solo si necesitas consultar el historial completo.'),
    }),
    execute: async (args) => {
        try {
            const notes = await ClinicasDbService.getNotes(companyId, contactId, args.include_archived);
            logger.info(`[Clinicas Tool] getNotes: ${notes.length} notas (contactId: ${contactId}, archived: ${args.include_archived})`);
            return { ok: true, total: notes.length, notes };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] getNotes error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: addNote
 * Agrega una nueva nota al contacto. Silenciosa — no informa al paciente.
 * Úsala para registrar observaciones clínicas, preferencias o contexto relevante.
 */
export const createClinicasAddNoteTool = (companyId: string, contactId: string) => tool({
    description: 'Agrega una nueva nota interna al contacto. Úsala para registrar observaciones importantes: condiciones que mencionó, preferencias de horario, tratamientos previos, objeciones, o cualquier contexto que ayude a la clínica en futuras interacciones. El paciente no ve estas notas.',
    inputSchema: z.object({
        content: z
            .string()
            .min(1)
            .max(2000)
            .describe('Contenido de la nota. Sé específico y útil: incluye fecha implícita si es relevante, contexto clínico, o preferencias del paciente.'),
    }),
    execute: async (args) => {
        try {
            const note = await ClinicasDbService.addNote(companyId, contactId, args.content, 'agent');
            logger.info(`[Clinicas Tool] addNote: nueva nota ${note.id} para contactId ${contactId}`);
            return { ok: true, note_id: note.id, content: note.content };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] addNote error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: editNote
 * Edita el contenido de una nota existente del contacto.
 * Solo puede editar notas activas (no archivadas).
 * Requiere el note_id — obtenerlo primero con getNotes.
 */
export const createClinicasEditNoteTool = (companyId: string, contactId: string) => tool({
    description: 'Edita el contenido de una nota existente del contacto. Úsala para corregir información incorrecta o actualizar una nota con datos más recientes. Necesitás el note_id — si no lo tenés, llamá primero a getNotes.',
    inputSchema: z.object({
        note_id: z
            .string()
            .uuid()
            .describe('UUID de la nota a editar. Obtenlo con getNotes.'),
        content: z
            .string()
            .min(1)
            .max(2000)
            .describe('Nuevo contenido completo de la nota. Reemplaza el texto anterior.'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.editNote(companyId, args.note_id, args.content);
            if (!result.ok) {
                logger.warn(`[Clinicas Tool] editNote falló: ${result.error}`);
                return result;
            }
            logger.info(`[Clinicas Tool] editNote OK — noteId: ${args.note_id}`);
            return { ok: true, note_id: args.note_id };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] editNote error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: archiveNote
 * Archiva una nota del contacto. Las notas archivadas no se borran — se excluyen
 * del contexto activo pero quedan en el historial completo.
 * Requiere el note_id — obtenerlo primero con getNotes.
 */
export const createClinicasArchiveNoteTool = (companyId: string, contactId: string) => tool({
    description: 'Archiva una nota del contacto. La nota queda guardada en el historial pero ya no aparece en el contexto activo. Úsala cuando la información de una nota ya no es relevante (ej: condición ya resuelta, preferencia desactualizada). Las notas archivadas NUNCA se borran.',
    inputSchema: z.object({
        note_id: z
            .string()
            .uuid()
            .describe('UUID de la nota a archivar. Obtenlo con getNotes.'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.archiveNote(companyId, args.note_id);
            if (!result.ok) {
                logger.warn(`[Clinicas Tool] archiveNote falló: ${result.error}`);
                return result;
            }
            logger.info(`[Clinicas Tool] archiveNote OK — noteId: ${args.note_id}`);
            return { ok: true, note_id: args.note_id, archived: true };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] archiveNote error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: escalateToHuman
 * Marca la conversación como escalada y registra el motivo.
 * El equipo de la clínica recibe la señal de que necesitan intervenir.
 */
export const createClinicasEscalateTool = (conversationId: string) => tool({
    description: 'Escala la conversación a un humano de la clínica. Úsala cuando el paciente lo solicite explícitamente, cuando la consulta sea demasiado compleja, o cuando las reglas de escalamiento lo indiquen.',
    inputSchema: z.object({
        reason: z
            .string()
            .describe('Motivo del escalamiento. Ej: "Paciente solicitó hablar con un médico", "Consulta sobre reacción adversa"'),
    }),
    execute: async (args) => {
        try {
            await ClinicasDbService.escalateConversation(conversationId, args.reason);
            logger.info(`[Clinicas Tool] escalateToHuman: "${args.reason}" → convId ${conversationId}`);
            return { ok: true, escalated: true, reason: args.reason };
        } catch (err: any) {
            logger.error(`[Clinicas Tool] escalateToHuman error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createClinicasNoReplyTool = () => tool({
    description:
        'Silencia la respuesta del agente. Úsala ÚNICAMENTE cuando estés seguro de que ' +
        'el interlocutor es un bot o sistema automatizado (no un humano), ' +
        'para evitar bucles infinitos de bot↔bot. ' +
        'NO la uses con humanos silenciosos, confusos o que escriben poco.',
    inputSchema: z.object({
        reason: z.string().describe(
            'Motivo por el que se determina que el interlocutor es un bot. ' +
            'Ej: "Mensajes en bucle idénticos", "Formato JSON automático detectado".'
        ),
    }),
    execute: async ({ reason }) => {
        logger.warn(`[Clinicas Tool] noReply activado — ${reason}`);
        return { ok: true, noReply: true, reason };
    },
});
