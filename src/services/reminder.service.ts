import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { ReminderDbService } from './reminder-db.service';
import { ClinicasDbService } from './clinicas-db.service';
import { AiService } from './ai.service';
import { KapsoService } from './kapso.service';

const db = () => (supabase as any).schema('clinicas');

export class ReminderService {

    /**
     * Punto de entrada del scheduler. Se llama cada 60s desde index.ts.
     *
     * Primero hace el claim atómico (UPDATE RETURNING), luego procesa cada
     * recordatorio de forma independiente — un fallo no afecta a los demás.
     */
    static async checkAndFire(): Promise<void> {
        let reminders: any[];

        try {
            reminders = await ReminderDbService.claimDueReminders();
        } catch (err) {
            logger.error('[ReminderService] Error en claimDueReminders', err);
            return;
        }

        if (reminders.length === 0) return;

        logger.info(`[ReminderService] ${reminders.length} recordatorio(s) a procesar`);

        for (const reminder of reminders) {
            try {
                await ReminderService.fireReminder(reminder);
            } catch (err) {
                logger.error(
                    `[ReminderService] Fallo procesando reminder ${reminder.id}`,
                    err
                );
                await ReminderDbService.markFailed(
                    reminder.id,
                    err instanceof Error ? err.message : String(err)
                );
            }
        }
    }

    /**
     * Procesa un recordatorio individual.
     * Reconstruye el contexto completo y activa el agente apropiado.
     */
    private static async fireReminder(reminder: any): Promise<void> {
        logger.info(`[ReminderService] Procesando reminder ${reminder.id}`, {
            contactId: reminder.contact_id,
            agentType: reminder.agent_type,
        });

        // Cargar datos del contexto en paralelo
        const [company, contact, phoneNumberId] = await Promise.all([
            ReminderService.loadCompany(reminder.company_id),
            ReminderService.loadContact(reminder.contact_id),
            ReminderService.getPhoneNumberId(reminder.company_id),
        ]);
        if (!company) throw new Error(`Company no encontrada: ${reminder.company_id}`);
        if (!contact) throw new Error(`Contacto no encontrado: ${reminder.contact_id}`);
        if (!phoneNumberId) throw new Error(`Sin canal WhatsApp activo para company ${reminder.company_id}`);

        // Resolver o crear conversación abierta
        const agent = await ClinicasDbService.getActiveAgent(reminder.company_id);
        const conversation = await ReminderService.resolveConversation(
            reminder,
            company,
            contact,
            agent
        );

        // Cargar historial y agregar trigger como último mensaje
        const historial = await ClinicasDbService.getHistorial(conversation.id, 20);
        const triggerMessage = ReminderService.buildTriggerMessage(reminder);
        const historialConTrigger = [
            ...historial,
            { role: 'user' as const, content: triggerMessage },
        ];

        // Guardar el trigger en DB para trazabilidad
        await ClinicasDbService.saveMessage(
            conversation.id,
            reminder.company_id,
            'system',
            triggerMessage,
            { reminder_id: reminder.id, triggered_by: 'scheduler' }
        );

        // Activar el agente según tipo
        let respuesta: string | null | undefined;

        if (reminder.agent_type === 'admin') {
            const staffMember = await ClinicasDbService.findStaffByPhone(
                reminder.company_id,
                contact.phone
            );
            respuesta = await AiService.generarRespuestaAdmin(
                historialConTrigger,
                staffMember || { name: contact.name, id: contact.id, phone: contact.phone },
                company,
                contact,
                conversation,
                phoneNumberId
            );
        } else {
            respuesta = await AiService.generarRespuestaClinicas(
                historialConTrigger,
                agent,
                contact,
                conversation,
                phoneNumberId,
                company
            );
        }

        // Guardar y enviar respuesta
        if (respuesta && respuesta.trim()) {
            await ClinicasDbService.saveMessage(
                conversation.id,
                reminder.company_id,
                'agent',
                respuesta
            );
            await KapsoService.enviarMensaje(contact.phone, respuesta, phoneNumberId);
            logger.info(`[ReminderService] Reminder ${reminder.id} disparado OK`);
        } else {
            logger.warn(`[ReminderService] Reminder ${reminder.id}: agente no generó respuesta`);
        }
    }

