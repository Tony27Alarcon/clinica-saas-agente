import dotenv from 'dotenv';
dotenv.config();

/**
 * Normaliza un teléfono a E.164 sin signos (solo dígitos). Mismo criterio que
 * `DbService.normalizePhone`, pero replicado acá para evitar dependencias
 * circulares (env se carga antes que cualquier service).
 */
function normalizePhoneEnv(raw: string): string {
    return raw.replace(/\D+/g, '');
}

export const env = {
    PORT: process.env.PORT || 3000,
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    GEMINI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
    KAPSO_API_URL: process.env.KAPSO_API_URL || '',
    KAPSO_API_TOKEN: process.env.KAPSO_API_TOKEN || process.env.KAPSO_API_KEY || '',
    // URL base del host de Kapso (sin path). Si no se configura, se deriva de KAPSO_API_URL.
    // Ejemplo: https://api.kapso.ai
    KAPSO_API_BASE_URL: process.env.KAPSO_API_BASE_URL || '',
    KAPSO_PHONE_NUMBER_ID: process.env.KAPSO_PHONE_NUMBER_ID || '',
    KAPSO_WEBHOOK_SECRET: process.env.KAPSO_WEBHOOK_SECRET || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',

    /**
     * Teléfono del equipo de soporte (E.164 sin "+", ej: 573117391515).
     * Recibe notificaciones por WhatsApp cuando Clara tiene un error de
     * sistema. Si está vacío, no se intenta notificar (solo se loggea).
     */
    SUPPORT_PHONE_NUMBER: normalizePhoneEnv(process.env.SUPPORT_PHONE_NUMBER || ''),

    /**
     * Lista de teléfonos bloqueados (separados por coma). Cualquier mensaje
     * entrante o saliente de estos números se descarta sin contestar y sin
     * guardar nada en BD. Útil para silenciar bots, spam o números internos
     * que no deben generar tráfico al agente.
     * Formato libre — se normaliza a sólo dígitos. Ej: "573001112233,+52 1 55 1234 5678"
     */
    BLOCKED_PHONES: (process.env.BLOCKED_PHONES || '')
        .split(',')
        .map(p => normalizePhoneEnv(p))
        .filter(Boolean),

    // ─── Google Calendar (Service Account) ───────────────────────────────────
    /**
     * JSON completo del service account de Google Cloud, parseado desde la
     * variable de entorno. Las clínicas comparten su calendario con
     * client_email para permitir el acceso del agente.
     */
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON
        ? (() => { try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!); } catch { return null; } })()
        : null,

    /**
     * Email del service account. Se muestra a las clínicas durante el
     * onboarding para que sepan con quién compartir su Google Calendar.
     */
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',

    /**
     * Cuántos días hacia adelante buscar disponibilidad en Google Calendar.
     * Default: 14 días.
     */
    GCAL_LOOK_AHEAD_DAYS: parseInt(process.env.GCAL_LOOK_AHEAD_DAYS || '14', 10),

    // ─── Google OAuth 2.0 (permisos delegados por el staff) ─────────────────────
    /**
     * Credenciales OAuth de tipo "Web application" del mismo proyecto de Google Cloud.
     * El staff autoriza al sistema vía link para que cree citas a su nombre.
     */
    GOOGLE_OAUTH_CLIENT_ID:     process.env.GOOGLE_OAUTH_CLIENT_ID     || '',
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    /**
     * URI de redirección registrada en Google Cloud Console.
     * Debe coincidir exactamente: https://tu-dominio.railway.app/auth/google/callback
     */
    GOOGLE_OAUTH_REDIRECT_URI:  process.env.GOOGLE_OAUTH_REDIRECT_URI  || '',

    /**
     * Secret para endpoints internos (ej: /internal/rebuild-prompt).
     * Solo debe conocerlo el backend y los servicios administrativos.
     * Si está vacío, el endpoint queda deshabilitado.
     */
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET || '',

    /**
     * URL base del portal admin (Next.js en Vercel).
     * El agente admin la usa para generar y enviar el link de acceso al staff.
     * Ej: https://web-lovat-sigma-58.vercel.app
     */
    ADMIN_PORTAL_URL: process.env.ADMIN_PORTAL_URL || '',

    /**
     * URL base del onboarding de Kapso (embedded signup de WhatsApp Business).
     * Bruno se la envía al owner para que conecte su número. Se concatena con
     * `?company_id=...&slug=...` para correlacionar la conexión con el tenant.
     * Ej: https://app.kapso.ai/embed/signup
     */
    KAPSO_ONBOARDING_URL: process.env.KAPSO_ONBOARDING_URL || '',

    /**
     * UUID de la company "platform" (Bruno Lab). Debe coincidir con la fila
     * que tiene `clinicas.companies.kind = 'platform'` en BD. Cuando el webhook
     * resuelve el tenant a esta company, se activa el agente SuperAdmin (Bruno).
     */
    BRUNO_LAB_COMPANY_ID: process.env.BRUNO_LAB_COMPANY_ID || '',

    /**
     * URL base pública del servidor (sin trailing slash).
     * Se usa para construir callback_url y webhook_url en los links de onboarding.
     * Ej: https://clinica-saas-agente-production.up.railway.app
     *
     * Si no se configura, se intenta derivar de GOOGLE_OAUTH_REDIRECT_URI.
     */
    WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || '',
};

// SUPPORT_PHONE_NUMBER es opcional; GOOGLE_* son opcionales (solo activan GCal si están presentes).
// KAPSO_PHONE_NUMBER_ID es opcional porque para clínicas se extrae de la base de datos (multi-tenant).
const optionalKeys = [
    'PORT', 'KAPSO_WEBHOOK_SECRET', 'SUPPORT_PHONE_NUMBER', 'KAPSO_PHONE_NUMBER_ID',
    'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GCAL_LOOK_AHEAD_DAYS',
    'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI',
    'KAPSO_API_URL', 'KAPSO_API_TOKEN', 'KAPSO_API_BASE_URL', 'INTERNAL_API_SECRET',
    'ADMIN_PORTAL_URL', 'KAPSO_ONBOARDING_URL', 'BRUNO_LAB_COMPANY_ID',
    'BLOCKED_PHONES', 'WEBHOOK_BASE_URL',
];
const missing = Object.entries(env).filter(([k, v]) => !v && !optionalKeys.includes(k));
if (missing.length > 0) {
    console.warn(`[WARN] Faltan variables de entorno críticas: ${missing.map(m => m[0]).join(', ')}`);
}
