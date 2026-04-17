import { logger } from '../utils/logger';
import { MediaService } from './media.service';
import { GEMINI_INLINE_MAX, MAX_SIZES, isMimeAllowed, isSizeAllowed, type MediaKind } from '../config/media.constants';

export interface IncomingMedia {
    mediaId?: string;
    phoneNumberId?: string;
    url?: string;               // safeKapsoUrl o metaDirectUrl
    messageType: string;        // 'image' | 'audio' | 'voice' | 'video' | 'document' | 'sticker' | ...
    caption?: string;
}

/**
 * Part compatible con Vercel AI SDK v6 (messages[].content[]).
 * - image: `{ type: 'image', image: URL | Buffer }`
 * - file:  `{ type: 'file', data: URL | Buffer, mediaType }`
 */
export type GeminiPart =
    | { type: 'text'; text: string }
    | { type: 'image'; image: URL | Buffer }
    | { type: 'file'; data: URL | Buffer; mediaType: string };

function mapWhatsappTypeToKind(messageType: string, mimeType: string): MediaKind | null {
    if (messageType === 'image') return 'image';
    if (messageType === 'audio' || messageType === 'voice') return 'audio';
    if (messageType === 'video') return 'video';
    if (messageType === 'document') return 'document';
    if (messageType === 'sticker') return 'sticker';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'document';
    return null;
}

export class MediaPartsService {
    /**
     * Dado un evento de WhatsApp con media, descarga (o re-usa buffer), valida MIME/tamaño
     * y produce parts multimodales listos para pasarle a generateText.
     *
     * Retorna null si no hay media utilizable. Falla silenciosa: si la descarga o la
     * validación fracasa, se loggea y se retorna null para que el pipeline degrade a
     * solo-texto sin romperse.
     */
    static async buildFromIncoming(
        media: IncomingMedia,
        folder: string
    ): Promise<GeminiPart[] | null> {
        try {
            if (!media.mediaId && !media.url) return null;

            let processed: { buffer: Buffer; mimeType: string; publicUrl: string; kind: string } | null = null;

            if (media.mediaId && media.phoneNumberId) {
                processed = await MediaService.procesarMediaPorId(media.mediaId, media.phoneNumberId, folder);
            } else if (media.url) {
                processed = await MediaService.procesarMedia(media.url, folder);
            }

            if (!processed) {
                logger.warn('[MediaParts] MediaService no retornó buffer — degradando a solo texto.');
                return null;
            }

            const kind = mapWhatsappTypeToKind(media.messageType, processed.mimeType);
            if (!kind) {
                logger.warn(`[MediaParts] Tipo no soportado: msgType=${media.messageType} mime=${processed.mimeType}`);
                return null;
            }

            if (!isMimeAllowed(kind, processed.mimeType)) {
                logger.warn(`[MediaParts] MIME no permitido: ${processed.mimeType} (kind=${kind})`);
                return null;
            }

            if (!isSizeAllowed(kind, processed.buffer.length)) {
                logger.warn(`[MediaParts] Archivo excede límite (kind=${kind}, bytes=${processed.buffer.length}, max=${MAX_SIZES[kind]})`);
                return null;
            }

            const parts: GeminiPart[] = [];

            // Caption o texto del mensaje: primero texto, luego media (Google recomienda texto ANTES o DESPUÉS; aquí lo ponemos antes como instrucción)
            if (media.caption?.trim()) {
                parts.push({ type: 'text', text: media.caption.trim() });
            }

            // Decidir payload: URL pública si Supabase ya la sirve, buffer inline como fallback.
            const useUrl = processed.publicUrl && processed.publicUrl.startsWith('http');
            const payload: URL | Buffer = useUrl
                ? new URL(processed.publicUrl)
                : processed.buffer;

            // Si pasaríamos inline >15 MB, degradar: preferimos no romper la request.
            if (!useUrl && processed.buffer.length > GEMINI_INLINE_MAX) {
                logger.warn(`[MediaParts] Buffer inline ${processed.buffer.length} bytes excede ${GEMINI_INLINE_MAX}. Se omite media.`);
                return parts.length > 0 ? parts : null;
            }

            if (kind === 'image' || kind === 'sticker') {
                parts.push({ type: 'image', image: payload });
            } else {
                parts.push({ type: 'file', data: payload, mediaType: processed.mimeType });
            }

            // Prompt auxiliar para forzar lectura/transcripción según modalidad
            if (kind === 'audio') {
                parts.push({ type: 'text', text: 'Transcribe el audio en español y actúa sobre su contenido.' });
            } else if (kind === 'document') {
                parts.push({ type: 'text', text: 'Lee el documento adjunto y responde según su contenido.' });
            } else if (kind === 'video') {
                parts.push({ type: 'text', text: 'Describe el video y responde según su contenido.' });
            }

            logger.info(`[MediaParts] Parts generados kind=${kind} bytes=${processed.buffer.length} mode=${useUrl ? 'url' : 'inline'}`);
            return parts;
        } catch (error) {
            logger.error(`[MediaParts] Error construyendo parts: ${(error as Error).message}`);
            return null;
        }
    }
}
