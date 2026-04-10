import axios from 'axios';
import { randomUUID } from 'crypto';
import { TEST_CONFIG } from './config';

export interface SendMessageOptions {
    text: string;
    from?: string;
    senderName?: string;
    phoneNumberId?: string;
}

/**
 * Construye y envía un payload al endpoint POST /webhook del servidor local.
 * Simula exactamente lo que haría Kapso al recibir un mensaje de WhatsApp.
 *
 * El servidor SIEMPRE responde 200 OK inmediatamente.
 * Para leer la respuesta del agente usar poll-response.ts.
 */
export async function sendWebhookMessage(options: SendMessageOptions): Promise<void> {
    const { text, from, senderName, phoneNumberId } = options;

    // Payload en el formato que acepta webhook.controller.ts.
    // El controller lee: body.data || body.payload || body — al no tener .data ni .payload
    // usa el body directamente, extrayendo phone_number_id, from, text.body, etc.
    const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId ?? TEST_CONFIG.PHONE_NUMBER_ID,
        from: from ?? TEST_CONFIG.TEST_USER_PHONE,
        senderName: senderName ?? TEST_CONFIG.TEST_USER_NAME,
        type: 'text',
        id: `test_msg_${randomUUID().substring(0, 8)}`,
        text: { body: text },
    };

    // Incluir el secret en el body (el controller acepta req.body.secret o header)
    if (TEST_CONFIG.WEBHOOK_SECRET) {
        payload.secret = TEST_CONFIG.WEBHOOK_SECRET;
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (TEST_CONFIG.WEBHOOK_SECRET) {
        headers['x-kapso-secret'] = TEST_CONFIG.WEBHOOK_SECRET;
    }

    const response = await axios.post(
        `${TEST_CONFIG.SERVER_URL}/webhook`,
        payload,
        { headers, timeout: 5_000 }
    );

    if (response.status !== 200) {
        throw new Error(`Webhook respondió ${response.status}: ${JSON.stringify(response.data)}`);
    }
}
