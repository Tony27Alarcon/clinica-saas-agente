import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
        console.error('[agent-route] SUPABASE_URL o SUPABASE_SERVICE_KEY no están definidas');
        throw new Error('Configuración de Supabase incompleta');
    }
    return createClient(url, key, { auth: { persistSession: false } });
}

function triggerRebuild(companyId: string) {
    const backendUrl = process.env.BACKEND_INTERNAL_URL;
    const secret = process.env.INTERNAL_API_SECRET;
    if (backendUrl && secret) {
        fetch(`${backendUrl}/internal/rebuild-prompt/${companyId}`, {
            method: 'POST',
            headers: { 'x-internal-secret': secret },
        }).catch(() => {});
    }
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;

    try {
        const { data, error } = await (getSupabase() as any)
            .schema('clinicas')
            .from('agents')
            .select('id, name, tone, system_prompt, qualification_criteria, escalation_rules, objections_kb')
            .eq('company_id', companyId)
            .eq('active', true)
            .maybeSingle();

        if (error) {
            console.error('[agent-route] GET error:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
        if (!data) return NextResponse.json({ error: 'Agente no encontrado' }, { status: 404 });

        return NextResponse.json(data);
    } catch (err: any) {
        console.error('[agent-route] GET exception:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;

    try {
        const body = await req.json();
        const { name, tone, system_prompt, qualification_criteria, escalation_rules, objections_kb } = body;

        console.log('[agent-route] PATCH companyId:', companyId, '| fields:', Object.keys(body).join(', '));

        const { data: updated, error } = await (getSupabase() as any)
            .schema('clinicas')
            .from('agents')
            .update({ name, tone, system_prompt, qualification_criteria, escalation_rules, objections_kb, updated_at: new Date().toISOString() })
            .eq('company_id', companyId)
            .eq('active', true)
            .select('id');

        if (error) {
            console.error('[agent-route] PATCH supabase error:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        if (!updated || updated.length === 0) {
            console.warn('[agent-route] PATCH 0 rows updated for companyId:', companyId);
            return NextResponse.json({ error: `No se encontró agente activo para company_id=${companyId}` }, { status: 404 });
        }

        console.log('[agent-route] PATCH ok, updated:', updated.length, 'row(s)');
        triggerRebuild(companyId);

        return NextResponse.json({ ok: true });
    } catch (err: any) {
        console.error('[agent-route] PATCH exception:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
