// GET /api/admin/[companyId]/me → { companyId, role }
// La UI lo usa para mostrar/ocultar acciones según el rol.

import { NextRequest, NextResponse } from 'next/server';
import { getIdentity } from '@/lib/auth';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;
    const id = getIdentity(req);
    if (!id || id.companyId !== companyId) {
        return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
    }
    const res = NextResponse.json({ companyId: id.companyId, role: id.role });
    res.headers.set('Cache-Control', 'no-store');
    return res;
}
