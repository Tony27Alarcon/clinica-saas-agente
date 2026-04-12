import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

function getSupabase() {
    return createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_KEY!,
        { auth: { persistSession: false } }
    );
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;

    const { data, error } = await (getSupabase() as any)
        .schema('clinicas')
        .from('agents')
        .select('id, name, tone, system_prompt, qualification_criteria, escalation_rules, objections_kb')
        .eq('company_id', companyId)
        .eq('active', true)
        .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data)  return NextResponse.json({ error: 'Agente no encontrado' }, { status: 404 });

    return NextResponse.json(data);
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;
    const { name, tone, system_prompt, qualification_criteria, escalation_rules, objections_kb } = await req.json();

    const { data: updated, error } = await (getSupabase() as any)
        .schema('clinicas')
        .from('agents')
        .update({ name, tone, system_prompt, qualification_criteria, escalation_rules, objections_kb, updated_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .eq('active', true)
        .select('id');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!updated || updated.length === 0) {
        return NextResponse.json({ error: `No se encontró agente activo para company_id=${companyId}` }, { status: 404 });
    }

    // Rebuild prompt en el backend (best-effort, no bloquea la respuesta)
    const backendUrl  = process.env.BACKEND_INTERNAL_URL;
    const secret      = process.env.INTERNAL_API_SECRET;
    if (backendUrl && secret) {
        fetch(`${backendUrl}/internal/rebuild-prompt/${companyId}`, {
            method: 'POST',
            headers: { 'x-internal-secret': secret },
        }).catch(() => { /* silencioso — el backend lo cola si falla */ });
    }

    return NextResponse.json({ ok: true });
}
