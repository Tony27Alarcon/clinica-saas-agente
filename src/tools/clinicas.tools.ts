import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { ClinicasDbService } from '../services/clinicas-db.service';

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
