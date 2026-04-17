/**
 * Pipeline de modo test (staff → /test).
 *
 * Se invoca desde processClinicasEvent cuando el que escribe es staff y tiene
 * (o acaba de abrir) una sesión de test activa. Vive aislado en su propia
 * conversación (channel='test') contra un contacto "aliasado" del staff con
 * status='prospecto' para que el agente público lo trate como paciente nuevo.
 *
 * Retornos:
 *   - 'handled'           → este mensaje ya fue atendido acá. El controller termina.
 *   - 'passthrough_admin' → la sesión expiró y este mensaje debe caer al pipeline
 *                            admin normal (el resumen ya quedó inyectado allí).
 */

import { supabase } from '../config/supabase';
import { ClinicasDbService } from '../services/clinicas-db.service';
import { AiService } from '../services/ai.service';
import { KapsoService } from '../services/kapso.service';
import { TestModeService, type TestSession } from '../services/test-mode.service';
import { TestSummaryService } from '../services/test-summary.service';
import { logger } from '../utils/logger';
import { TEST_MODE_COMMANDS, TEST_MODE_COPY, TEST_MODE_TTL_MS } from '../config/constants';

const db = () => (supabase as any).schema('clinicas');

export type TestModeOutcome = 'handled' | 'passthrough_admin';

export interface TestModeContext {
    event: any;
    company: any;
    staffMember: any;
    /** Sesión pre-cargada. Null cuando el staff manda `/test` por primera vez. */
    session: TestSession | null;
    /** Conversación admin del staff; necesaria para inyectar el resumen. */
    adminConversationId: string;
    from: string;
    text: string;
    phoneNumberId: string;
    messageId: string;
    messageType: string;
}

function normalizeCommand(text: string): string {
    return (text || '').trim().toLowerCase();
}

/**
 * Lee el contact_id asociado a una conversación. Usado para recuperar el
 * "test contact" (el contacto aliasado con status='prospecto') en cada turno
 * sin tener que volver a crearlo.
 */
async function getContactIdForConversation(conversationId: string): Promise<string | null> {
    try {
        const { data, error } = await db()
            .from('conversations')
            .select('contact_id')
            .eq('id', conversationId)
            .maybeSingle();
        if (error) throw error;
        return (data as any)?.contact_id ?? null;
    } catch (err) {
        logger.error('[TestMode] getContactIdForConversation falló', err, { conversationId });
        return null;
    }
}

async function getContactById(contactId: string): Promise<any | null> {
    try {
        const { data, error } = await db()
            .from('contacts')
            .select('*')
            .eq('id', contactId)
            .maybeSingle();
        if (error) throw error;
        return data ?? null;
    } catch (err) {
        logger.error('[TestMode] getContactById falló', err, { contactId });
        return null;
    }
}

async function getConversationById(conversationId: string): Promise<any | null> {
    try {
        const { data, error } = await db()
            .from('conversations')
            .select('*')
            .eq('id', conversationId)
            .maybeSingle();
        if (error) throw error;
        return data ?? null;
    } catch (err) {
        logger.error('[TestMode] getConversationById falló', err, { conversationId });
        return null;
    }
}

/**
 * Cierra la sesión: genera resumen con el sub-agente, lo inyecta como `system`
 * en la conversación admin, purga la conversación de test y notifica al staff.
 */
async function closeSession(params: {
    session: TestSession;
    reason: 'command' | 'timeout' | 'admin_force';
    company: any;
    staffPhone: string;
    phoneNumberId: string;
}): Promise<string> {
    const { session, reason, company, staffPhone, phoneNumberId } = params;

    // 1. Resumen ANTES de purgar (la purga borra los mensajes).
    const summary = await TestSummaryService.summarize(session.test_conversation_id);

    // 2. Cerrar la fila de sesión (con summary) y purgar la conversación de test.
    await TestModeService.endSession({ sessionId: session.id, reason, summary });
    await TestModeService.purgeTestConversation(session.test_conversation_id);

    // 3. Inyectar el resumen como mensaje `system` en la conversación admin
    //    para que Bruno lo tenga como contexto en próximos turnos.
    const header = reason === 'timeout'
        ? '--- Modo test cerrado por TIMEOUT. Resumen de la prueba ---'
        : reason === 'admin_force'
            ? '--- Modo test cerrado por admin_force. Resumen de la prueba ---'
            : '--- Modo test cerrado por /exit. Resumen de la prueba ---';

    await ClinicasDbService.saveMessage(
        session.admin_conversation_id,
        company.id,
        'system',
        `${header}\n${summary}`,
        { test_session_id: session.id, reason }
    );

    // 4. Confirmar al staff (solo cuando salió por comando; en timeout el aviso
    //    lo da el llamador antes del passthrough).
    if (reason === 'command') {
        try {
            await KapsoService.enviarMensaje(staffPhone, TEST_MODE_COPY.exited(summary), phoneNumberId);
        } catch (err) {
            logger.error('[TestMode] fallo al enviar mensaje de salida al staff', err);
        }
    }

    return summary;
}

