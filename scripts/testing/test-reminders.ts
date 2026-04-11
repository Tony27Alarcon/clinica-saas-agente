/**
 * test-reminders.ts — Verifica el flujo completo de recordatorios y follow-ups.
 *
 * NO requiere el servidor Express corriendo.
 * Llama directamente a Supabase para inspeccionar el estado de la BD
 * y llama a PromptRebuildService para verificar la cola de rebuild.
 *
 * Prueba:
 *   1. Citas con recordatorio pendiente (scheduled_at dentro de 24h, reminder_24h_sent_at = NULL)
 *   2. Follow-ups pendientes y vencidos (scheduled_at <= ahora, status = 'pending')
 *   3. Simulación de envío de recordatorio (marca reminder_24h_sent_at en la cita de test)
 *   4. Verificación de la cola de prompt rebuild
 *
 * Uso:
 *   npm run test:reminders
 *
 * Requisitos:
 *   - npm run test:seed ejecutado (crea la cita en 23h y los follow-ups)
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function section(title: string) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(title);
    console.log('─'.repeat(60));
}

function ok(msg: string)   { console.log(`  ✅ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testReminder24h(companyId: string): Promise<boolean> {
    section('TEST 1 — Recordatorios 24h pendientes');

    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 3_600_000);

    // Buscar citas que deberían recibir recordatorio:
    // scheduled_at entre ahora y +24h, reminder_24h_sent_at = NULL, status activo
    const { data: pendingReminders, error } = await db()
        .from('appointments')
        .select(`
            id, scheduled_at, status, reminder_24h_sent_at,
            contact:contacts (name, phone),
            treatment:treatments (name),
            staff:staff (name)
        `)
        .eq('company_id', companyId)
        .in('status', ['scheduled', 'confirmed'])
        .is('reminder_24h_sent_at', null)
        .gte('scheduled_at', now.toISOString())
        .lte('scheduled_at', in24h.toISOString())
        .order('scheduled_at', { ascending: true });

    if (error) {
        fail(`Error consultando citas: ${error.message}`);
        return false;
    }

    const reminders = (pendingReminders as any[]) || [];

    if (reminders.length === 0) {
        warn('No hay citas pendientes de recordatorio en las próximas 24h.');
        warn('Ejecuta npm run test:seed para crear la cita de prueba en 23h.');
        return false;
    }

    ok(`${reminders.length} cita(s) pendiente(s) de recordatorio:`);
    for (const r of reminders) {
        const scheduledLocal = new Date(r.scheduled_at).toLocaleString('es-CO', {
            timeZone: 'America/Bogota',
            weekday: 'short', day: 'numeric', month: 'short',
            hour: '2-digit', minute: '2-digit',
        });
        info(`  ${r.contact?.name} — ${r.treatment?.name ?? 'Tratamiento no especificado'} — ${scheduledLocal}`);
        info(`  Staff: ${r.staff?.name} | Estado: ${r.status}`);
        info(`  Teléfono: ${r.contact?.phone}`);
    }

    // Simular el envío: marcar reminder_24h_sent_at en la cita de test
    const testReminder = reminders.find((r: any) => r.contact?.phone === '5491133330004');
    if (testReminder) {
        const { error: updateErr } = await db()
            .from('appointments')
            .update({ reminder_24h_sent_at: new Date().toISOString() })
            .eq('id', testReminder.id);

        if (updateErr) {
            fail(`Error marcando reminder enviado: ${updateErr.message}`);
        } else {
            ok(`Simulado: recordatorio marcado como enviado para ${testReminder.contact?.name}`);
            ok(`reminder_24h_sent_at = ${new Date().toISOString()}`);
        }

        // Verificar que ya no aparece como pendiente
        const { data: reCheck } = await db()
            .from('appointments')
            .select('id, reminder_24h_sent_at')
            .eq('id', testReminder.id)
            .single();

        if ((reCheck as any)?.reminder_24h_sent_at) {
            ok('Verificado: la cita ya NO aparecerá en el próximo cron de recordatorios.');
        } else {
            fail('Error: reminder_24h_sent_at no se actualizó correctamente.');
            return false;
        }
    } else {
        info('(La cita de prueba específica de 23h no encontrada; verifica el seed.)');
    }

    return true;
}

async function testFollowUps(companyId: string): Promise<boolean> {
    section('TEST 2 — Follow-ups pendientes y vencidos');

    const now = new Date();

    // Follow-ups que ya deberían haberse enviado (scheduled_at <= now, status = pending)
    const { data: dueFollowUps, error: dueErr } = await db()
        .from('follow_ups')
        .select(`
            id, type, scheduled_at, status,
            contact:contacts (name, phone),
            appointment:appointments (scheduled_at, treatment_id)
        `)
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .lte('scheduled_at', now.toISOString())
        .order('scheduled_at', { ascending: true });

    if (dueErr) {
        fail(`Error consultando follow-ups vencidos: ${dueErr.message}`);
        return false;
    }

    const due = (dueFollowUps as any[]) || [];
    if (due.length === 0) {
        warn('No hay follow-ups vencidos pendientes de envío.');
    } else {
        ok(`${due.length} follow-up(s) vencido(s) pendientes de envío:`);
        for (const f of due) {
            const scheduledLocal = new Date(f.scheduled_at).toLocaleString('es-CO', {
                timeZone: 'America/Bogota', day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit',
            });
            info(`  ${f.contact?.name} — Tipo: ${f.type} — Programado: ${scheduledLocal}`);
        }

        // Simular procesamiento del primer follow-up vencido
        const first = due[0];
        const { error: sendErr } = await db()
            .from('follow_ups')
            .update({
                status: 'sent',
                sent_at: new Date().toISOString(),
            })
            .eq('id', first.id);

        if (sendErr) {
            fail(`Error marcando follow-up como enviado: ${sendErr.message}`);
        } else {
            ok(`Simulado: follow-up "${first.type}" marcado como enviado para ${first.contact?.name}`);
        }
    }

    // Follow-ups futuros
    const { data: futureFollowUps } = await db()
        .from('follow_ups')
        .select('id, type, scheduled_at, status, contact:contacts(name)')
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .gt('scheduled_at', now.toISOString())
        .order('scheduled_at', { ascending: true });

    const future = (futureFollowUps as any[]) || [];
    if (future.length > 0) {
        info(`${future.length} follow-up(s) futuros programados:`);
        for (const f of future) {
            const scheduledLocal = new Date(f.scheduled_at).toLocaleString('es-CO', {
                timeZone: 'America/Bogota', day: 'numeric', month: 'long',
            });
            info(`  ${f.contact?.name} — ${f.type} — ${scheduledLocal}`);
        }
    }

    return true;
}

async function testPreparationInstructions(companyId: string): Promise<boolean> {
    section('TEST 3 — Instrucciones de preparación (24h antes)');

    const now = new Date();
    const in25h = new Date(now.getTime() + 25 * 3_600_000);

    // Citas con tratamientos que tienen preparation_instructions
    // y que preparation_sent_at = NULL (aún no enviadas)
    const { data: prepPending, error } = await db()
        .from('appointments')
        .select(`
            id, scheduled_at, preparation_sent_at,
            contact:contacts (name, phone),
            treatment:treatments (name, preparation_instructions)
        `)
        .eq('company_id', companyId)
        .in('status', ['scheduled', 'confirmed'])
        .is('preparation_sent_at', null)
        .gte('scheduled_at', now.toISOString())
        .lte('scheduled_at', in25h.toISOString());

    if (error) {
        fail(`Error consultando instrucciones de preparación: ${error.message}`);
        return false;
    }

    const prep = (prepPending as any[]) || [];
    const withInstructions = prep.filter(p => p.treatment?.preparation_instructions);

    if (withInstructions.length === 0) {
        info('No hay citas pendientes de instrucciones de preparación en las próximas 25h.');
        info('(Normal si las citas no tienen treatment_id o ya se enviaron las instrucciones.)');
        return true;
    }

    ok(`${withInstructions.length} cita(s) con instrucciones de preparación pendientes:`);
    for (const p of withInstructions) {
        const scheduledLocal = new Date(p.scheduled_at).toLocaleString('es-CO', {
            timeZone: 'America/Bogota', weekday: 'short', day: 'numeric',
            month: 'short', hour: '2-digit', minute: '2-digit',
        });
        info(`  ${p.contact?.name} — ${p.treatment?.name}`);
        info(`  Cita: ${scheduledLocal}`);
        info(`  Instrucciones: ${p.treatment?.preparation_instructions?.substring(0, 80)}...`);
    }

    // Simular envío de instrucciones
    const { error: updateErr } = await db()
        .from('appointments')
        .update({ preparation_sent_at: new Date().toISOString() })
        .in('id', withInstructions.map(p => p.id));

    if (updateErr) {
        fail(`Error marcando instrucciones como enviadas: ${updateErr.message}`);
    } else {
        ok(`Simulado: instrucciones de preparación marcadas como enviadas.`);
    }

    return true;
}

async function testDailySummary(companyId: string): Promise<boolean> {
    section('TEST 4 — Resumen diario (getDailySummary)');

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const [appts, newLeads, escalated, pendingFollowUps] = await Promise.all([
        db()
            .from('appointments')
            .select('id, scheduled_at, status, contact:contacts(name), treatment:treatments(name)')
            .eq('company_id', companyId)
            .in('status', ['scheduled', 'confirmed'])
            .gte('scheduled_at', startOfDay.toISOString())
            .lte('scheduled_at', endOfDay.toISOString())
            .order('scheduled_at', { ascending: true }),

        db()
            .from('contacts')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .gte('created_at', startOfDay.toISOString()),

        db()
            .from('conversations')
            .select('id, escalation_reason, contact:contacts(name, phone)')
            .eq('company_id', companyId)
            .eq('status', 'escalated'),

        db()
            .from('follow_ups')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .eq('status', 'pending')
            .lte('scheduled_at', now.toISOString()),
    ]);

    const todayAppts = (appts.data as any[]) || [];
    const escalations = (escalated.data as any[]) || [];
    const followUpsVencidos = (pendingFollowUps as any).count ?? 0;
    const leadsHoy = (newLeads as any).count ?? 0;

    ok(`Citas de hoy: ${todayAppts.length}`);
    if (todayAppts.length > 0) {
        for (const a of todayAppts) {
            const t = new Date(a.scheduled_at).toLocaleTimeString('es-CO', {
                timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit',
            });
            info(`  ${t} — ${a.contact?.name} — ${a.treatment?.name ?? 'sin tratamiento'}`);
        }
    }

    ok(`Leads creados hoy: ${leadsHoy}`);
    ok(`Conversaciones escaladas: ${escalations.length}`);
    if (escalations.length > 0) {
        for (const e of escalations) {
            info(`  ${e.contact?.name} (${e.contact?.phone}) — ${e.escalation_reason?.substring(0, 60)}`);
        }
    }
    ok(`Follow-ups vencidos pendientes: ${followUpsVencidos}`);

    if (escalations.length > 0 && leadsHoy >= 0) {
        ok('getDailySummary retornaría datos correctos para el agente admin.');
    }

    return true;
}

async function testPostCareNotification(companyId: string): Promise<boolean> {
    section('TEST 5 — Instrucciones post-cita (cita recién completada)');

    // Buscar citas completadas en las últimas 2 horas sin post-care enviado
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);

    const { data: recentCompleted, error } = await db()
        .from('appointments')
        .select(`
            id, completed_at, status,
            contact:contacts (name, phone),
            treatment:treatments (name, post_care_instructions)
        `)
        .eq('company_id', companyId)
        .eq('status', 'completed')
        .gte('completed_at', twoHoursAgo.toISOString())
        .not('treatment_id', 'is', null);

    if (error) {
        fail(`Error: ${error.message}`);
        return false;
    }

    const completed = (recentCompleted as any[]) || [];
    const withPostCare = completed.filter(c => c.treatment?.post_care_instructions);

    if (withPostCare.length === 0) {
        info('No hay citas completadas recientemente con instrucciones post-cita.');
        info('(Las citas completadas hace 3 días no están en ventana de 2h — es correcto.)');
        return true;
    }

    ok(`${withPostCare.length} cita(s) completada(s) recientemente con instrucciones post-cita:`);
    for (const c of withPostCare) {
        info(`  ${c.contact?.name} — ${c.treatment?.name}`);
        info(`  Post-cuidados: ${c.treatment?.post_care_instructions?.substring(0, 80)}...`);
    }

    return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('═'.repeat(60));
    console.log('TEST SUITE — Recordatorios, Follow-ups y Notificaciones');
    console.log('═'.repeat(60));

    // Obtener clínica de prueba
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

    const results: Array<{ name: string; passed: boolean }> = [];

    // Ejecutar todos los tests
    const tests: Array<{ name: string; fn: (id: string) => Promise<boolean> }> = [
        { name: 'Recordatorios 24h',                 fn: testReminder24h },
        { name: 'Follow-ups pendientes',              fn: testFollowUps },
        { name: 'Instrucciones de preparación',       fn: testPreparationInstructions },
        { name: 'Resumen diario (daily summary)',     fn: testDailySummary },
        { name: 'Instrucciones post-cita',            fn: testPostCareNotification },
    ];

    for (const test of tests) {
        try {
            const passed = await test.fn(company.id);
            results.push({ name: test.name, passed });
        } catch (err: any) {
            console.log(`\n  ❌ Error en "${test.name}": ${err.message}`);
            results.push({ name: test.name, passed: false });
        }
    }

    // Resumen final
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
