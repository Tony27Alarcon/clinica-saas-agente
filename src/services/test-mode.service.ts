import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { TEST_MODE_TTL_MS } from '../config/constants';
import { ClinicasDbService } from './clinicas-db.service';

const db = () => (supabase as any).schema('clinicas');

export interface TestSession {
    id: string;
    company_id: string;
    staff_id: string;
    admin_conversation_id: string;
    test_conversation_id: string;
    started_at: string;
    expires_at: string;
    ended_at: string | null;
    exit_reason: 'command' | 'timeout' | 'admin_force' | null;
    summary: string | null;
    status: 'active' | 'ended';
}

/**
 * CRUD de sesiones de modo test + helpers.
 *
 * El estado vive en clinicas.test_sessions. Una sola sesión activa por staff
 * (unique index parcial). El TTL se chequea lazy al siguiente mensaje; no hay
 * cron requerido.
 */
export class TestModeService {
    /** Sesión activa (no expirada lógicamente) de un staff, o null. */
    static async getActiveSession(staffId: string): Promise<TestSession | null> {
        try {
            const { data, error } = await db()
                .from('test_sessions')
                .select('*')
                .eq('staff_id', staffId)
                .eq('status', 'active')
                .maybeSingle();

            if (error) throw error;
            return (data as TestSession) ?? null;
        } catch (err) {
            logger.error('[TestMode] getActiveSession falló', err, { staffId });
            return null;
        }
    }

    /**
     * Crea una sesión: contacto + conversación de test (channel='test') con
     * un mensaje seed para bloquear el import de Kapso, e inserta la fila en
     * test_sessions. Ya hay un unique index que impide paralelismo.
     */
    static async startSession(params: {
        company: any;
        staff: any;
        staffPhone: string;
        adminConversationId: string;
    }): Promise<TestSession> {
        const { company, staff, staffPhone, adminConversationId } = params;

        // 1. Contacto de prueba del staff (por teléfono) como "prospecto".
        //    Se reutiliza si ya existe. La clave es que el pipeline público
        //    recibirá una "vista" con status='prospecto' — lo manejamos en
        //    el pipeline, no tocamos el registro real acá.
        //    Pero: el contacto del staff ya existe con status='staff'. Para
        //    no violar UNIQUE(company_id, phone) usamos un contacto distinto
        //    con un phone "aliasado" de prueba: `${phone}__test`.
        const testPhone = `${staffPhone}__test`;
        const testContact = await ClinicasDbService.getOrCreateContact(
            company.id,
            testPhone,
            `${staff.name} (TEST)`,
            'prospecto'
        );

        // 2. Agente activo
        const agent = await ClinicasDbService.getActiveAgent(company.id);

        // 3. Conversación dedicada de test
        const testConv = await ClinicasDbService.getOrCreateConversation(
            company.id,
            testContact.id,
            agent.id,
            'test'
        );

        // 4. Mensaje seed para bloquear el import de Kapso (mismo truco que /borrar)
        const alreadySeeded = await ClinicasDbService.hasMessages(testConv.id);
        if (!alreadySeeded) {
            await ClinicasDbService.saveMessage(
                testConv.id,
                company.id,
                'system',
                '--- Conversación de test abierta por staff (historial de Kapso omitido) ---',
                { test_session: true, staff_id: staff.id }
            );
        }

        // 5. Insert de la sesión
        const expiresAt = new Date(Date.now() + TEST_MODE_TTL_MS).toISOString();
        const { data, error } = await db()
            .from('test_sessions')
            .insert([{
                company_id: company.id,
                staff_id: staff.id,
                admin_conversation_id: adminConversationId,
                test_conversation_id: testConv.id,
                expires_at: expiresAt,
            }])
            .select()
            .single();

        if (error) throw error;

        logger.info('[TestMode] sesión iniciada', {
            sessionId: (data as any).id,
            staffId: staff.id,
            testConvId: testConv.id,
        });

        return data as TestSession;
    }

    /** Marca la sesión como ended con motivo. No borra mensajes (eso es otra fase). */
    static async endSession(params: {
        sessionId: string;
        reason: 'command' | 'timeout' | 'admin_force';
        summary?: string;
    }): Promise<void> {
        const { sessionId, reason, summary } = params;
        try {
            const { error } = await db()
                .from('test_sessions')
                .update({
                    status: 'ended',
                    ended_at: new Date().toISOString(),
                    exit_reason: reason,
                    summary: summary ?? null,
                })
                .eq('id', sessionId);
            if (error) throw error;
        } catch (err) {
            logger.error('[TestMode] endSession falló', err, { sessionId, reason });
        }
    }

    /**
     * Borra TODOS los mensajes de la conversación de test + la conversación
     * + el contacto "aliasado". Valida que la conversación sea channel='test'
     * antes de borrar (seguridad: evita wipe accidental).
     */
    static async purgeTestConversation(testConversationId: string): Promise<void> {
        try {
            const { data: conv, error: convErr } = await db()
                .from('conversations')
                .select('id, channel, contact_id')
                .eq('id', testConversationId)
                .maybeSingle();

            if (convErr) throw convErr;
            if (!conv) {
                logger.warn('[TestMode] purgeTestConversation: conversación no existe', { testConversationId });
                return;
            }
            if (conv.channel !== 'test') {
                logger.error('[TestMode] purgeTestConversation: canal inesperado, abortando borrado', null, {
                    testConversationId, channel: conv.channel,
                });
                return;
            }

            // Borrar mensajes (ON DELETE CASCADE los borraría con la conv,
            // pero los borramos explícitamente por claridad + idempotencia).
            await db().from('messages').delete().eq('conversation_id', testConversationId);

            // Borrar la conversación
            await db().from('conversations').delete().eq('id', testConversationId);

            // Borrar el contacto "aliasado" (tiene phone que termina en __test).
            // Usamos el contact_id guardado para no depender del sufijo.
            await db().from('contacts').delete().eq('id', (conv as any).contact_id);

            logger.info('[TestMode] conversación de test purgada', { testConversationId });
        } catch (err) {
            logger.error('[TestMode] purgeTestConversation falló', err, { testConversationId });
        }
    }

    static isExpired(session: TestSession): boolean {
        return new Date(session.expires_at).getTime() <= Date.now();
    }

    /** Minutos enteros restantes (clamp ≥ 0). */
    static remainingMinutes(session: TestSession): number {
        const ms = new Date(session.expires_at).getTime() - Date.now();
        return Math.max(0, Math.ceil(ms / 60000));
    }
}