export async function processTestModeTurn(ctx: TestModeContext): Promise<TestModeOutcome> {
    const {
        event, company, staffMember, session, adminConversationId,
        from, text, phoneNumberId, messageId, messageType,
    } = ctx;

    const cmd = normalizeCommand(text);

    // ─── Caso 1: NO hay sesión y el mensaje es /test → abrir ────────────────
    if (!session) {
        if (cmd !== TEST_MODE_COMMANDS.START) {
            // No es /test y no hay sesión → devolvemos passthrough para que
            // el controller siga con el pipeline admin normal.
            return 'passthrough_admin';
        }

        try {
            const fresh = await TestModeService.startSession({
                company, staff: staffMember, staffPhone: from, adminConversationId,
            });

            const mins = Math.round(TEST_MODE_TTL_MS / 60000);
            await KapsoService.enviarMensaje(from, TEST_MODE_COPY.start(mins), phoneNumberId);

            // Guardar el /test entrante en la conversación admin (para trazabilidad)
            await ClinicasDbService.saveMessage(
                adminConversationId, company.id, 'contact', text,
                { raw_payload: event, message_type: messageType, phone_number_id: phoneNumberId, test_command: 'start', test_session_id: fresh.id }
            );
            return 'handled';
        } catch (err) {
            logger.error('[TestMode] startSession falló', err);
            await KapsoService.enviarMensaje(
                from,
                'No pude abrir el modo test. Intentá de nuevo en un momento.',
                phoneNumberId
            ).catch(() => {});
            return 'handled';
        }
    }

    // ─── Caso 2: hay sesión pero expiró → cerrar + passthrough ──────────────
    if (TestModeService.isExpired(session)) {
        await closeSession({
            session, reason: 'timeout', company, staffPhone: from, phoneNumberId,
        });
        // Avisar al staff que la sesión expiró. Seguidamente, el mensaje
        // actual cae al pipeline admin normal (passthrough).
        try {
            await KapsoService.enviarMensaje(from, TEST_MODE_COPY.timeoutOnNextMessage, phoneNumberId);
        } catch {}
        return 'passthrough_admin';
    }

    // ─── Caso 3: hay sesión activa y el staff manda /exit ───────────────────
    if (cmd === TEST_MODE_COMMANDS.EXIT) {
        await closeSession({
            session, reason: 'command', company, staffPhone: from, phoneNumberId,
        });
        return 'handled';
    }

    // ─── Caso 4: /test cuando ya hay una activa ─────────────────────────────
    if (cmd === TEST_MODE_COMMANDS.START) {
        const remaining = TestModeService.remainingMinutes(session);
        await KapsoService.enviarMensaje(
            from, TEST_MODE_COPY.alreadyActive(remaining), phoneNumberId
        );
        return 'handled';
    }

    // ─── Caso 5: turno normal dentro del test ───────────────────────────────
    // El mensaje va a la conversación de test contra el agente público.
    const testConvId = session.test_conversation_id;
    const testConv   = await getConversationById(testConvId);
    const testContactId = testConv?.contact_id
        ?? await getContactIdForConversation(testConvId);
    const testContact = testContactId ? await getContactById(testContactId) : null;

    if (!testConv || !testContact) {
        logger.error('[TestMode] no se pudo resolver conversación/contacto de test', null, {
            sessionId: session.id, testConvId,
        });
        return 'handled';
    }

    // Guardar mensaje entrante en la conv de test (deduplicado si hay messageId).
    const incomingMetadata = {
        raw_payload: event, message_type: messageType,
        phone_number_id: phoneNumberId, test_session_id: session.id,
    };
    if (messageId) {
        const already = await ClinicasDbService.hasMessageByKapsoId(messageId);
        if (already) {
            logger.info('[TestMode] messageId duplicado dentro del test, skip', { messageId });
            return 'handled';
        }
        await ClinicasDbService.saveMessageDeduped(
            testConvId, company.id, 'contact', text || '[mensaje vacío]',
            messageId, incomingMetadata
        );
    } else {
        await ClinicasDbService.saveMessage(
            testConvId, company.id, 'contact', text || '[mensaje vacío]', incomingMetadata
        );
    }

    // Cargar historial y generar respuesta del agente público.
    const agent = await ClinicasDbService.getActiveAgent(company.id);
    const historial = await ClinicasDbService.getHistorial(testConvId, 25);

    // Vista con status='prospecto' — el registro real del staff sigue intacto.
    const contactView = { ...testContact, status: 'prospecto' };

    let respuesta: string | null = '';
    try {
        respuesta = await AiService.generarRespuestaClinicas(
            historial, agent, contactView, testConv, phoneNumberId, company, null
        );
    } catch (err) {
        logger.error('[TestMode] generarRespuestaClinicas falló', err);
        await KapsoService.enviarMensaje(
            from,
            '(test) El agente falló generando respuesta. Revisá los logs.',
            phoneNumberId
        ).catch(() => {});
        return 'handled';
    }

    // null = noReply ; '' = tool interactiva ya envió ; texto = normal
    if (respuesta === null) return 'handled';
    if (!respuesta || !respuesta.trim()) return 'handled';

    await ClinicasDbService.saveMessage(testConvId, company.id, 'agent', respuesta);
    try {
        await KapsoService.enviarMensaje(from, respuesta, phoneNumberId);
    } catch (err) {
        logger.error('[TestMode] fallo al enviar respuesta de test al staff', err);
    }
    return 'handled';
}
