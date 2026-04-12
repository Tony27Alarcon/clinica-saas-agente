import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { env } from '../config/env';
import { logger } from '../utils/logger';

type KapsoButton = { id: string; title: string };
type KapsoMediaReference = { id?: string; link?: string; caption?: string; filename?: string; voice?: boolean };
type KapsoInteractiveHeader = { type: 'text'; text: string };
type KapsoInteractiveListSection = {
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
};
type KapsoLocation = {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
};
type KapsoContact = {
    name: {
        formattedName?: string;
        formatted_name?: string;
        firstName?: string;
        first_name?: string;
        lastName?: string;
        last_name?: string;
        middleName?: string;
        middle_name?: string;
        suffix?: string;
        prefix?: string;
    };
    birthday?: string;
    addresses?: Array<Record<string, unknown>>;
    emails?: Array<Record<string, unknown>>;
    org?: Record<string, unknown>;
    phones?: Array<Record<string, unknown>>;
    urls?: Array<Record<string, unknown>>;
};

export class KapsoService {
    private static client: WhatsAppClient | null = null;
    private static clientCacheKey = '';

    /**
     * Normaliza un texto para formato WhatsApp según la guía técnica.
     */
    static normalizeWhatsAppText(input: string): string {
        if (!input) return input;
      
        let text = input
          .replace(/\r\n/g, '\n')
          .replace(/\u00A0/g, ' ')
          .trim();
      
        // Eliminar timestamps
        text = text.replace(/^\[(?:[01]?\d|2[0-3]):[0-5]\d\]\s*/gm, '');
        
        // Convertir markdown a formato WhatsApp
        text = text.replace(/```([a-zA-Z0-9_-]+)\n([\s\S]*?)```/g, 
          (_match, _language, code) => {
            const normalizedCode = String(code).trim();
            return normalizedCode ? `\`\`\`\n${normalizedCode}\n\`\`\`` : '``````';
          });
        
        // Headers a negrita
        text = text.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, 
          (_match, title) => `*${String(title).trim()}*`);
        
        // Formatos de markdown
        text = text.replace(/\*\*\s*([^*\n][\s\S]*?[^*\n])\s*\*\*/g, '*$1*');
        text = text.replace(/__\s*([^_\n][\s\S]*?[^_\n])\s*__/g, '_$1_');
        text = text.replace(/~~\s*([^~\n][\s\S]*?[^~\n])\s*~~/g, '~$1~');
        
        // Links a texto plano
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');
        
        // Listas a formato WhatsApp
        text = text.replace(/^\s*[•*]\s+/gm, '- ');
        
        // Limpiar espacios y saltos de línea múltiples
        text = text.replace(/\n{3,}/g, '\n\n');
        text = text.replace(/[ \t]{2,}/g, ' ');
      
