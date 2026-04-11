import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { KapsoService } from '../services/kapso.service';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface CommercialStaffMember {
    /** Identificador que el LLM usa para seleccionar al destinatario */
    id: string;
    name: string;
    /** Teléfono en formato E.164 sin el + (ej: 5491123456789) */
    phone: string;
    role?: string;
}

// ─── Tool: notifyStaff ───────────────────────────────────────────────────────

/**
 * Tool: notifyStaff
 *
 * Envía por WhatsApp los datos de un prospecto al asesor asignado (o a cualquier
 * otro miembro del equipo comercial). Diseñada para Bruno Comercial.
 *
 * @param phoneNumberId     phoneNumberId del canal WA de Bruno (desde closure).
 * @param assignedAdvisor   Asesor predeterminado asignado a este prospecto.
 * @param availableStaff    Lista completa del equipo comercial que puede recibir notificaciones.
 */
export const createBrunoNotifyStaffTool = (
    phoneNumberId: string,
    assignedAdvisor: CommercialStaffMember,
    availableStaff: CommercialStaffMember[]
) => {
    // Asegurar que el asesor asignado siempre esté en la lista disponible
    const allStaff = availableStaff.some(s => s.id === assignedAdvisor.id)
        ? availableStaff
        : [assignedAdvisor, ...availableStaff];

    const staffOptions = allStaff
        .map(s => `"${s.id}" → ${s.name}${s.role ? ` (${s.role})` : ''}`)
        .join(', ');

    return tool({
        description: `Notifica al asesor comercial asignado —o a cualquier miembro del equipo— cuando obtienes datos de un prospecto de clínica (número del tomador de decisiones, nombre, cargo u otra información relevante). Úsala siempre que el contacto en recepción te dé información útil sobre la persona que toma decisiones. Por defecto notifica a ${assignedAdvisor.name}. Otros asesores disponibles: ${staffOptions}.`,

        inputSchema: z.object({
            clinic_name: z
                .string()
                .describe('Nombre de la clínica o consultorio prospecto'),

            contact_name: z
                .string()
                .optional()
                .describe('Nombre del tomador de decisiones (si fue informado)'),

            contact_phone: z
                .string()
                .optional()
                .describe('Número de WhatsApp o teléfono del tomador de decisiones'),

            contact_role: z
                .string()
                .optional()
                .describe('Cargo o rol del tomador de decisiones. Ej: "Dueña", "Director Médico", "Gerente"'),

            notes: z
                .string()
                .optional()
                .describe('Contexto adicional útil para el asesor: horarios de contacto, objeciones escuchadas, nombre de quien atendió en recepción, etc.'),

            staff_id: z
                .string()
                .optional()
                .describe(`ID del miembro del equipo a notificar. Si se omite, se notifica a ${assignedAdvisor.name} (id: "${assignedAdvisor.id}"). IDs válidos: ${staffOptions}`),
        }),

        execute: async (args) => {
            // ── Resolver destinatario ─────────────────────────────────────
            let recipient = assignedAdvisor;

            if (args.staff_id && args.staff_id !== assignedAdvisor.id) {
                const override = allStaff.find(s => s.id === args.staff_id);
                if (!override) {
                    const validIds = allStaff.map(s => `"${s.id}"`).join(', ');
                    logger.warn(`[Bruno Tool] notifyStaff: staff_id "${args.staff_id}" no encontrado`);
                    return { ok: false, error: `Asesor "${args.staff_id}" no encontrado. IDs válidos: ${validIds}` };
                }
                recipient = override;
            }

            // ── Construir mensaje ─────────────────────────────────────────
            const lines: string[] = ['🎯 *Nuevo prospecto — Bruno Comercial*', ''];

            lines.push(`🏥 *Clínica:* ${args.clinic_name}`);

            if (args.contact_name) {
                const roleStr = args.contact_role ? ` _(${args.contact_role})_` : '';
                lines.push(`👤 *Contacto TDD:* ${args.contact_name}${roleStr}`);
            } else if (args.contact_role) {
                lines.push(`👤 *Rol:* ${args.contact_role}`);
            }

            if (args.contact_phone) {
                lines.push(`📱 *WhatsApp/Tel:* ${args.contact_phone}`);
            }

            if (args.notes) {
                lines.push('');
                lines.push(`📝 ${args.notes}`);
            }

            const message = lines.join('\n');

            // ── Enviar ────────────────────────────────────────────────────
            try {
                await KapsoService.enviarMensaje(recipient.phone, message, phoneNumberId);
                logger.info(
                    `[Bruno Tool] notifyStaff: "${args.clinic_name}" → ${recipient.name} (${recipient.phone})` +
                    (args.contact_phone ? ` | TDD: ${args.contact_phone}` : '')
                );
                return {
                    ok: true,
                    notified: recipient.name,
                    to: recipient.phone,
                    clinic: args.clinic_name,
                };
            } catch (err: any) {
                logger.error(`[Bruno Tool] notifyStaff error: ${err.message}`);
                return { ok: false, error: err.message };
            }
        },
    });
};
