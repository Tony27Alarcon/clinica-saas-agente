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
    SUPPORT_PHONE_NUMBER: normalizePhoneEnv(process.env.SUPPORT_PHONE_NUMBER || '')
};

// SUPPORT_PHONE_NUMBER es opcional: si no está, las notificaciones de soporte
// degradan a "solo log CRITICAL" sin romper nada.
const optionalKeys = ['PORT', 'KAPSO_WEBHOOK_SECRET', 'SUPPORT_PHONE_NUMBER'];
const missing = Object.entries(env).filter(([k, v]) => !v && !optionalKeys.includes(k));
if (missing.length > 0) {
    console.warn(`[WARN] Faltan variables de entorno críticas: ${missing.map(m => m[0]).join(', ')}`);
}