    /**
     * Construye el mensaje de trigger inyectado al historial.
     * Se presenta como rol 'user' para que el LLM lo procese,
     * con marcador inequívoco de activación por scheduler.
     */
    private static buildTriggerMessage(reminder: any): string {
        return [
            `[ACTIVACIÓN AUTOMÁTICA POR RECORDATORIO]`,
            ``,
            `Fuiste activado por un recordatorio programado, no por un mensaje del usuario.`,
            `Debes escribir PROACTIVAMENTE al usuario — él no sabe que lo contactarás.`,
            ``,
            `Contexto del recordatorio:`,
            reminder.message,
            ``,
            `Instrucciones:`,
            `- Inicia la conversación de forma natural, retomando el hilo previo.`,
            `- NO menciones que eres un bot ni que fuiste "activado".`,
            `- Escribe tú primero, no esperes respuesta del usuario.`,
            `- Usa el historial previo para personalizar el mensaje.`,
        ].join('\n');
    }

    /**
     * Resuelve qué conversación usar para disparar el recordatorio.
     *
     * Casos:
     *   A) La conversación original existe y está 'open'     → usarla
     *   B) La conversación original existe y está cerrada    → reabrirla
     *   C) conversation_id es null (borrada por CASCADE)     → crear nueva
     *   D) No había conversation_id desde el inicio          → crear nueva
     */
    private static async resolveConversation(
        reminder: any,
        company: any,
        contact: any,
        agent: any
    ): Promise<any> {
        if (reminder.conversation_id) {
            const existing = await ReminderService.loadConversation(reminder.conversation_id);

            if (existing) {
                if (existing.status === 'open') {
                    return existing; // Caso A
                }
                // Caso B: reabrir
                return await ReminderService.reopenConversation(reminder.conversation_id);
            }
        }

        // Casos C y D: getOrCreateConversation reutiliza la open existente si la hay
        return await ClinicasDbService.getOrCreateConversation(
            company.id,
            contact.id,
            agent.id,
            'whatsapp'
        );
    }

    // ─── Helpers de carga ────────────────────────────────────────────────────

    private static async loadCompany(companyId: string): Promise<any | null> {
        const { data, error } = await db()
            .from('companies')
            .select('id, name, timezone, currency, active')
            .eq('id', companyId)
            .eq('active', true)
            .maybeSingle();
        if (error) logger.error('[ReminderService] loadCompany error', error);
        return data || null;
    }

    private static async loadContact(contactId: string): Promise<any | null> {
        const { data, error } = await db()
            .from('contacts')
            .select('id, company_id, phone, name, status, temperature')
            .eq('id', contactId)
            .maybeSingle();
        if (error) logger.error('[ReminderService] loadContact error', error);
        return data || null;
    }

    private static async loadConversation(conversationId: string): Promise<any | null> {
        const { data, error } = await db()
            .from('conversations')
            .select('*')
            .eq('id', conversationId)
            .maybeSingle();
        if (error) logger.error('[ReminderService] loadConversation error', error);
        return data || null;
    }

    private static async reopenConversation(conversationId: string): Promise<any> {
        const { data, error } = await db()
            .from('conversations')
            .update({
                status:     'open',
                updated_at: new Date().toISOString(),
            })
            .eq('id', conversationId)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    private static async getPhoneNumberId(companyId: string): Promise<string | null> {
        const { data, error } = await db()
            .from('channels')
            .select('provider_id')
            .eq('company_id', companyId)
            .eq('provider', 'whatsapp')
            .eq('active', true)
            .limit(1)
            .maybeSingle();
        if (error) return null;
        return data?.provider_id || null;
    }
}
