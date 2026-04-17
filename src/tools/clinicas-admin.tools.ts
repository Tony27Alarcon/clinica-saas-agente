import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { KapsoService } from '../services/kapso.service';
import { env } from '../config/env';
import { PromptRebuildService } from '../services/prompt-rebuild.service';
import { CompanySkillsService } from '../services/company-skills.service';

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

/**
 * Tool: connectGoogleCalendar
 *
 * Genera un link de autorización OAuth 2.0 de Google y se lo envía al
 * staff que está chateando con el agente admin por WhatsApp.
 * Todos los parámetros vienen del closure — el LLM no controla ninguno.
 *
 * @param staffId       UUID del staff (clinicas.staff)
 * @param companyId     UUID de la clínica (para construir el URL y validar en callback)
 * @param staffPhone    Teléfono del staff en E.164 sin + (para enviar el mensaje WA)
 * @param phoneNumberId phoneNumberId del canal WhatsApp de la clínica
 */
export const createAdminConnectGoogleCalendarTool = (
    staffId: string,
    companyId: string,
    staffPhone: string,
    phoneNumberId: string
) => tool({
    description: 'Envía al staff un link por WhatsApp para conectar su Google Calendar con la clínica. Usar cuando el staff pida conectar su calendario, vincular Google Calendar, o cuando quiera que el agente cree citas en su agenda personal.',
    inputSchema: z.object({}),
    execute: async () => {
        try {
            if (!env.GOOGLE_OAUTH_REDIRECT_URI) {
                return { ok: false, error: 'Google OAuth no está configurado en el servidor' };
            }

            // Extraer base URL desde GOOGLE_OAUTH_REDIRECT_URI
            // ej: https://mi-app.railway.app/auth/google/callback → https://mi-app.railway.app
            let baseUrl = '';
            try {
                const parsed = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
                baseUrl = `${parsed.protocol}//${parsed.host}`;
            } catch {
                baseUrl = env.GOOGLE_OAUTH_REDIRECT_URI.replace('/auth/google/callback', '');
            }

            const startUrl = `${baseUrl}/auth/google/start?staff_id=${encodeURIComponent(staffId)}&company_id=${encodeURIComponent(companyId)}`;

            const mensaje = `Para conectar tu Google Calendar con el asistente, abre este link y autoriza el acceso con tu cuenta de Google:\n\n${startUrl}\n\nEs personal — no lo compartas con nadie.`;

            await KapsoService.enviarMensaje(staffPhone, mensaje, phoneNumberId);

            logger.info(`[Admin Tool] connectGoogleCalendar: link enviado a ${staffPhone} (staff: ${staffId})`);
            return { ok: true, linkSent: true, to: staffPhone };
        } catch (err: any) {
            logger.error(`[Admin Tool] connectGoogleCalendar error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// CRUD — Treatments
// =============================================================================

export const createAdminListTreatmentsTool = (companyId: string) => tool({
    description: 'Lista los tratamientos de la clínica. Por defecto retorna solo los activos. Con includeArchived=true retorna también los archivados (inactivos). Usa esta tool antes de updateTreatment o archiveTreatment para obtener los UUIDs.',
    inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe('Si true, incluye también tratamientos archivados/inactivos'),
    }),
    execute: async (args) => {
        try {
            const treatments = await ClinicasDbService.listAllTreatments(companyId, args.includeArchived);
            logger.info(`[Admin Tool] listTreatments: ${treatments.length} resultados (company: ${companyId})`);
            return { ok: true, data: treatments, total: treatments.length };
        } catch (err: any) {
            logger.error(`[Admin Tool] listTreatments error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminCreateTreatmentTool = (companyId: string) => tool({
    description: 'Crea un nuevo tratamiento en la clínica. Requiere al menos el nombre. Después de crear, el catálogo del agente paciente se actualiza automáticamente.',
    inputSchema: z.object({
        name:                     z.string().min(1).max(200).describe('Nombre del tratamiento'),
        description:              z.string().optional().describe('Descripción detallada del tratamiento'),
        price_min:                z.number().nonnegative().optional().describe('Precio mínimo'),
        price_max:                z.number().nonnegative().optional().describe('Precio máximo'),
        duration_min:             z.number().int().positive().optional().describe('Duración en minutos'),
        preparation_instructions: z.string().optional().describe('Instrucciones de preparación previa al tratamiento'),
        post_care_instructions:   z.string().optional().describe('Cuidados post-procedimiento'),
        followup_days:            z.array(z.number().int().positive()).optional().describe('Días para seguimiento automático post-tratamiento (ej: [3,7,30])'),
        category:                 z.string().optional().describe('Categoría del tratamiento (ej: facial, corporal, capilar)'),
        contraindications:        z.string().optional().describe('Condiciones que contraindican el tratamiento'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.createTreatment(companyId, args);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] createTreatment: ${result.data?.id} (${args.name})`);
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras createTreatment: ${e.message}`));
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] createTreatment error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminUpdateTreatmentTool = (companyId: string) => tool({
    description: 'Actualiza los campos de un tratamiento existente. Solo los campos provistos se modifican. Requiere el UUID del tratamiento (usa listTreatments para obtenerlo).',
    inputSchema: z.object({
        treatmentId:              z.string().uuid().describe('UUID del tratamiento a actualizar'),
        name:                     z.string().min(1).max(200).optional().describe('Nuevo nombre'),
        description:              z.string().optional().describe('Nueva descripción'),
        price_min:                z.number().nonnegative().optional().describe('Precio mínimo'),
        price_max:                z.number().nonnegative().optional().describe('Precio máximo'),
        duration_min:             z.number().int().positive().optional().describe('Duración en minutos'),
        preparation_instructions: z.string().optional().describe('Instrucciones de preparación'),
        post_care_instructions:   z.string().optional().describe('Cuidados post-procedimiento'),
        followup_days:            z.array(z.number().int().positive()).optional().describe('Días de seguimiento (ej: [3,7,30])'),
        category:                 z.string().optional().describe('Categoría'),
        contraindications:        z.string().optional().describe('Contraindicaciones'),
    }),
    execute: async (args) => {
        try {
            const { treatmentId, ...data } = args;
            const result = await ClinicasDbService.updateTreatment(companyId, treatmentId, data);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] updateTreatment: ${treatmentId}`);
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras updateTreatment: ${e.message}`));
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] updateTreatment error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminArchiveTreatmentTool = (companyId: string) => tool({
    description: 'Archiva (desactiva) un tratamiento. El tratamiento deja de aparecer en el catálogo del agente paciente. No se elimina de la BD. Usa listTreatments para obtener el UUID.',
    inputSchema: z.object({
        treatmentId: z.string().uuid().describe('UUID del tratamiento a archivar'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.archiveTreatment(companyId, args.treatmentId);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] archiveTreatment: ${args.treatmentId}`);
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras archiveTreatment: ${e.message}`));
            return { ok: true };
        } catch (err: any) {
            logger.error(`[Admin Tool] archiveTreatment error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// CRUD — Company profile
// =============================================================================

export const createAdminUpdateCompanyTool = (companyId: string) => tool({
    description: 'Actualiza los datos de la clínica: nombre, ciudad, dirección, horarios de atención y zona horaria. El campo schedule es un array de bloques horarios: [{days:["lun","vie"], open:"09:00", close:"18:00"}]. Después de guardar, el agente paciente se actualiza automáticamente.',
    inputSchema: z.object({
        name:     z.string().min(1).optional().describe('Nombre de la clínica'),
        city:     z.string().optional().describe('Ciudad'),
        address:  z.string().optional().describe('Dirección física'),
        schedule: z.array(z.object({
            days:  z.array(z.string()).describe('Días: lun, mar, mie, jue, vie, sab, dom'),
            open:  z.string().describe('Hora de apertura HH:MM'),
            close: z.string().describe('Hora de cierre HH:MM'),
        })).optional().describe('Bloques de horario de atención'),
        timezone: z.string().optional().describe('Zona horaria IANA (ej: America/Bogota, America/Lima)'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.updateCompanyProfile(companyId, args);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] updateCompany: ${companyId}`);
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras updateCompany: ${e.message}`));
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] updateCompany error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// CRUD — Agent config
// =============================================================================

export const createAdminUpdateAgentConfigTool = (companyId: string) => tool({
    description: 'Actualiza la configuración del agente paciente: nombre, tono, personalidad, descripción de la clínica, instrucciones de reserva, temas prohibidos y reglas de comportamiento. El system_prompt se regenera automáticamente — no lo modifiques directamente.',
    inputSchema: z.object({
        name:                   z.string().optional().describe('Nombre del agente (ej: Valentina, Sofía)'),
        tone:                   z.enum(['formal', 'amigable', 'casual']).optional().describe('Tono de voz del agente'),
        persona_description:    z.string().optional().describe('Descripción de la personalidad del agente'),
        clinic_description:     z.string().optional().describe('Descripción general de la clínica para el agente'),
        booking_instructions:   z.string().optional().describe('Instrucciones específicas para el proceso de reserva'),
        prohibited_topics:      z.array(z.string()).optional().describe('Temas que el agente debe rechazar o evitar'),
        qualification_criteria: z.record(z.string(), z.any()).optional().describe('Criterios de calificación de leads (JSON: min_budget_usd, excluded_keywords)'),
        escalation_rules:       z.record(z.string(), z.any()).optional().describe('Reglas de escalación a humano (JSON: trigger_keywords, max_turns_without_intent)'),
        objections_kb:          z.array(z.object({
            objection: z.string(),
            response:  z.string(),
        })).optional().describe('Base de conocimiento de objeciones y respuestas sugeridas'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.updateAgentConfig(companyId, args);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] updateAgentConfig: ${companyId}`);
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras updateAgentConfig: ${e.message}`));
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] updateAgentConfig error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// CRUD — Staff
// =============================================================================

export const createAdminListStaffTool = (companyId: string) => tool({
    description: 'Lista los miembros del staff de la clínica. Por defecto retorna solo activos. Con includeArchived=true retorna también los inactivos. Usa esta tool antes de updateStaff o archiveStaff para obtener los UUIDs.',
    inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe('Si true, incluye staff archivado/inactivo'),
    }),
    execute: async (args) => {
        try {
            const staff = await ClinicasDbService.listStaff(companyId, args.includeArchived);
            logger.info(`[Admin Tool] listStaff: ${staff.length} resultados (company: ${companyId})`);
            return { ok: true, data: staff, total: staff.length };
        } catch (err: any) {
            logger.error(`[Admin Tool] listStaff error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminCreateStaffTool = (companyId: string) => tool({
    description: 'Agrega un nuevo miembro al staff de la clínica. El staff creado podrá ser asignado a citas y podrá usar el agente admin si su teléfono está registrado.',
    inputSchema: z.object({
        name:                   z.string().min(1).max(200).describe('Nombre completo del miembro'),
        role:                   z.string().optional().describe('Rol o cargo (ej: Médico Estético, Recepcionista, Gerente)'),
        specialty:              z.string().optional().describe('Especialidad médica o área (ej: Botox, Láser, Rellenos)'),
        phone:                  z.string().optional().describe('Teléfono en formato internacional (ej: 573001234567)'),
        email:                  z.string().email().optional().describe('Correo electrónico'),
        max_daily_appointments: z.number().int().positive().optional().describe('Máximo de citas por día'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.createStaff(companyId, args);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] createStaff: ${result.data?.id} (${args.name})`);
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] createStaff error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminUpdateStaffTool = (companyId: string) => tool({
    description: 'Actualiza los datos de un miembro del staff. Si se cambia nombre, rol o especialidad, el agente paciente se actualiza automáticamente. Usa listStaff para obtener el UUID.',
    inputSchema: z.object({
        staffId:                z.string().uuid().describe('UUID del miembro del staff a actualizar'),
        name:                   z.string().min(1).max(200).optional().describe('Nuevo nombre completo'),
        role:                   z.string().optional().describe('Nuevo rol o cargo'),
        specialty:              z.string().optional().describe('Nueva especialidad'),
        phone:                  z.string().optional().describe('Nuevo teléfono en formato internacional'),
        email:                  z.string().email().optional().describe('Nuevo correo electrónico'),
        max_daily_appointments: z.number().int().positive().optional().describe('Nuevo máximo de citas por día'),
    }),
    execute: async (args) => {
        try {
            const { staffId, ...data } = args;
            const result = await ClinicasDbService.updateStaff(companyId, staffId, data);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] updateStaff: ${staffId}`);
            const promptAffectingFields = ['name', 'role', 'specialty'] as const;
            const needsRebuild = promptAffectingFields.some(f => f in data);
            if (needsRebuild) {
                PromptRebuildService.rebuildPromptForCompany(companyId)
                    .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras updateStaff: ${e.message}`));
            }
            return result;
        } catch (err: any) {
            logger.error(`[Admin Tool] updateStaff error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminArchiveStaffTool = (companyId: string) => tool({
    description: 'Archiva (desactiva) un miembro del staff. El staff archivado ya no aparecerá como profesional disponible. No se elimina de la BD. Usa listStaff para obtener el UUID.',
    inputSchema: z.object({
        staffId: z.string().uuid().describe('UUID del miembro del staff a archivar'),
    }),
    execute: async (args) => {
        try {
            const result = await ClinicasDbService.archiveStaff(companyId, args.staffId);
            if (!result.ok) return result;
            logger.info(`[Admin Tool] archiveStaff: ${args.staffId}`);
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras archiveStaff: ${e.message}`));
            return { ok: true };
        } catch (err: any) {
            logger.error(`[Admin Tool] archiveStaff error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// Onboarding — Completar configuración inicial
// =============================================================================

export const createAdminCompleteOnboardingTool = (companyId: string) => tool({
    description: 'Marca el onboarding de la clínica como completado y activa el agente de pacientes. Usar SOLO cuando los pasos requeridos estén terminados: perfil de clínica, personalidad del agente y al menos 1 tratamiento registrado.',
    inputSchema: z.object({}),
    execute: async () => {
        try {
            // Validar mínimos antes de completar
            const treatments = await ClinicasDbService.listAllTreatments(companyId, false);
            if (treatments.length === 0) {
                return { ok: false, error: 'Se necesita al menos 1 tratamiento registrado antes de completar el onboarding.' };
            }

            const result = await ClinicasDbService.completeOnboarding(companyId);
            if (!result.ok) return result;

            // Recompilar el prompt del agente paciente con toda la config nueva
            PromptRebuildService.rebuildPromptForCompany(companyId)
                .catch((e: Error) => logger.error(`[Admin Tool] rebuildPrompt tras completeOnboarding: ${e.message}`));

            logger.info(`[Admin Tool] completeOnboarding: ${companyId}`);
            return { ok: true, message: 'Onboarding completado. El agente de pacientes está activo y listo para atender.' };
        } catch (err: any) {
            logger.error(`[Admin Tool] completeOnboarding error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// Portal Admin — link de acceso web
// =============================================================================

/**
 * Tool: sendAdminPortalLink
 *
 * Genera y envía por WhatsApp el link de acceso al portal de administración
 * web (Next.js en Vercel) para que el staff pueda configurar el agente,
 * revisar citas y gestionar pacientes desde el navegador.
 *
 * Todos los parámetros vienen del closure — el LLM no controla la URL ni
 * el destinatario.
 */
/**
 * Genera un JWT HS256 firmado con INTERNAL_API_SECRET.
 * Implementación manual con crypto nativo — sin dependencias extra.
 * Compatible con la verificación de `jose` en el middleware de Next.js.
 */
export type PortalRole = 'admin' | 'staff';

function createPortalToken(companyId: string, role: PortalRole = 'admin'): string {
    const crypto = require('crypto') as typeof import('crypto');
    const secret = env.INTERNAL_API_SECRET;
    if (!secret) throw new Error('INTERNAL_API_SECRET no está configurado');

    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        companyId,
        role,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24 h
    })).toString('base64url');

    const sig = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url');

    return `${header}.${payload}.${sig}`;
}

export const createAdminSendPortalLinkTool = (
    companyId: string,
    staffPhone: string,
    phoneNumberId: string
) => tool({
    description: 'Envía al staff el link de acceso al portal web de administración por WhatsApp. Usar cuando el staff pida "el link del panel", "acceso al portal", "abrir el dashboard", "configurar desde la web" o frases similares.',
    inputSchema: z.object({}),
    execute: async () => {
        try {
            if (!env.ADMIN_PORTAL_URL) {
                return { ok: false, error: 'ADMIN_PORTAL_URL no está configurado en el servidor' };
            }
            if (!env.INTERNAL_API_SECRET) {
                return { ok: false, error: 'INTERNAL_API_SECRET no está configurado en el servidor' };
            }

            const token   = createPortalToken(companyId);
            const baseUrl = env.ADMIN_PORTAL_URL.replace(/\/$/, '');
            const url     = `${baseUrl}/admin/${companyId}/agente?token=${token}`;

            const mensaje =
                `Aquí está tu link de acceso al portal de administración:\n\n` +
                `${url}\n\n` +
                `Desde ahí puedes:\n` +
                `• Editar las instrucciones del agente\n` +
                `• Configurar el tono y las objeciones\n` +
                `• Ajustar criterios de calificación y escalamiento\n\n` +
                `⏱ El link expira en 24 horas. Es personal — no lo compartas.`;

            await KapsoService.enviarMensaje(staffPhone, mensaje, phoneNumberId);

            logger.info(`[Admin Tool] sendAdminPortalLink: link con token enviado a ${staffPhone} (company: ${companyId})`);
            return { ok: true, linkSent: true, to: staffPhone };
        } catch (err: any) {
            logger.error(`[Admin Tool] sendAdminPortalLink error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// =============================================================================
// Skills configurables por empresa — gestión vía agente admin (WhatsApp)
//
// Solo el rol admin de la clínica debería invocar las mutaciones. El check
// de rol vive en el backend de la API web (requireAdmin); aquí confiamos en
// el contexto: el agente admin solo se monta para conversaciones del staff
// dueño del número de admin de la clínica.
// =============================================================================

export const createAdminListCompanySkillsTool = (companyId: string) => tool({
    description: 'Lista las skills configurables del agente paciente: catálogo de sistema (con su estado activo/inactivo) y skills privadas de la clínica. Usar cuando el staff pregunte "qué skills tiene el agente", "qué puedo activar", "muéstrame las skills".',
    inputSchema: z.object({}),
    execute: async () => {
        try {
            const all = await CompanySkillsService.listForCompany(companyId);
            return {
                ok: true,
                system:  all.filter(s => s.kind === 'system')
                    .map(s => ({ skill_id: s.skill_id, name: s.name, enabled: s.enabled, trigger: s.trigger })),
                private: all.filter(s => s.kind === 'private')
                    .map(s => ({ skill_id: s.skill_id, name: s.name, enabled: s.enabled, trigger: s.trigger })),
            };
        } catch (err: any) {
            logger.error(`[Admin Tool] listCompanySkills error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminToggleCompanySkillTool = (companyId: string) => tool({
    description: 'Activa o desactiva una skill del agente paciente. Para skills de sistema, usar kind="system" + el skill_id del catálogo. Para skills privadas de la clínica, kind="private" + el skill_id creado por el admin.',
    inputSchema: z.object({
        kind:     z.enum(['system', 'private']),
        skill_id: z.string().min(2).max(64),
        enabled:  z.boolean(),
    }),
    execute: async ({ kind, skill_id, enabled }) => {
        try {
            await CompanySkillsService.setEnabled(companyId, kind, skill_id, enabled);
            return { ok: true, kind, skill_id, enabled };
        } catch (err: any) {
            logger.error(`[Admin Tool] toggleCompanySkill error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminCreatePrivateSkillTool = (companyId: string) => tool({
    description: 'Crea una skill privada para el agente paciente de esta clínica. Antes de invocar: aplicar el protocolo "manage-private-skills" (validar trigger claro, guidelines accionables ≥30 chars, slug único que no colisione con catálogo de sistema). Mostrar el borrador al staff y pedir confirmación.',
    inputSchema: z.object({
        skill_id:   z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'slug lowercase con guiones'),
        name:       z.string().min(1),
        trigger:    z.string().min(1).describe('Cuándo el agente debe activar esta skill (frase concreta).'),
        guidelines: z.string().min(30).describe('Instrucciones detalladas para el agente, en imperativo. Mín. 30 chars.'),
        enabled:    z.boolean().optional().default(true),
    }),
    execute: async (input) => {
        try {
            const created = await CompanySkillsService.createPrivate(companyId, input);
            return { ok: true, skill: { skill_id: created.skill_id, name: created.name, enabled: created.enabled } };
        } catch (err: any) {
            logger.error(`[Admin Tool] createPrivateSkill error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminUpdatePrivateSkillTool = (companyId: string) => tool({
    description: 'Edita el contenido de una skill privada existente (name, trigger, guidelines, enabled). NO sirve para skills de sistema (esas solo se togglean).',
    inputSchema: z.object({
        skill_id:   z.string().min(2).max(64),
        name:       z.string().min(1).optional(),
        trigger:    z.string().min(1).optional(),
        guidelines: z.string().min(30).optional(),
        enabled:    z.boolean().optional(),
    }),
    execute: async ({ skill_id, ...updates }) => {
        try {
            await CompanySkillsService.updatePrivate(companyId, skill_id, updates);
            return { ok: true, skill_id };
        } catch (err: any) {
            logger.error(`[Admin Tool] updatePrivateSkill error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

export const createAdminDeletePrivateSkillTool = (companyId: string) => tool({
    description: 'Elimina permanentemente una skill privada. Pedir confirmación explícita al staff antes de invocar. Las skills de sistema NO se borran (solo se desactivan con toggleCompanySkill).',
    inputSchema: z.object({
        skill_id: z.string().min(2).max(64),
    }),
    execute: async ({ skill_id }) => {
        try {
            await CompanySkillsService.deletePrivate(companyId, skill_id);
            return { ok: true, skill_id };
        } catch (err: any) {
            logger.error(`[Admin Tool] deletePrivateSkill error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});
