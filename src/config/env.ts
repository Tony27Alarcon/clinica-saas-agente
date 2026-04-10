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
    KAPSO_PHONE_NUMBER_ID: process.env.KAPSO_PHONE_NUMBER_ID || '',
    KAPSO_WEBHOOK_SECRET: process.env.KAPSO_WEBHOOK_SECRET || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',

    /**
     * Teléfono del equipo de soporte (E.164 sin "+", ej: 573117391515).
     * Recibe notificaciones por WhatsApp cuando Clara tiene un error de
     * sistema. Si está vacío, no se intenta notificar (solo se loggea).
     */
    SUPPORT_PHONE_NUMBER: normalizePhoneEnv(process.env.SUPPORT_PHONE_NUMBER || ''),

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
};

// SUPPORT_PHONE_NUMBER es opcional; GOOGLE_* son opcionales (solo activan GCal si están presentes).
const optionalKeys = [
    'PORT', 'KAPSO_WEBHOOK_SECRET', 'SUPPORT_PHONE_NUMBER',
    'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GCAL_LOOK_AHEAD_DAYS',
];
const missing = Object.entries(env).filter(([k, v]) => !v && !optionalKeys.includes(k));
if (missing.length > 0) {
    console.warn(`[WARN] Faltan variables de entorno críticas: ${missing.map(m => m[0]).join(', ')}`);
}
