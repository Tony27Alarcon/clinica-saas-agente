/**
 * Límites y MIME whitelist para multimedia entrante de WhatsApp.
 * Valores alineados con: límites de inline de Gemini (20 MB total request)
 * y con los formatos nativos que WhatsApp puede enviar/recibir.
 */

export const MAX_SIZES = {
    image: 5 * 1024 * 1024,       // 5 MB — redimensionamos por encima de 1.5 MB
    audio: 15 * 1024 * 1024,      // 15 MB — notas de voz de WhatsApp suelen ser <1 MB
    video: 16 * 1024 * 1024,      // 16 MB — límite de WhatsApp
    document: 20 * 1024 * 1024,   // 20 MB — límite inline de Gemini
    sticker: 512 * 1024,          // 512 KB
} as const;

export const ALLOWED_MIME: Record<string, readonly string[]> = {
    image: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
    audio: ['audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/flac', 'audio/m4a', 'audio/x-m4a'],
    video: ['video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm'],
    document: ['application/pdf'],
    sticker: ['image/webp'],
} as const;

export const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Umbral inline vs Files API para Gemini. Por debajo enviamos como buffer/base64;
 * por encima habría que subir a Files API (no implementado en este sprint).
 */
export const GEMINI_INLINE_MAX = 15 * 1024 * 1024;

export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export function isMimeAllowed(kind: MediaKind, mimeType: string): boolean {
    const clean = (mimeType || '').split(';')[0].trim().toLowerCase();
    return (ALLOWED_MIME[kind] || []).includes(clean);
}

export function isSizeAllowed(kind: MediaKind, bytes: number): boolean {
    return bytes > 0 && bytes <= MAX_SIZES[kind];
}
