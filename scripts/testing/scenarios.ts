/**
 * scenarios.ts — Escenarios de conversación predefinidos para testing automático.
 *
 * Ejecuta conversaciones completas sin intervención manual para verificar
 * que el agente responde correctamente en los flujos clave.
 *
 * Uso:
 *   npm run test:scenario                     — corre todos los escenarios
 *   npm run test:scenario -- consulta-precios — corre uno específico
 *
 * Requisitos:
 *   - npm run dev corriendo en otra terminal
 *   - npm run test:seed ejecutado al menos una vez
 */
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
import { sendWebhookMessage } from './lib/webhook-client';
import { waitForConversation, pollForAgentResponse } from './lib/poll-response';
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

// ── Definición de escenarios ──────────────────────────────────────────────────

interface Scenario {
    name: string;
    description: string;
    messages: string[];
    setup?: 'fresh'; // Si 'fresh', envía /borrar antes de empezar
}

const SCENARIOS: Scenario[] = [
    {
        name: 'consulta-precios',
        description: 'Usuario pregunta por información y precios de botox',
        setup: 'fresh',
        messages: [
            'Hola, quiero información sobre el botox',
            '¿Cuánto cuesta más o menos?',
            '¿Cuánto dura el efecto?',
        ],
    },
    {
        name: 'intento-agendar',
        description: 'Usuario calificado busca disponibilidad para agendar',
        setup: 'fresh',
        messages: [
            'Buenas, me interesa el relleno de labios',
            'Tengo presupuesto disponible, ¿qué disponibilidad tienen esta semana?',
            'El jueves en la tarde me viene perfecto',
        ],
    },
    {
        name: 'escalacion-humano',
        description: 'Usuario solicita hablar con una persona del equipo',
        setup: 'fresh',
        messages: [
            'Hola buenas',
            'Necesito hablar con alguien del equipo, por favor',
        ],
    },
    {
        name: 'objection-precio',
        description: 'Usuario dice que el precio es muy caro',
        setup: 'fresh',
        messages: [
            'Hola, me interesa la limpieza facial',
            'Uy, $80 me parece bastante caro para una limpieza',
            'No sé, déjame pensarlo...',
        ],
    },
    {
        name: 'mensaje-corto',
        description: 'Verificar que el agente responde a mensajes muy cortos',
        setup: 'fresh',
        messages: [
            'Hola',
            'Info',
        ],
    },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario, companyId: string): Promise<boolean> {
    const pad = '  ';
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`ESCENARIO: ${scenario.name}`);
    console.log(`           ${scenario.description}`);
    console.log('═'.repeat(70));

    try {
        // Setup: borrar historial para empezar limpio
        if (scenario.setup === 'fresh') {
            await sendWebhookMessage({ text: '/borrar' });
            await sleep(1_500);
        }

        for (const userText of scenario.messages) {
            const beforeTimestamp = new Date().toISOString();
            console.log(`\n${pad}TU    > ${userText}`);

            await sendWebhookMessage({ text: userText });

            const convId = await waitForConversation(companyId);
            const response = await pollForAgentResponse(convId, beforeTimestamp);

            console.log(`${pad}AGENTE > ${response}`);
        }

        console.log(`\n${pad}✅ PASÓ`);
        return true;
    } catch (err: any) {
        console.log(`\n${pad}❌ FALLÓ: ${err.message}`);
        return false;
    }
}

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

    // ── Seleccionar escenarios a correr ──────────────────────────────────────
    const arg = process.argv[2];
    const scenariosToRun = arg
        ? SCENARIOS.filter(s => s.name === arg)
        : SCENARIOS;

    if (scenariosToRun.length === 0) {
        const names = SCENARIOS.map(s => `  - ${s.name}`).join('\n');
        console.error(`\n❌ Escenario "${arg}" no encontrado. Disponibles:\n${names}\n`);
        process.exit(1);
    }

    console.log(`\nEjecutando ${scenariosToRun.length} escenario(s) contra "${company.name}"\n`);

    // ── Correr escenarios en secuencia ───────────────────────────────────────
    const results: Array<{ name: string; passed: boolean }> = [];

    for (const scenario of scenariosToRun) {
        const passed = await runScenario(scenario, company.id);
        results.push({ name: scenario.name, passed });
        // Pausa breve entre escenarios para no saturar la IA
        if (scenariosToRun.indexOf(scenario) < scenariosToRun.length - 1) {
            await sleep(2_000);
        }
    }

    // ── Resumen final ────────────────────────────────────────────────────────
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\n${'═'.repeat(70)}`);
    console.log('RESUMEN');
    console.log('═'.repeat(70));
    for (const r of results) {
        console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`);
    }
    console.log('─'.repeat(70));
    console.log(`  Total: ${passed} pasaron, ${failed} fallaron de ${results.length}`);
    console.log('═'.repeat(70) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
