/**
 * smoke.ts — Ejecuta un smoke test completo del sistema en local.
 *
 * Encadena: health-check del servidor → seed → vitest (unit) → scenarios (E2E).
 * Si algún paso falla con un error bloqueante, se detiene. Los pasos opcionales
 * (scenarios) registran el fallo pero permiten ver el resumen final.
 *
 * Requisitos:
 *   - npm run dev corriendo en otra terminal
 *   - .env con SUPABASE_URL, SUPABASE_SERVICE_KEY, KAPSO_WEBHOOK_SECRET
 *
 * Uso:
 *   npm run test:smoke              — corre todo
 *   npm run test:smoke -- --no-seed — omite el seed (si ya lo corriste)
 *   npm run test:smoke -- --no-e2e  — omite los scenarios
 */
import { spawnSync } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
dotenv.config();

type StepResult = { name: string; passed: boolean; skipped?: boolean; durationMs: number };

const args = process.argv.slice(2);
const SKIP_SEED = args.includes('--no-seed');
const SKIP_E2E = args.includes('--no-e2e');
const SKIP_UNIT = args.includes('--no-unit');

const isWin = process.platform === 'win32';
const NPM = isWin ? 'npm.cmd' : 'npm';

function header(title: string) {
    const line = '═'.repeat(70);
    console.log(`\n${line}\n${title}\n${line}`);
}

function runNpmScript(script: string, extraArgs: string[] = []): boolean {
    // Windows: spawnSync(..., { shell: false }) con npm.cmd suele fallar con EINVAL;
    // hace que el smoke falle al instante en el paso seed/test/unit/e2e.
    const res = spawnSync(NPM, ['run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])], {
        stdio: 'inherit',
        shell: isWin,
    });
    return res.status === 0;
}

async function checkServerHealth(): Promise<boolean> {
    try {
        await axios.get(`${TEST_CONFIG.SERVER_URL}/`, { timeout: 3_000 });
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const results: StepResult[] = [];
    const t0 = Date.now();

    header('SMOKE TEST — Bruno Agente Agendador');
    console.log(`Servidor esperado: ${TEST_CONFIG.SERVER_URL}`);
    console.log(`Flags: ${SKIP_SEED ? '--no-seed ' : ''}${SKIP_UNIT ? '--no-unit ' : ''}${SKIP_E2E ? '--no-e2e' : ''}`.trim() || 'ninguno');

    // ── 1. Health check ──────────────────────────────────────────────────────
    header('PASO 1/4 — Health check del servidor');
    const healthStart = Date.now();
    const healthy = await checkServerHealth();
    results.push({ name: 'health-check', passed: healthy, durationMs: Date.now() - healthStart });
    if (!healthy) {
        console.error(`\n❌ No se puede conectar al servidor en ${TEST_CONFIG.SERVER_URL}.`);
        console.error('   Ejecuta "npm run dev" en otra terminal y volvé a intentar.\n');
        printSummary(results, t0);
        process.exit(1);
    }
    console.log(`✅ Servidor responde en ${TEST_CONFIG.SERVER_URL}`);

    // ── 2. Seed ──────────────────────────────────────────────────────────────
    header('PASO 2/4 — Seed de datos en Supabase');
    if (SKIP_SEED) {
        console.log('⏭️  Omitido (--no-seed)');
        results.push({ name: 'seed', passed: true, skipped: true, durationMs: 0 });
    } else {
        const seedStart = Date.now();
        const seedOk = runNpmScript('test:seed');
        results.push({ name: 'seed', passed: seedOk, durationMs: Date.now() - seedStart });
        if (!seedOk) {
            console.error('\n❌ Seed falló — no podemos continuar sin datos de prueba.\n');
            printSummary(results, t0);
            process.exit(1);
        }
    }

    // ── 3. Unit tests (vitest) ───────────────────────────────────────────────
    header('PASO 3/4 — Unit tests (vitest)');
    if (SKIP_UNIT) {
        console.log('⏭️  Omitido (--no-unit)');
        results.push({ name: 'unit-tests', passed: true, skipped: true, durationMs: 0 });
    } else {
        const unitStart = Date.now();
        const unitOk = runNpmScript('test');
        results.push({ name: 'unit-tests', passed: unitOk, durationMs: Date.now() - unitStart });
    }

    // ── 4. Scenarios (E2E contra servidor local) ─────────────────────────────
    header('PASO 4/4 — Scenarios E2E');
    if (SKIP_E2E) {
        console.log('⏭️  Omitido (--no-e2e)');
        results.push({ name: 'scenarios', passed: true, skipped: true, durationMs: 0 });
    } else {
        const e2eStart = Date.now();
        const e2eOk = runNpmScript('test:scenario');
        results.push({ name: 'scenarios', passed: e2eOk, durationMs: Date.now() - e2eStart });
    }

    // ── Resumen ──────────────────────────────────────────────────────────────
    printSummary(results, t0);
    const anyFailed = results.some(r => !r.passed && !r.skipped);
    process.exit(anyFailed ? 1 : 0);
}

function printSummary(results: StepResult[], t0: number) {
    header('RESUMEN SMOKE TEST');
    for (const r of results) {
        const icon = r.skipped ? '⏭️ ' : r.passed ? '✅' : '❌';
        const dur = r.skipped ? '—' : `${(r.durationMs / 1000).toFixed(1)}s`;
        console.log(`  ${icon} ${r.name.padEnd(20)} ${dur}`);
    }
    const total = ((Date.now() - t0) / 1000).toFixed(1);
    const failed = results.filter(r => !r.passed && !r.skipped).length;
    console.log('─'.repeat(70));
    console.log(`  Duración total: ${total}s — ${failed === 0 ? 'TODO OK ✅' : `${failed} fallo(s) ❌`}`);
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\nError fatal en smoke test:', err.message);
    process.exit(1);
});
