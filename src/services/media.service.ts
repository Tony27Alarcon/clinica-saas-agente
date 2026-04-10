import axios from 'axios';
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { KapsoService } from './kapso.service';

export class MediaService {
    /**
     * Sube un buffer a un bucket de Supabase y retorna la URL pública
     * @param folder - Carpeta dentro del bucket (ej: el ID del contacto)
     */
    static async uploadToSupabase(buffer: Buffer, mimeType: string, extension: string, folder: string = 'general'): Promise<string | null> {
        try {
            // Organizar por carpeta para mantener el storage limpio
            const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).substring(7)}.${extension}`;
            
            const { data, error } = await supabase.storage
                .from('mensajes')
                .upload(fileName, buffer, {
                    contentType: mimeType,
                    cacheControl: '3600',
                    upsert: false
                });

            if (error) {
                logger.error(`Error subiendo a Supabase Storage: ${error.message}`);
                return null;
            }

            const { data: publicUrlData } = supabase.storage
                .from('mensajes')
                .getPublicUrl(data.path);

            return publicUrlData.publicUrl;
        } catch (error) {
            logger.error(`Excepción en uploadToSupabase: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Descarga un archivo multimedia desde Kapso (o cualquier URL), lo procesa y lo sube a Supabase.
     */
    static async procesarMedia(
        url: string, 
        folder: string = 'general', 
        kapsoToken?: string,
        mediaId?: string,
        phoneNumberId?: string
    ): Promise<{ buffer: Buffer, mimeType: string, publicUrl: string, kind: string } | null> {
        try {
            logger.info(`Descargando media desde: ${url}`);
            let buffer: Buffer;
            let mimeType: string;

            // 1. Si es una URL de Supabase local, usar el SDK para descargar (evita 400/401)
            if (url.includes('/storage/v1/object/public/mensajes/')) {
                const path = url.split('/storage/v1/object/public/mensajes/')[1];
                if (!path) throw new Error("URL de Supabase malformada");
                
                const { data, error } = await supabase.storage.from('mensajes').download(decodeURIComponent(path));
                if (error || !data) throw new Error(`Fallo descarga Supabase: ${error?.message}`);
                
                buffer = Buffer.from(await data.arrayBuffer());
                mimeType = data.type || 'application/octet-stream';
            } 
            // 2. Si es una URL de Meta/Kapso y tenemos mediaId, intentar vía KapsoService (evita 401)
            else if (mediaId && phoneNumberId && (url.includes('lookaside.fbsbx.com') || url.includes('fbcdn.net'))) {
                logger.info(`Usando KapsoService para descargar mediaId: ${mediaId}`);
                const kapsoBuffer = await KapsoService.downloadMedia(mediaId, phoneNumberId);
                if (!kapsoBuffer) throw new Error("Fallo descarga vía Kapso proxy");
                buffer = kapsoBuffer;
                mimeType = 'application/octet-stream'; // Se inferirá abajo
            }
            // 3. Fallback: descarga HTTP directa
            else {
                const headers: any = kapsoToken ? { 'Authorization': `Bearer ${kapsoToken}` } : {};
                const response = await axios.get(url, { 
                    responseType: 'arraybuffer',
                    headers
                });
                buffer = Buffer.from(response.data, 'binary');
                mimeType = response.headers['content-type'] || 'application/octet-stream';
            }
            
            // Determinar tipo y extensión si es desconocido o genérico
            let kind = 'document';
            let extension = 'bin';

            // Inferir mimeType desde magic bytes si es genérico
            if (mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream') {
                const hex = buffer.toString('hex', 0, 4);
                if (hex.startsWith('ffd8')) { mimeType = 'image/jpeg'; }
                else if (hex === '89504e47') { mimeType = 'image/png'; }
                else if (hex.startsWith('4f676753')) { mimeType = 'audio/ogg'; }
                else if (hex.startsWith('25504446')) { mimeType = 'application/pdf'; }
            }

            if (mimeType.startsWith('image/')) {
                kind = 'image';
                extension = mimeType.split('/')[1];
                
                // Opcional: Redimensionar imagen si es muy grande
                try {
                    if (buffer.length > 1.5 * 1024 * 1024) {
                        const sharp = require('sharp');
                        buffer = await sharp(buffer)
                            .resize({ width: 1024, withoutEnlargement: true })
                            .jpeg({ quality: 80 })
                            .toBuffer();
                        mimeType = 'image/jpeg';
                        extension = 'jpeg';
                        logger.info('Imagen redimensionada con éxito usando sharp.');
                    }
                } catch (sharpError) {
                    logger.warn('Sharp no está instalado o falló. Imagen se sube en tamaño original.');
                }
            } else if (mimeType.startsWith('audio/')) {
                kind = 'audio';
                extension = mimeType.replace('audio/', '').split(';')[0];
                if (mimeType.includes('ogg')) extension = 'ogg';
                if (mimeType.includes('mp4')) extension = 'm4a'; 
            } else if (mimeType.startsWith('video/')) {
                kind = 'video';
                extension = mimeType.split('/')[1];
            } else if (mimeType === 'application/pdf') {
                kind = 'document';
                extension = 'pdf';
            }

            // Subir a Supabase organizado por carpeta (solo si no viene de Supabase ya)
            let publicUrl = url;
            if (!url.includes('/storage/v1/object/public/mensajes/')) {
                const uploadedUrl = await this.uploadToSupabase(buffer, mimeType, extension, folder);
                if (!uploadedUrl) throw new Error("Fallo al subir a Supabase");
                publicUrl = uploadedUrl;
            }

            return { buffer, mimeType, publicUrl, kind };
        } catch (error) {
            logger.error(`Error procesando media de Kapso: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Descarga y procesa un archivo usando el media_id de WhatsApp (via proxy de Kapso).
     * Resuelve el error 401 al no usar la URL directa de Meta.
     *
     * @param mediaId       - ID del archivo (ej: event.message.image.id)
     * @param phoneNumberId - phoneNumberId del mensaje entrante
     * @param folder        - Carpeta destino en el bucket de Supabase
     */
    static async procesarMediaPorId(
        mediaId: string,
        phoneNumberId: string,
        folder: string = 'general'
    ): Promise<{ buffer: Buffer, mimeType: string, publicUrl: string, kind: string } | null> {
        try {
            logger.info(`[procesarMediaPorId] Descargando media_id: ${mediaId}`);

            // 1. Descargar buffer via proxy de Kapso (sin 401)
            const buffer = await KapsoService.downloadMedia(mediaId, phoneNumberId);
            if (!buffer) {
                logger.warn('[procesarMediaPorId] KapsoService no pudo descargar el buffer.');
                return null;
            }

            // 2. Obtener metadata del media para conocer el mime_type
            let mimeType = 'application/octet-stream';
            let kind = 'document';
            let extension = 'bin';

            // Inferir mimeType desde el buffer (magic bytes) si no lo tenemos
            // Por ahora chequeamos los primeros bytes conocidos
            const hex4 = buffer.toString('hex', 0, 4);
            if (hex4.startsWith('ffd8')) { mimeType = 'image/jpeg'; kind = 'image'; extension = 'jpg'; }
            else if (hex4 === '89504e47') { mimeType = 'image/png'; kind = 'image'; extension = 'png'; }
            else if (hex4.startsWith('4f676753')) { mimeType = 'audio/ogg'; kind = 'audio'; extension = 'ogg'; }
            else if (buffer.toString('ascii', 0, 3) === 'ID3' || hex4.startsWith('fffb')) { mimeType = 'audio/mpeg'; kind = 'audio'; extension = 'mp3'; }
            else if (hex4 === '25504446') { mimeType = 'application/pdf'; kind = 'document'; extension = 'pdf'; }

            // 3. Redimensionar imagen si es muy grande
            if (kind === 'image' && buffer.length > 1.5 * 1024 * 1024) {
                try {
                    const sharp = require('sharp');
                    const resized = await sharp(buffer)
                        .resize({ width: 1024, withoutEnlargement: true })
                        .jpeg({ quality: 80 })
                        .toBuffer();
                    const publicUrl = await this.uploadToSupabase(resized, 'image/jpeg', 'jpg', folder);
                    if (!publicUrl) throw new Error('Fallo al subir imagen redimensionada');
                    logger.info('[procesarMediaPorId] Imagen redimensionada y subida.');
                    return { buffer: resized, mimeType: 'image/jpeg', publicUrl, kind };
                } catch { /* fallback: subir original */ }
            }

            // 4. Subir a Supabase
            const publicUrl = await this.uploadToSupabase(buffer, mimeType, extension, folder);
            if (!publicUrl) throw new Error('Fallo al subir a Supabase');

            logger.info(`[procesarMediaPorId] Subido exitosamente: ${publicUrl}`);
            return { buffer, mimeType, publicUrl, kind };

        } catch (error) {
            logger.error(`Error en procesarMediaPorId: ${(error as Error).message}`);
            return null;
        }
    }
}
