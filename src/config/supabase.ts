import { createClient } from '@supabase/supabase-js';
import { env } from './env';
import { logger } from '../utils/logger';

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    logger.warn('Supabase URL o Service Key no están configurados. La DB no funcionará correctamente.');
}

export const supabase = createClient(
    env.SUPABASE_URL || 'http://localhost',
    env.SUPABASE_SERVICE_KEY || 'dummy_key',
    { auth: { persistSession: false } }
);
