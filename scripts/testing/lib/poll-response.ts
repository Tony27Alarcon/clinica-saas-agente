import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './config';
dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);

// Mismo patrón que clinicas-db.service.ts
const db = () => (supabase as any).schema('clinicas');

/**
 * Busca la conversación abierta del contacto de prueba.
 * Retorna null si el contacto o la conversación aún no existen.
 */
export async function findTestConversation(
    companyId: string,
    userPhone: string = TEST_CONFIG.TEST_USER_PHONE
): Promise<string | null> {
    const { data: contact } = await db()
        .from('contacts')
        .select('id')
        .eq('company_id', companyId)
        .eq('phone', userPhone)
        .maybeSingle();

    if (!contact) return null;

    const { data: conv } = await db()
        .from('conversations')
        .select('id')
        .eq('contact_id', contact.id)
        .in('status', ['open', 'escalated', 'waiting'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    return conv?.id ?? null;
}

/**
 * Espera hasta que aparezca la conversación del contacto de prueba.
 * Útil para el primer mensaje, cuando la conversación se crea en background.
 */
export async function waitForConversation(
    companyId: string,
    timeoutMs = 8_000
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const convId = await findTestConversation(companyId);
        if (convId) return convId;
        await sleep(TEST_CONFIG.POLL_INTERVAL_MS);
    }
    throw new Error(
        'Timeout: no se creó la conversación. ' +
        'Verifica que el servidor esté corriendo y que el seed esté aplicado.'
    );
}

/**
 * Hace polling a clinicas.messages esperando un mensaje de role='agent'
 * guardado después de afterTimestamp.
 *
 * Retorna el contenido del mensaje cuando lo encuentra,
 * o lanza error si no llega en POLL_TIMEOUT_MS.
 */
export async function pollForAgentResponse(
    conversationId: string,
    afterTimestamp: string
): Promise<string> {
    const deadline = Date.now() + TEST_CONFIG.POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const { data: messages } = await db()
            .from('messages')
            .select('content, created_at')
            .eq('conversation_id', conversationId)
            .eq('role', 'agent')
            .gt('created_at', afterTimestamp)
            .order('created_at', { ascending: false })
            .limit(1);

        if (messages && messages.length > 0) {
            return messages[0].content as string;
        }

        await sleep(TEST_CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error(
        `Timeout: el agente no respondió en ${TEST_CONFIG.POLL_TIMEOUT_MS / 1000}s. ` +
        'Revisa los logs del servidor (Terminal 1) para ver si hubo un error.'
    );
}

/**
 * Retorna los últimos N mensajes de una conversación, en orden cronológico.
 */
export async function getRecentMessages(
    conversationId: string,
    limit = 20
): Promise<Array<{ role: string; content: string; created_at: string }>> {
    const { data } = await db()
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);

    return ((data as any[]) || []).reverse();
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
