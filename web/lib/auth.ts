// =============================================================================
// Helpers de auth para Route Handlers
//
// El middleware (web/middleware.ts) verifica el JWT del cookie y propaga la
// identidad como headers de request:
//   - x-company-id: companyId del JWT
//   - x-user-role:  'admin' | 'staff'
//
// Como las route handlers se ejecutan DESPUÉS del middleware, podemos confiar
// en estos headers (no son seteables desde el cliente porque next/server
// reemplaza los headers de request entrantes — el cliente nunca los ve).
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';

export type PortalRole = 'admin' | 'staff';

export interface PortalIdentity {
    companyId: string;
    role:      PortalRole;
}

export function getIdentity(req: NextRequest): PortalIdentity | null {
    const companyId = req.headers.get('x-company-id');
    const roleHdr   = req.headers.get('x-user-role');
    if (!companyId) return null;
    const role: PortalRole = roleHdr === 'staff' ? 'staff' : 'admin';
    return { companyId, role };
}

/**
 * Garantiza que el llamador es admin de la empresa pasada por URL.
 * Devuelve { ok: true } o un NextResponse 401/403 listo para retornar.
 */
export function requireAdmin(req: NextRequest, urlCompanyId: string):
    | { ok: true; identity: PortalIdentity }
    | { ok: false; response: NextResponse }
{
    const identity = getIdentity(req);
    if (!identity) {
        return { ok: false, response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
    }
    if (identity.companyId !== urlCompanyId) {
        return { ok: false, response: NextResponse.json({ error: 'Empresa no coincide con la sesión' }, { status: 403 }) };
    }
    if (identity.role !== 'admin') {
        return { ok: false, response: NextResponse.json({ error: 'Acción restringida al admin de la clínica' }, { status: 403 }) };
    }
    return { ok: true, identity };
}
