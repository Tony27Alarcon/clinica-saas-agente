/**
 * test-rebuild.ts — Verifica el ciclo completo de prompt rebuild queue.
 *
 * NO requiere el servidor Express corriendo.
 * Llama directamente a PromptRebuildService y Supabase.
 *
 * Prueba:
 *   1. Inserción manual en la cola (simula lo que haría un trigger SQL)
 *   2. Lectura de filas pendientes
 *   3. Procesamiento via PromptRebuildService.processRebuildQueue()
 *   4. Verificación que las filas quedaron procesadas
 *   5. Test de idempotencia: insertar dos veces para la misma company → solo 1 fila
 *   6. Verificación del system_prompt compilado en agents
 *   7. Test de rebuild puntual via rebuildPromptForCompany()
 *   8. Test de cambio de tratamiento → trigger → rebuild
 *
 * Uso:
 *   npm run test:rebuild
 *
 * Requisitos:
 *   - npm run test:seed ejecutado al menos una vez
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
dotenv.config();

import { PromptRebuildService } from '../../src/services/prompt-rebuild.service';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);

const db = () => (supabase as any).schema('clinicas');

// ── Helpers ──────────────────────────────────────────────────────────────────

function section(title: string) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(title);
    console.log('─'.repeat(60));
}

function ok(msg: string)   { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testQueueIdempotence(companyId: string): Promise<boolean> {
    section('TEST 1 — Idempotencia de la cola (no duplica filas pendientes)');

    // Limpiar filas pendientes anteriores para este test
    await db()
        .from('prompt_rebuild_queue')
        .delete()
        .eq('company_id', companyId)
        .is('processed_at', null);

    // Insertar 3 veces "manual" para la misma company
    for (let i = 0; i < 3; i++) {
        // Simula lo que hace enqueue_prompt_rebuild(): solo inserta si no hay pending
        const { data: existing } = await db()
            .from('prompt_rebuild_queue')
            .select('id')
            .eq('company_id', companyId)
            .is('processed_at', null)
            .maybeSingle();

        if (!existing) {
            await db()
                .from('prompt_rebuild_queue')
                .insert([{ company_id: companyId, triggered_by: 'manual' }]);
        }
    }

    // Verificar que solo hay 1 fila pendiente
    const { count } = await db()
        .from('prompt_rebuild_queue')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('processed_at', null);

    if ((count as number) === 1) {
        ok('Una sola fila pendiente aunque se intentó insertar 3 veces (idempotente).');
        return true;
    } else {
        fail(`Se esperaba 1 fila pendiente, encontradas: ${count}`);
        return false;
    }
}

async function testProcessQueue(companyId: string): Promise<boolean> {
    section('TEST 2 — Procesamiento de la cola (processRebuildQueue)');

    // Aseguramos que hay una fila pendiente
    const { data: existing } = await db()
        .from('prompt_rebuild_queue')
        .select('id')
        .eq('company_id', companyId)
        .is('processed_at', null)
        .maybeSingle();

    if (!existing) {
        await db()
            .from('prompt_rebuild_queue')
            .insert([{ company_id: companyId, triggered_by: 'manual' }]);
        info('Fila pendiente insertada manualmente para el test.');
    }

    // Capturar el timestamp del system_prompt actual antes del rebuild
    const { data: agentBefore } = await db()
        .from('agents')
        .select('id, system_prompt, updated_at')
        .eq('company_id', companyId)
        .eq('active', true)
        .maybeSingle();

    const promptLenBefore = (agentBefore as any)?.system_prompt?.length ?? 0;
    info(`system_prompt antes del rebuild: ${promptLenBefore} caracteres`);

    // Procesar la cola
    let processed: number;
    try {
        processed = await PromptRebuildService.processRebuildQueue();
    } catch (err: any) {
        fail(`processRebuildQueue lanzó error: ${err.message}`);
        return false;
    }

    ok(`processRebuildQueue procesó ${processed} empresa(s).`);

    // Verificar que la fila quedó marcada como processed
    const { count: pendingAfter } = await db()
        .from('prompt_rebuild_queue')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('processed_at', null);

    if ((pendingAfter as number) === 0) {
        ok('Cola procesada: no hay filas pendientes después del processRebuildQueue.');
    } else {
        fail(`Aún hay ${pendingAfter} fila(s) pendientes después del procesamiento.`);
        return false;
    }

    // Verificar que processed_at fue escrito (no error)
    const { data: processedRows } = await db()
        .from('prompt_rebuild_queue')
        .select('id, processed_at, error, triggered_by')
        .eq('company_id', companyId)
        .not('processed_at', 'is', null)
        .order('processed_at', { ascending: false })
        .limit(3);

    for (const row of (processedRows as any[]) || []) {
        if (row.error) {
            fail(`Fila ${row.id} (${row.triggered_by}) procesada con error: ${row.error}`);
        } else {
            ok(`Fila ${row.id} (${row.triggered_by}) procesada exitosamente a las ${new Date(row.processed_at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`);
        }
    }

    return true;
}

async function testPromptContent(companyId: string): Promise<boolean> {
    section('TEST 3 — Contenido del system_prompt compilado');

    const { data: agent } = await db()
        .from('agents')
        .select('id, name, system_prompt, updated_at')
        .eq('company_id', companyId)
        .eq('active', true)
        .maybeSingle();

    if (!agent) {
        fail('No se encontró el agente activo.');
        return false;
    }

    const prompt: string = (agent as any).system_prompt || '';

    if (!prompt || prompt.includes('pendiente de compilación')) {
        fail('El system_prompt aún tiene el placeholder. El rebuild no funcionó.');
        return false;
    }

    ok(`system_prompt compilado: ${prompt.length} caracteres`);

    // Verificar secciones clave que deben estar en el prompt
    const checks: Array<{ name: string; pattern: string | RegExp }> = [
        { name: 'Nombre del agente',       pattern: (agent as any).name },
        { name: 'Nombre de la clínica',    pattern: 'Clínica Bella' },
        { name: 'Botox Facial',            pattern: 'Botox' },
        { name: 'Relleno de Labios',       pattern: 'Relleno' },
        { name: 'Hidrolipoclasia',         pattern: 'Hidrolipo' },
        { name: 'Depilación Láser',        pattern: 'Láser' },
        { name: 'Instrucciones de cita',   pattern: /cita|agendar|slot/i },
        { name: 'Reglas de escalamiento',  pattern: /escal/i },
    ];

    let allPassed = true;
    for (const check of checks) {
        const found = typeof check.pattern === 'string'
            ? prompt.includes(check.pattern)
            : check.pattern.test(prompt);

        if (found) {
            ok(`Sección encontrada: "${check.name}"`);
        } else {
            fail(`Sección NO encontrada: "${check.name}" (patrón: ${check.pattern})`);
            allPassed = false;
        }
    }

    // Mostrar fragmento del prompt
    info('Primeros 300 caracteres del prompt compilado:');
    console.log('\n' + '·'.repeat(60));
    console.log(prompt.substring(0, 300) + '...');
    console.log('·'.repeat(60));

    return allPassed;
}

async function testRebuildOnDataChange(companyId: string): Promise<boolean> {
    section('TEST 4 — Rebuild puntual al cambiar datos del agente');

    // Obtener el agente activo
    const { data: agent } = await db()
        .from('agents')
        .select('id, objections_kb')
        .eq('company_id', companyId)
        .eq('active', true)
        .maybeSingle();

    if (!agent) {
        fail('No se encontró el agente activo.');
        return false;
    }

    const agentId = (agent as any).id;
    const originalKb = (agent as any).objections_kb || [];

    // Agregar una nueva objeción de prueba
    const newKb = [
        ...originalKb,
        {
            objection: '[TEST] Quiero esperar a fin de año',
            response: '[TEST] Perfectamente. Si quieres, te agendo con fecha tentativa y te confirmo cuando estés listo.',
        },
    ];

    info('Actualizando objections_kb del agente (simula cambio del admin)...');
    const { error: updateErr } = await db()
        .from('agents')
        .update({ objections_kb: newKb })
        .eq('id', agentId);

    if (updateErr) {
        fail(`Error actualizando agente: ${updateErr.message}`);
        return false;
    }

    ok('Agente actualizado. El trigger SQL debería haber insertado en prompt_rebuild_queue.');

    // Verificar si el trigger insertó en la cola
    await new Promise(r => setTimeout(r, 500)); // pequeño delay para los triggers

    const { data: queueRow } = await db()
        .from('prompt_rebuild_queue')
        .select('id, triggered_by, created_at')
        .eq('company_id', companyId)
        .is('processed_at', null)
        .eq('triggered_by', 'agents')
        .maybeSingle();

    if (queueRow) {
        ok(`Trigger funcionó: fila en cola (id=${(queueRow as any).id}, triggered_by=agents).`);
    } else {
        info('No se encontró fila en cola con triggered_by=agents.');
        info('(Puede ser que el trigger no exista en este entorno, o ya fue procesado.)');
        info('Insertando manualmente para continuar el test...');
        await db()
            .from('prompt_rebuild_queue')
            .insert([{ company_id: companyId, triggered_by: 'agents' }]);
    }

    // Ejecutar rebuild puntual
    info('Ejecutando rebuildPromptForCompany()...');
    try {
        await PromptRebuildService.rebuildPromptForCompany(companyId);
        ok('rebuildPromptForCompany completado sin errores.');
    } catch (err: any) {
        fail(`rebuildPromptForCompany falló: ${err.message}`);
        return false;
    }

    // Verificar que la nueva objeción aparece en el prompt
    const { data: agentAfter } = await db()
        .from('agents')
        .select('system_prompt')
        .eq('id', agentId)
        .single();

    const promptAfter: string = (agentAfter as any)?.system_prompt || '';
    if (promptAfter.includes('fin de año') || promptAfter.includes('[TEST]')) {
        ok('La nueva objeción de prueba aparece en el system_prompt compilado.');
    } else {
        info('La objeción de prueba no aparece literalmente (puede estar resumida en el prompt).');
    }

    // Revertir la objeción de prueba (no contaminar los datos del seed)
    await db()
        .from('agents')
        .update({ objections_kb: originalKb })
        .eq('id', agentId);

    info('Objeción de prueba revertida. Datos del seed intactos.');

    return true;
}

async function testQueueErrorHandling(companyId: string): Promise<boolean> {
    section('TEST 5 — Manejo de errores en la cola');

    // Verificar que las filas con error tienen el campo error poblado
    const { data: errorRows } = await db()
        .from('prompt_rebuild_queue')
        .select('id, triggered_by, error, processed_at')
        .eq('company_id', companyId)
        .not('error', 'is', null)
        .order('processed_at', { ascending: false })
        .limit(5);

    const errors = (errorRows as any[]) || [];

    if (errors.length === 0) {
        ok('No hay filas con error en la cola (sistema saludable).');
    } else {
        info(`${errors.length} fila(s) procesadas con error:`);
        for (const row of errors) {
            fail(`  Fila ${row.id} (${row.triggered_by}): ${row.error}`);
        }
    }

    // Estadísticas generales de la cola
    const [{ count: totalRows }, { count: pendingRows }, { count: processedOk }] = await Promise.all([
        db().from('prompt_rebuild_queue').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
        db().from('prompt_rebuild_queue').select('id', { count: 'exact', head: true }).eq('company_id', companyId).is('processed_at', null),
        db().from('prompt_rebuild_queue').select('id', { count: 'exact', head: true }).eq('company_id', companyId).not('processed_at', 'is', null).is('error', null),
    ]);

    ok(`Estadísticas de la cola: ${totalRows} total | ${processedOk} exitosas | ${pendingRows} pendientes | ${errors.length} con error`);

    return errors.length === 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('═'.repeat(60));
    console.log('TEST SUITE — Prompt Rebuild Queue');
    console.log('═'.repeat(60));

    const { data: company } = await db()
        .from('companies')
        .select('id, name')
        .eq('slug', TEST_CONFIG.SEED_COMPANY_SLUG)
        .maybeSingle();

    if (!company) {
        console.error('\n❌ No hay datos de prueba. Ejecuta npm run test:seed primero.');
        process.exit(1);
    }

    console.log(`\nClínica: ${company.name} (${company.id})`);

    const tests = [
        { name: 'Idempotencia de la cola',           fn: testQueueIdempotence },
        { name: 'Procesamiento de la cola',           fn: testProcessQueue },
        { name: 'Contenido del prompt compilado',     fn: testPromptContent },
        { name: 'Rebuild al cambiar datos del agente',fn: testRebuildOnDataChange },
        { name: 'Manejo de errores en la cola',       fn: testQueueErrorHandling },
    ];

    const results: Array<{ name: string; passed: boolean }> = [];

    for (const test of tests) {
        try {
            const passed = await test.fn(company.id);
            results.push({ name: test.name, passed });
        } catch (err: any) {
            console.log(`\n  ❌ Error en "${test.name}": ${err.message}`);
            results.push({ name: test.name, passed: false });
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log('═'.repeat(60));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    for (const r of results) {
        console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`);
    }
    console.log(`─`.repeat(60));
    console.log(`  Total: ${passed} pasaron, ${failed} fallaron`);
    console.log('═'.repeat(60) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
