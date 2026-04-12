/**
 * Test de permisos Google Calendar OAuth 2.0
 *
 * Verifica:
 * 1. Variables de entorno configuradas
 * 2. Formato del JSON de credenciales
 * 3. Generación de URL de autorización (consent screen)
 * 4. Validez del client_id + client_secret contra Google
 * 5. Si hay refresh_tokens guardados en BD, prueba acceso real al calendario
 */

import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';

// ─── Colores para consola ──────────────────────────────────────────────────
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red   = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green('✓ PASS');
const FAIL = red('✗ FAIL');
const WARN = yellow('⚠ WARN');

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg: string) { console.log(`  ${PASS}  ${msg}`); passed++; }
function fail(msg: string, detail?: string) {
    console.log(`  ${FAIL}  ${msg}`);
    if (detail) console.log(`         ${red(detail)}`);
    failed++;
}
function warn(msg: string) { console.log(`  ${WARN}  ${msg}`); warned++; }

// ─── Tests ─────────────────────────────────────────────────────────────────

async function main() {
    console.log(bold('\n═══ Test de Permisos Google Calendar ═══\n'));

    // ── 1. Variables de entorno ──────────────────────────────────────────
    console.log(bold('1. Variables de entorno'));

    const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const saJson       = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    clientId     ? pass('GOOGLE_OAUTH_CLIENT_ID presente')     : fail('GOOGLE_OAUTH_CLIENT_ID no definido');
    clientSecret ? pass('GOOGLE_OAUTH_CLIENT_SECRET presente') : fail('GOOGLE_OAUTH_CLIENT_SECRET no definido');
    redirectUri  ? pass('GOOGLE_OAUTH_REDIRECT_URI presente')  : fail('GOOGLE_OAUTH_REDIRECT_URI no definido');
    saJson       ? pass('GOOGLE_SERVICE_ACCOUNT_JSON presente') : warn('GOOGLE_SERVICE_ACCOUNT_JSON no definido (solo OAuth disponible)');

    if (!clientId || !clientSecret || !redirectUri) {
        console.log(red('\n  Faltan credenciales OAuth básicas. Abortando.\n'));
        process.exit(1);
    }

    // ── 2. Formato del JSON de credenciales ─────────────────────────────
    console.log(bold('\n2. Formato de credenciales'));

    let parsedSa: any = null;
    if (saJson) {
        try {
            parsedSa = JSON.parse(saJson);
            pass('GOOGLE_SERVICE_ACCOUNT_JSON es JSON válido');

            if (parsedSa.web) {
                warn('GOOGLE_SERVICE_ACCOUNT_JSON contiene clave "web" — esto es un OAuth Client, NO un Service Account real');
                warn('Para usar Service Account necesitas un JSON con "private_key" y "client_email"');
            } else if (parsedSa.private_key && parsedSa.client_email) {
                pass('Service Account tiene private_key y client_email');
            } else {
                fail('Service Account JSON no tiene ni "web" ni "private_key" — formato irreconocible');
            }
        } catch (e: any) {
            fail('GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido', e.message);
        }
    }

    // Verificar que el client_id tiene formato correcto
    if (clientId.endsWith('.apps.googleusercontent.com')) {
        pass('GOOGLE_OAUTH_CLIENT_ID tiene formato correcto (*.apps.googleusercontent.com)');
    } else {
        fail('GOOGLE_OAUTH_CLIENT_ID no tiene formato esperado', `Valor: ${clientId}`);
    }

    // Verificar redirect URI
    if (redirectUri.startsWith('https://') || redirectUri.startsWith('http://localhost')) {
        pass(`Redirect URI: ${redirectUri}`);
    } else {
        warn(`Redirect URI no usa HTTPS: ${redirectUri}`);
    }

    // ── 3. Generar URL de autorización ──────────────────────────────────
    console.log(bold('\n3. Generación de URL de autorización (consent screen)'));

    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

    const scopes = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email',
        'openid',
    ];

    try {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent',
            state: Buffer.from(JSON.stringify({ staffId: 'test', companyId: 'test' })).toString('base64'),
        });
        pass('URL de autorización generada correctamente');
        console.log(`         ${yellow(authUrl.substring(0, 120))}...`);
    } catch (e: any) {
        fail('Error generando URL de autorización', e.message);
    }

    // ── 4. Validar credenciales contra Google Token Endpoint ────────────
    console.log(bold('\n4. Validación de credenciales OAuth contra Google'));

    try {
        // Intentamos un token refresh con un refresh_token inválido.
        // Si las credenciales (client_id + client_secret) son correctas,
        // Google responde "invalid_grant" (token malo).
        // Si las credenciales son inválidas, responde "invalid_client" o "unauthorized_client".
        oauth2Client.setCredentials({ refresh_token: 'INVALID_TEST_TOKEN' });
        await oauth2Client.getAccessToken();
        // Si llega aquí (no debería), algo raro pasa
        warn('getAccessToken no lanzó error con token inválido — inesperado');
    } catch (e: any) {
        const errorBody = e?.response?.data;
        const errorType = errorBody?.error || e.message || 'desconocido';

        if (errorType === 'invalid_grant') {
            pass('Client ID + Client Secret son VÁLIDOS (Google respondió "invalid_grant" — token de prueba rechazado, credenciales aceptadas)');
        } else if (errorType === 'invalid_client' || errorType === 'unauthorized_client') {
            fail('Client ID o Client Secret son INVÁLIDOS', `Google respondió: ${errorType} — ${errorBody?.error_description || ''}`);
        } else {
            warn(`Respuesta inesperada de Google: ${errorType} — ${errorBody?.error_description || e.message}`);
        }
    }

    // ── 5. Verificar tokens en BD (Supabase) ────────────────────────────
    console.log(bold('\n5. Tokens OAuth guardados en base de datos'));

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        warn('SUPABASE_URL o SUPABASE_SERVICE_KEY no configurados — saltando test de BD');
    } else {
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Buscar staff con refresh_token guardado
        const { data: staffWithTokens, error: staffErr } = await supabase
            .from('staff')
            .select('id, name, gcal_email, gcal_refresh_token, gcal_connected_at')
            .not('gcal_refresh_token', 'is', null)
            .limit(10);

        if (staffErr) {
            // Intentar con schema clinicas
            const { data: staffClinicas, error: staffErr2 } = await supabase
                .schema('clinicas' as any)
                .from('staff')
                .select('id, name, gcal_email, gcal_refresh_token, gcal_connected_at')
                .not('gcal_refresh_token', 'is', null)
                .limit(10);

            if (staffErr2) {
                warn(`No se pudo consultar staff: ${staffErr2.message}`);
            } else if (!staffClinicas || staffClinicas.length === 0) {
                warn('No hay staff con refresh_token guardado — nadie ha autorizado Google Calendar aún');
            } else {
                pass(`${staffClinicas.length} staff con refresh_token guardado`);
                for (const s of staffClinicas) {
                    console.log(`         → ${s.name || s.id} (${s.gcal_email || 'sin email'}) conectado: ${s.gcal_connected_at || 'desconocido'}`);
                    // Probar acceso real con el primer token
                    await testRealCalendarAccess(s, clientId, clientSecret, redirectUri);
                }
            }
        } else if (!staffWithTokens || staffWithTokens.length === 0) {
            warn('No hay staff con refresh_token guardado — nadie ha autorizado Google Calendar aún');
        } else {
            pass(`${staffWithTokens.length} staff con refresh_token guardado`);
            for (const s of staffWithTokens) {
                console.log(`         → ${s.name || s.id} (${s.gcal_email || 'sin email'}) conectado: ${s.gcal_connected_at || 'desconocido'}`);
                await testRealCalendarAccess(s, clientId, clientSecret, redirectUri);
            }
        }

        // Verificar gcal_config
        console.log(bold('\n6. Configuración de calendarios (gcal_config)'));

        const { data: configs, error: configErr } = await supabase
            .from('gcal_config')
            .select('*')
            .limit(10);

        if (configErr) {
            const { data: configsClinicas, error: configErr2 } = await supabase
                .schema('clinicas' as any)
                .from('gcal_config')
                .select('*')
                .limit(10);

            if (configErr2) {
                warn(`No se pudo consultar gcal_config: ${configErr2.message}`);
            } else if (!configsClinicas || configsClinicas.length === 0) {
                warn('No hay configuraciones de calendario (gcal_config vacío)');
            } else {
                pass(`${configsClinicas.length} configuración(es) de calendario encontrada(s)`);
                for (const c of configsClinicas) {
                    const mode = c.staff_id ? 'OAuth (staff personal)' : 'Service Account (compartido)';
                    console.log(`         → calendar_id: ${c.calendar_id} | modo: ${mode} | staff: ${c.staff_name || 'N/A'} | activo: ${c.active}`);
                }
            }
        } else if (!configs || configs.length === 0) {
            warn('No hay configuraciones de calendario (gcal_config vacío)');
        } else {
            pass(`${configs.length} configuración(es) de calendario encontrada(s)`);
            for (const c of configs) {
                const mode = c.staff_id ? 'OAuth (staff personal)' : 'Service Account (compartido)';
                console.log(`         → calendar_id: ${c.calendar_id} | modo: ${mode} | staff: ${c.staff_name || 'N/A'} | activo: ${c.active}`);
            }
        }
    }

    // ── Resumen ─────────────────────────────────────────────────────────
    console.log(bold('\n═══ Resumen ═══'));
    console.log(`  ${green(`${passed} pasaron`)}  ${failed > 0 ? red(`${failed} fallaron`) : '0 fallaron'}  ${warned > 0 ? yellow(`${warned} advertencias`) : '0 advertencias'}`);
    console.log();

    process.exit(failed > 0 ? 1 : 0);
}

