/**
 * chat.ts — Chat interactivo en terminal para testing local.
 *
 * Simula una conversación de WhatsApp enviando mensajes al servidor local
 * y leyendo las respuestas del agente desde Supabase.
 *
 * Requisitos:
 *   - npm run dev corriendo en otra terminal
 *   - npm run test:seed ejecutado al menos una vez
 *
 * Uso:
 *   npm run test:chat
 *
 * Comandos disponibles:
 *   /borrar    — borra el historial (reinicia la conversación)
 *   /historial — muestra los últimos mensajes de la conversación
 *   /salir     — termina el chat
 */
import * as readline from 'readline';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
import { sendWebhookMessage } from './lib/webhook-client';
import {
    waitForConversation,
    pollForAgentResponse,
    findTestConversation,
    getRecentMessages,
} from './lib/poll-response';
dotenv.config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);
const db = () => (supabase as any).schema('clinicas');

async function main() {
    // ── Verificar servidor ───────────────────────────────────────────────────
    try {
        await axios.get(`${TEST_CONFIG.SERVER_URL}/`, { timeout: 3_000 });
    } catch {
        console.error(`\n❌ No se puede conectar al servidor en ${TEST_CONFIG.SERVER_URL}.`);
        console.error('Ejecuta "npm run dev" en otra terminal primero.\n');
        process.exit(1);
    }

    // ── Obtener clínica de prueba ────────────────────────────────────────────
    const { data: company } = await db()
        .from('companies')
        .select('id, name')
        .eq('slug', TEST_CONFIG.SEED_COMPANY_SLUG)
        .maybeSingle();

    if (!company) {
        console.error('\n❌ No hay datos de prueba en Supabase.');
        console.error('Ejecuta "npm run test:seed" primero.\n');
        process.exit(1);
    }

    // ── Header ───────────────────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log(`Chat de prueba — ${company.name}`);
    console.log(`Usuario: ${TEST_CONFIG.TEST_USER_PHONE}`);
    console.log(`Servidor: ${TEST_CONFIG.SERVER_URL}`);
    console.log('─'.repeat(60));
    console.log('Comandos: /borrar  /historial  /salir');
    console.log('─'.repeat(60) + '\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    const prompt = () => {
        rl.question('TU  > ', async (input) => {
            const text = input.trim();

            if (!text) {
                prompt();
                return;
            }

            if (text === '/salir') {
                console.log('\nCerrando chat de prueba. ¡Hasta luego!\n');
                rl.close();
                process.exit(0);
            }

            if (text === '/historial') {
                await printHistory(company.id);
                prompt();
                return;
            }

            if (text === '/borrar') {
                await handleBorrar();
                prompt();
                return;
            }

            await handleMessage(text, company.id);
            prompt();
        });
    };

    prompt();
}

async function handleMessage(text: string, companyId: string) {
    const beforeTimestamp = new Date().toISOString();

    try {
        await sendWebhookMessage({ text });
    } catch (err: any) {
        console.error(`\n❌ Error enviando webhook: ${err.message}\n`);
        return;
    }

    try {
        // El primer mensaje crea el contacto y la conversación en background.
        // waitForConversation espera hasta que aparezca en Supabase.
        const convId = await waitForConversation(companyId);
        const response = await pollForAgentResponse(convId, beforeTimestamp);

        console.log(`\nAGENTE > ${response}\n`);
    } catch (err: any) {
        console.error(`\n❌ ${err.message}\n`);
    }
}

async function handleBorrar() {
    try {
        await sendWebhookMessage({ text: '/borrar' });
        // KapsoService en modo offline loguea la confirmación en el servidor.
        // Aquí esperamos un momento para que el pipeline termine.
        await new Promise(resolve => setTimeout(resolve, 1_500));
        console.log('\nSISTEMA > Historial borrado. El próximo mensaje inicia una conversación nueva.\n');
    } catch (err: any) {
        console.error(`\n❌ Error en /borrar: ${err.message}\n`);
    }
}

async function printHistory(companyId: string) {
    const convId = await findTestConversation(companyId);

    if (!convId) {
        console.log('\nSISTEMA > No hay conversación activa todavía.\n');
        return;
    }

    const messages = await getRecentMessages(convId, 20);

    if (messages.length === 0) {
        console.log('\nSISTEMA > La conversación está vacía.\n');
        return;
    }

    console.log('\n' + '─'.repeat(40) + ' HISTORIAL ' + '─'.repeat(40));
    for (const msg of messages) {
        const prefix = msg.role === 'agent' ? 'AGENTE' : 'TU    ';
        const time = new Date(msg.created_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        console.log(`[${time}] ${prefix} > ${msg.content}`);
    }
    console.log('─'.repeat(91) + '\n');
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