        return text.trim();
    }

    /**
     * Envía un mensaje de vuelta al usuario a través de la API de Kapso.
     */
    static async enviarMensaje(telefono: string, mensaje: string, phoneNumberId: string, previewUrl?: boolean) {
        try {
            if (!this.isConfigured()) {
                logger.warn('Kapso API Config no está presente. Entorno simulado local.');
                logger.info(`[📤 KAPSO SIMULADO a ${telefono}]: ${mensaje}`);
                return true;
            }

            const client = this.getClient();
            const normalizedText = this.normalizeWhatsAppText(mensaje);
            logger.info(`Enviando mensaje texto a Kapso vía SDK...`);

            return await client.messages.sendText({
                phoneNumberId,
                to: telefono,
                body: normalizedText,
                previewUrl
            });
        } catch (error) {
            this.handleError(error, 'enviarMensaje');
            throw error;
        }
    }

    /**
     * Envía botones interactivos (Reply Buttons) vía Kapso.
     */
    static async enviarInteractivos(
        telefono: string,
        bodyText: string,
        botones: KapsoButton[],
        phoneNumberId: string,
        options?: { header?: KapsoInteractiveHeader; footerText?: string }
    ) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO BOTONES a ${telefono}]: ${bodyText} | Botones: ${JSON.stringify(botones)}`);
                return true;
            }

            const client = this.getClient();
            logger.info(`Enviando botones interactivos a Kapso vía SDK...`);

            return await client.messages.sendInteractiveButtons({
                phoneNumberId,
                to: telefono,
                bodyText,
                buttons: botones,
                header: options?.header,
                footerText: options?.footerText
            });
        } catch (error) {
            this.handleError(error, 'enviarInteractivos');
            throw error;
        }
    }

    /**
     * Envía un mensaje de audio vía Kapso.
     */
    static async enviarAudio(telefono: string, audio: string | KapsoMediaReference, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO AUDIO a ${telefono}]: ${JSON.stringify(audio)}`);
                return true;
            }

            const client = this.getClient();
            const audioPayload = typeof audio === 'string' ? { link: audio } : audio;
            logger.info(`Enviando audio a Kapso vía SDK...`);

            return await client.messages.sendAudio({
                phoneNumberId,
                to: telefono,
                audio: {
                    id: audioPayload.id,
                    link: audioPayload.link,
                    voice: audioPayload.voice
                }
            });
        } catch (error) {
            this.handleError(error, 'enviarAudio');
            throw error;
        }
    }

    static async enviarImagen(telefono: string, image: string | KapsoMediaReference, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO IMAGEN a ${telefono}]: ${JSON.stringify(image)}`);
                return true;
            }

            const client = this.getClient();
            const imagePayload = typeof image === 'string' ? { link: image } : image;

            return await client.messages.sendImage({
                phoneNumberId,
                to: telefono,
                image: {
                    id: imagePayload.id,
                    link: imagePayload.link,
                    caption: imagePayload.caption
                }
            });
        } catch (error) {
            this.handleError(error, 'enviarImagen');
            throw error;
        }
    }

    static async enviarVideo(telefono: string, video: string | KapsoMediaReference, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO VIDEO a ${telefono}]: ${JSON.stringify(video)}`);
                return true;
            }

            const client = this.getClient();
            const videoPayload = typeof video === 'string' ? { link: video } : video;

            return await client.messages.sendVideo({
                phoneNumberId,
                to: telefono,
                video: {
                    id: videoPayload.id,
                    link: videoPayload.link,
                    caption: videoPayload.caption
                }
            });
        } catch (error) {
            this.handleError(error, 'enviarVideo');
            throw error;
        }
    }

    static async enviarDocumento(telefono: string, document: string | KapsoMediaReference, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO DOCUMENTO a ${telefono}]: ${JSON.stringify(document)}`);
                return true;
            }

            const client = this.getClient();
            const documentPayload = typeof document === 'string' ? { link: document } : document;

            return await client.messages.sendDocument({
                phoneNumberId,
                to: telefono,
                document: {
                    id: documentPayload.id,
                    link: documentPayload.link,
                    caption: documentPayload.caption,
                    filename: documentPayload.filename
                }
            });
        } catch (error) {
            this.handleError(error, 'enviarDocumento');
            throw error;
        }
    }

    static async enviarSticker(telefono: string, sticker: { id?: string; link?: string }, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO STICKER a ${telefono}]: ${JSON.stringify(sticker)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendSticker({
                phoneNumberId,
                to: telefono,
                sticker
            });
        } catch (error) {
            this.handleError(error, 'enviarSticker');
            throw error;
        }
    }

    static async enviarUbicacion(telefono: string, location: KapsoLocation, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO UBICACIÓN a ${telefono}]: ${JSON.stringify(location)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendLocation({
                phoneNumberId,
                to: telefono,
                location
            });
        } catch (error) {
            this.handleError(error, 'enviarUbicacion');
            throw error;
        }
    }

    static async enviarContactos(telefono: string, contacts: KapsoContact[], phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO CONTACTOS a ${telefono}]: ${JSON.stringify(contacts)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendContacts({
                phoneNumberId,
                to: telefono,
                contacts: contacts.map(contact => this.normalizeContact(contact))
            });
        } catch (error) {
            this.handleError(error, 'enviarContactos');
            throw error;
        }
    }

    static async enviarReaccion(telefono: string, reaction: { messageId: string; emoji: string }, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO REACCIÓN a ${telefono}]: ${JSON.stringify(reaction)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendReaction({
                phoneNumberId,
                to: telefono,
                reaction
            });
        } catch (error) {
            this.handleError(error, 'enviarReaccion');
            throw error;
        }
    }

    static async enviarListaInteractiva(
        telefono: string,
        bodyText: string,
        buttonText: string,
        sections: KapsoInteractiveListSection[],
        phoneNumberId: string,
        options?: { header?: KapsoInteractiveHeader; footerText?: string }
    ) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO LISTA a ${telefono}]: ${bodyText} | ${JSON.stringify(sections)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendInteractiveList({
                phoneNumberId,
                to: telefono,
                bodyText,
                buttonText,
                sections,
                header: options?.header,
                footerText: options?.footerText
            });
        } catch (error) {
            this.handleError(error, 'enviarListaInteractiva');
            throw error;
        }
    }

    static async enviarFlowInteractivo(
        telefono: string,
        bodyText: string,
        parameters: {
            flowId: string;
            flowCta: string;
            flowAction?: 'navigate' | 'data_exchange';
            flowActionPayload?: Record<string, unknown>;
        },
        phoneNumberId: string
    ) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO FLOW a ${telefono}]: ${bodyText} | ${JSON.stringify(parameters)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendInteractiveFlow({
                phoneNumberId,
                to: telefono,
                bodyText,
                parameters
            });
        } catch (error) {
            this.handleError(error, 'enviarFlowInteractivo');
            throw error;
        }
    }

    static async enviarCtaUrlInteractivo(
        telefono: string,
        bodyText: string,
        parameters: { displayText: string; url: string },
        phoneNumberId: string
    ) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO CTA URL a ${telefono}]: ${bodyText} | ${JSON.stringify(parameters)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendInteractiveCtaUrl({
                phoneNumberId,
                to: telefono,
                bodyText,
                parameters
            });
        } catch (error) {
            this.handleError(error, 'enviarCtaUrlInteractivo');
            throw error;
        }
    }

    static async solicitarUbicacionInteractiva(
        telefono: string,
        bodyText: string,
        requestMessage: string,
        phoneNumberId: string
    ) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO LOCATION REQUEST a ${telefono}]: ${bodyText} | ${requestMessage}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendInteractiveLocationRequest({
                phoneNumberId,
                to: telefono,
                bodyText,
                parameters: {
                    requestMessage
                }
            });
        } catch (error) {
            this.handleError(error, 'solicitarUbicacionInteractiva');
            throw error;
        }
    }

    static async enviarCatalogoInteractivo(
        telefono: string,
        bodyText: string,
        parameters: { thumbnailProductRetailerId?: string },
        phoneNumberId: string
    ) {
        try {
            if (!this.isConfigured()) {
                logger.info(`[📤 KAPSO SIMULADO CATÁLOGO a ${telefono}]: ${bodyText} | ${JSON.stringify(parameters)}`);
                return true;
            }

            const client = this.getClient();
            return await client.messages.sendInteractiveCatalogMessage({
                phoneNumberId,
                to: telefono,
                bodyText,
                parameters
            });
        } catch (error) {
            this.handleError(error, 'enviarCatalogoInteractivo');
            throw error;
        }
    }

    /**
     * Marca un mensaje como leído (visto) y opcionalmente activa el indicador de "escribiendo".
     */
    static async marcarComoLeido(messageId: string, phoneNumberId: string) {
        try {
            if (!this.isConfigured()) return;

            const client = this.getClient();
            await client.messages.markRead({
                phoneNumberId,
                messageId,
                typingIndicator: {
                    type: 'text'
                }
            });
            logger.info(`Mensaje ${messageId} marcado como leído y activado 'escribiendo'.`);
        } catch (error) {
            const cause = (error as any)?.cause;
            const causeDetail = cause
                ? ` | causa: ${(cause as Error).message ?? cause} (${(cause as any).code ?? ''})`
                : '';
            logger.error(`Error en marcarComoLeido: ${(error as Error).message}${causeDetail}`);
        }
    }

    /**
     * Descarga el contenido binario de un media usando el SDK oficial de Kapso.
     * El SDK (a través del proxy de Kapso) maneja automáticamente los headers de
     * auth y el phoneNumberId requerido. Esto evita el error 401 de Meta.
     *
     * @param mediaId       - El ID del media (ej: event.message.image.id)
     * @param phoneNumberId - El phoneNumberId al que llegó el mensaje
     */
    static async downloadMedia(mediaId: string, phoneNumberId: string): Promise<Buffer | null> {
        try {
            if (!this.isConfigured()) {
                logger.warn('[downloadMedia] Kapso no configurado. No se puede descargar media.');
                return null;
            }

            const client = this.getClient();
            logger.info(`[downloadMedia] Descargando media_id: ${mediaId} via proxy de Kapso...`);

            const arrayBuffer = await client.media.download({
                mediaId,
                phoneNumberId,
            }) as ArrayBuffer;

            if (!arrayBuffer || arrayBuffer.byteLength < 1024) {
                logger.warn(`[downloadMedia] Buffer demasiado pequeño (${arrayBuffer?.byteLength} bytes). Posible error de auth o media expirada.`);
                return null;
            }

            logger.info(`[downloadMedia] Descarga exitosa: ${arrayBuffer.byteLength} bytes.`);
            return Buffer.from(arrayBuffer);
        } catch (error) {
            logger.error(`Error en KapsoService.downloadMedia: ${(error as Error).message}`);
            return null;
        }
    }

    // ─── Platform API (historial de conversaciones) ─────────────────────────────

    /**
     * Llama al endpoint `/platform/v1/...` de Kapso.
     * La URL base se toma de KAPSO_API_BASE_URL si está definida;
     * si no, se deriva de KAPSO_API_URL quitando el path de mensajes.
     */
    private static async platformRequest<T>(path: string): Promise<T> {
        const baseUrl = env.KAPSO_API_BASE_URL
            ? env.KAPSO_API_BASE_URL.trim().replace(/\/$/, '')
            : this.getBaseUrl();

        const url = `${baseUrl}/platform/v1${path}`;

        const response = await fetch(url, {
            headers: {
                'X-API-Key': env.KAPSO_API_TOKEN,
                'Content-Type': 'application/json',
            },
        });

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Kapso Platform API (${response.status}): ${text.substring(0, 200)}`);
        }
        return text ? JSON.parse(text) : ({} as T);
    }

    /**
     * Lista las conversaciones de Kapso para un número de contacto.
     * Retorna array vacío si Kapso no está configurado o hay error.
     */
    static async listarConversacionesKapso(phone: string, phoneNumberId: string): Promise<any[]> {
        if (!this.isConfigured()) return [];
        try {
            const params = new URLSearchParams({
                phone_number: phone,
                phone_number_id: phoneNumberId,
                per_page: '50',
            });
            const data = await this.platformRequest<{ data: any[] }>(
                `/whatsapp/conversations?${params}`
            );
            return data.data || [];
        } catch (error) {
            logger.error(`[KapsoService] listarConversacionesKapso: ${(error as Error).message}`);
            return [];
        }
    }

    /**
     * Lista todos los mensajes de una conversación de Kapso (hasta 200, con cursor pagination).
     * Retorna array vacío si Kapso no está configurado o hay error.
     */
    static async listarMensajesKapso(conversationId: string, phoneNumberId: string): Promise<any[]> {
        if (!this.isConfigured()) return [];

        const all: any[] = [];
        let after: string | undefined;
        const MAX_PAGES = 4; // 4 × 50 = 200 mensajes máx por conversación

        for (let page = 0; page < MAX_PAGES; page++) {
            try {
                const params = new URLSearchParams({
                    conversation_id: conversationId,
                    phone_number_id: phoneNumberId,
                    limit: '50',
                });
                if (after) params.set('after', after);

                const data = await this.platformRequest<{
                    data: any[];
                    paging?: { cursors?: { after?: string }; next?: string };
                }>(`/whatsapp/messages?${params}`);

                const messages = data.data || [];
                all.push(...messages);

                const nextCursor = data.paging?.cursors?.after;
                if (!nextCursor || !data.paging?.next) break;
                after = nextCursor;
            } catch (error) {
                logger.error(`[KapsoService] listarMensajesKapso página ${page}: ${(error as Error).message}`);
                break;
            }
        }

        return all;
    }

    // ────────────────────────────────────────────────────────────────────────────

    private static isConfigured(): boolean {
        return Boolean(env.KAPSO_API_URL && env.KAPSO_API_TOKEN);
    }

    private static getClient(): WhatsAppClient {
        const baseUrl = this.getBaseUrl();
        const graphVersion = this.getGraphVersion();
        const cacheKey = `${baseUrl}|${graphVersion}|${env.KAPSO_API_TOKEN}`;

        if (!this.client || this.clientCacheKey !== cacheKey) {
            logger.info(`[KapsoService] Inicializando cliente — baseUrl: ${baseUrl} | graphVersion: ${graphVersion}`);
            this.client = new WhatsAppClient({
                baseUrl,
                kapsoApiKey: env.KAPSO_API_TOKEN,
                graphVersion
            });
            this.clientCacheKey = cacheKey;
        }

        return this.client;
    }

    private static getBaseUrl(): string {
        const raw = env.KAPSO_API_URL.trim().replace(/\/$/, '');

        if (!raw.includes('/messages')) {
            return raw;
        }

        return raw.replace(/\/v\d+\.\d+\/[^/]+\/messages$/, '');
    }

    private static getGraphVersion(): string {
        const match = env.KAPSO_API_URL.match(/\/(v\d+\.\d+)\//);
        return match?.[1] || 'v24.0';
    }

    private static normalizeContact(contact: KapsoContact) {
        return {
            ...contact,
            name: {
                formattedName: contact.name.formattedName || contact.name.formatted_name || '',
                firstName: contact.name.firstName || contact.name.first_name,
                lastName: contact.name.lastName || contact.name.last_name,
                middleName: contact.name.middleName || contact.name.middle_name,
                suffix: contact.name.suffix,
                prefix: contact.name.prefix
            }
        };
    }

    private static handleError(error: any, context: string) {
        const detail = error instanceof Error
            ? error.message
            : typeof error === 'string'
                ? error
                : JSON.stringify(error);
        const cause = error?.cause;
        const causeDetail = cause
            ? ` | causa: ${(cause as Error).message ?? cause} (${(cause as any).code ?? ''})`
            : '';
        logger.error(`Error en KapsoService.${context}: ${detail}${causeDetail}`);
    }
}