/**
 * Prueba acceso real al calendario de un staff usando su refresh_token.
 */
async function testRealCalendarAccess(
    staff: { id: string; name?: string; gcal_email?: string; gcal_refresh_token: string },
    clientId: string,
    clientSecret: string,
    redirectUri: string
) {
    const label = staff.name || staff.gcal_email || staff.id;

    try {
        const oauth2 = new OAuth2Client(clientId, clientSecret, redirectUri);
        oauth2.setCredentials({ refresh_token: staff.gcal_refresh_token });

        const calendar = google.calendar({ version: 'v3', auth: oauth2 });

        // Test 1: Obtener lista de calendarios (prueba de permisos)
        const calList = await calendar.calendarList.list({ maxResults: 5 });
        pass(`[${label}] Acceso a calendarList OK — ${calList.data.items?.length || 0} calendario(s) visibles`);

        // Test 2: Consultar freebusy del calendario principal
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 86_400_000);
        const freebusyRes = await calendar.freebusy.query({
            requestBody: {
                timeMin: now.toISOString(),
                timeMax: tomorrow.toISOString(),
                timeZone: 'UTC',
                items: [{ id: 'primary' }],
            },
        });

        const busyCount = freebusyRes.data.calendars?.['primary']?.busy?.length || 0;
        pass(`[${label}] Freebusy query OK — ${busyCount} bloque(s) ocupado(s) en las próximas 24h`);

        // Test 3: Verificar scopes otorgados
        const tokenInfo = await oauth2.getAccessToken();
        if (tokenInfo.token) {
            pass(`[${label}] Access token obtenido correctamente (refresh funcional)`);
        }

    } catch (e: any) {
        const status = e?.response?.status;
        const errorMsg = e?.response?.data?.error?.message || e.message;

        if (status === 401 || e?.response?.data?.error === 'invalid_grant') {
            fail(`[${label}] Refresh token EXPIRADO o REVOCADO — el staff debe re-autorizar`, errorMsg);
        } else if (status === 403) {
            fail(`[${label}] Permisos INSUFICIENTES (scope faltante o API deshabilitada)`, errorMsg);
        } else {
            fail(`[${label}] Error inesperado al acceder al calendario`, `${status || ''} ${errorMsg}`);
        }
    }
}

main().catch(err => {
    console.error(red(`\nError fatal: ${err.message}`));
    process.exit(1);
});
