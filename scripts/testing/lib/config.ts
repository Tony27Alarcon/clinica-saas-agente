import dotenv from 'dotenv';
dotenv.config();

export const TEST_CONFIG = {
    // URL del servidor local — debe estar corriendo con npm run dev
    SERVER_URL: process.env.TEST_SERVER_URL || 'http://localhost:3000',

    // El provider_id que se inserta en clinicas.channels.
    // Úsalo también en TEST_PHONE_NUMBER_ID del .env para personalizarlo.
    PHONE_NUMBER_ID: process.env.TEST_PHONE_NUMBER_ID || 'TEST_PHONE_001',

    // Número del usuario simulado (no debe ser real — nunca se envía a WhatsApp)
    TEST_USER_PHONE: process.env.TEST_USER_PHONE || '5491199999999',
    TEST_USER_NAME: 'Usuario de Prueba',

    // Número del staff de prueba — activa el pipeline de admin
    TEST_ADMIN_PHONE: process.env.TEST_ADMIN_PHONE || '5491100000001',
    TEST_ADMIN_NAME: 'Dr. Martín García',

    // Número del paciente de prueba para escenarios de admin
    TEST_PATIENT_PHONE: process.env.TEST_PATIENT_PHONE || '5571100000002',
    TEST_PATIENT_NAME: 'María González',

    // Slug de la clínica de prueba (no modificar)
    SEED_COMPANY_SLUG: 'clinica-test-local',

    // Tiempo máximo de espera para respuesta del agente (ms)
    POLL_TIMEOUT_MS: 30_000,
    // Intervalo de polling a Supabase (ms)
    POLL_INTERVAL_MS: 1_000,

    // Secret del webhook — lee del mismo .env del proyecto
    WEBHOOK_SECRET: process.env.KAPSO_WEBHOOK_SECRET || '',
};
