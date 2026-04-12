import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function main() {
    const { data: companies, error: e1 } = await (sb as any).schema('clinicas').from('companies').select('id, name, timezone').limit(5);
    console.log('=== COMPANIES ===');
    console.log(e1 ? `Error: ${e1.message}` : JSON.stringify(companies, null, 2));

    const { data: staff, error: e2 } = await (sb as any).schema('clinicas').from('staff').select('id, name, company_id, gcal_email').limit(5);
    console.log('=== STAFF ===');
    console.log(e2 ? `Error: ${e2.message}` : JSON.stringify(staff, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
