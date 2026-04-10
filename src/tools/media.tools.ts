import { tool } from 'ai';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

export const createListMediaTool = (contactoId: number) => tool({
    description: 'Lista los archivos multimedia y documentos del contacto. Útil si el usuario dice "mandame el pdf" o "enviame la foto".',
    inputSchema: z.object({
        limit: z.number().min(1).max(20).optional().describe('Cantidad máxima de archivos a traer, default 5'),
        kind: z.enum(['image', 'audio', 'document', 'video', 'sticker']).optional().describe('Tipo de archivo a buscar')
    }),
    execute: async (args) => {
        try {
            let query = supabase
                .from('media_assets')
                .select('kind, rol, descripcion_ia, created_at, url_publica')
                .eq('contacto_id', contactoId)
                .order('created_at', { ascending: false })
                .limit(args.limit || 5);

            if (args.kind) {
                query = query.eq('kind', args.kind);
            }

            const { data, error } = await query;

            if (error) throw error;
            return { ok: true, count: data?.length || 0, assets: data };
        } catch (err: any) {
            logger.error(`Error en listMediaTool: ${err.message}`);
            return { ok: false, error: err.message };
        }
    }
});
